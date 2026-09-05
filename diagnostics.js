/* coach: lifting diagnostics — one coaching cue -> one number, computed from
 * the pose track the frontend already has.
 *
 * Served verbatim at /diagnostics.js (app.py re-reads this file per request, so
 * editing it needs only a browser reload, not ./restart.sh).
 *
 * Every diagnostic is written in the same three parts, and the object below
 * has exactly that shape:
 *
 *   1. description   — the cue, and the scalar standing in for it
 *   2. phase()       — the window of the lift where the cue applies, from
 *                      triggers computable from keypoints. Scoring a cue
 *                      outside its phase is noise: the back angle is *supposed*
 *                      to change once the bar passes the knee.
 *   3. measure() + the shared renderer — the plot the lifter reads, plus
 *                      everything they need to distrust it.
 *
 * See .claude/skills/lifting-diagnostic/ for the full contract and for the
 * per-diagnostic notes.
 *
 * Keypoints are [y, x, confidence] with y growing DOWNWARD — elevation is -y,
 * and "A is above B" is A.y < B.y. Everything here is pixels in the image
 * plane; there is no metric scale, so every distance/speed threshold is
 * normalized by torso length.
 *
 * Every diagnostic gets its own plot, stat tiles and notes block, always —
 * the tickbox above each plot gates only whether that diagnostic's overlay()
 * draws on the video (so several diagnostics' overlays don't compete for the
 * same frame). Rendering is shared: DIAGNOSTICS is iterated to build one
 * section per entry (see buildSections/run/redrawAll below).
 */
(function () {
'use strict';

// COCO-17, as produced by vitpose_backend. Odd = left, even = right.
const KP = {
  lSho: 5, rSho: 6, lElb: 7, rElb: 8, lWri: 9, rWri: 10,
  lHip: 11, rHip: 12, lKnee: 13, rKnee: 14, lAnk: 15, rAnk: 16,
};
const USED = [KP.lSho, KP.rSho, KP.lElb, KP.rElb, KP.lWri, KP.rWri,
              KP.lHip, KP.rHip, KP.lKnee, KP.rKnee, KP.lAnk, KP.rAnk];

const DIAG_CONF = 0.3;   // same gate the overlay uses
const FILL_WIN = 5;      // how far a gap fill may reach for neighbours

// Validated dark palette (see the dataviz skill's references/palette.md).
// One series per plot, so no legend box — the band is uncertainty, not a
// second series.
const C = {
  series: '#3987e5',
  band: 'rgba(57,135,229,0.20)',
  ref: '#d95926',
  good: '#0ca30c', warning: '#fab219', critical: '#d03b3b',
  ink: '#ffffff', ink2: '#c3c2b7', muted: '#898781',
  grid: '#2c2c2a', axis: '#383835', surface: '#1a1a19',
  phase: 'rgba(255,255,255,0.045)',
};

const fmt = (v, d) => (v == null || !isFinite(v)) ? '—' : v.toFixed(d == null ? 1 : d);


// --- track preparation --------------------------------------------------

// One entry per sampled frame in which this person was detected, in order.
function buildTrack(kpByFrame, meta, personId) {
  const frames = (meta.frame_indices && meta.frame_indices.length)
    ? meta.frame_indices
    : Object.keys(kpByFrame).map(Number).sort((a, b) => a - b);
  const samples = [];
  frames.forEach((f, slot) => {
    const perFrame = kpByFrame[String(f)];
    const kp = perFrame && perFrame[personId];
    if (!kp) return;
    // Decoder timestamps are the authority when present — deriving time from
    // fps desyncs on variable-frame-rate capture (see slotForTime in app.py).
    const t = (meta.frame_times_ms && meta.frame_times_ms[slot] != null)
      ? meta.frame_times_ms[slot] / 1000
      : f / (meta.fps || 30);
    samples.push({ frame: f, t, kp });
  });
  return samples;
}

// Drop sub-threshold keypoints, then fill the holes that leaves.
//
// Deliberately NOT a second smoothing pass. The trajectories arriving here have
// already been smoothed in time by the frontend's "time smoothing" control
// (app.py: smoothKeypoints), and averaging each present point with its
// neighbours again here would quietly mute that control: a fixed 5-frame mean
// removes most of the per-frame jitter on its own, so the plot barely moved
// between σ=off and σ=300ms and the number the lifter reads was mostly set by a
// constant they can't see. A point that survived the confidence gate is now
// taken at the value the slider produced for it.
//
// The fill is still needed: a keypoint that dips below confidence for a frame or
// two would otherwise punch a hole in the middle of the phase. Filled points are
// flagged .interp so the transparency block can count them — they are not
// measurements.
function preparePoints(samples) {
  for (const s of samples) {
    s.raw = {};
    for (const i of USED) {
      const q = s.kp[i];
      s.raw[i] = (q && q[2] >= DIAG_CONF) ? { x: q[1], y: q[0], c: q[2] } : null;
    }
  }
  const half = (FILL_WIN - 1) >> 1;
  for (let k = 0; k < samples.length; k++) {
    const p = {};
    for (const i of USED) {
      const here = samples[k].raw[i];
      if (here) { p[i] = { x: here.x, y: here.y, interp: false }; continue; }
      let sx = 0, sy = 0, n = 0;
      const lo = Math.max(0, k - half), hi = Math.min(samples.length - 1, k + half);
      for (let j = lo; j <= hi; j++) {
        const q = samples[j].raw[i];
        if (!q) continue;
        sx += q.x; sy += q.y; n++;
      }
      p[i] = n ? { x: sx / n, y: sy / n, interp: true } : null;
    }
    samples[k].p = p;
  }
}

// Median hip->shoulder length. The body scale every px threshold is divided by,
// so a threshold survives the lifter standing closer to the camera.
function torsoScale(samples) {
  const d = [];
  for (const s of samples) {
    const v = [];
    for (const [h, sh] of [[KP.lHip, KP.lSho], [KP.rHip, KP.rSho]]) {
      const a = s.p[h], b = s.p[sh];
      if (a && b) v.push(Math.hypot(a.x - b.x, a.y - b.y));
    }
    if (v.length) d.push(v.reduce((x, y) => x + y, 0) / v.length);
  }
  if (!d.length) return null;
  d.sort((a, b) => a - b);
  return d[d.length >> 1] || null;
}


// --- geometry -----------------------------------------------------------

// ViTPose has no bar keypoint. The hand wraps the bar, so the bar centre sits
// below the wrist joint centre by roughly a sixth of the forearm length; taken
// as a vertical offset in elevation. Averaged over whichever sides are visible.
function barPoint(p) {
  const est = [];
  let noForearm = false;
  for (const [w, e] of [[KP.lWri, KP.lElb], [KP.rWri, KP.rElb]]) {
    const pw = p[w];
    if (!pw) continue;
    const pe = p[e];
    if (pe) est.push({ x: pw.x, y: pw.y + Math.hypot(pw.x - pe.x, pw.y - pe.y) / 6 });
    else { est.push({ x: pw.x, y: pw.y }); noForearm = true; }
  }
  if (!est.length) return null;
  return {
    x: est.reduce((a, b) => a + b.x, 0) / est.length,
    y: est.reduce((a, b) => a + b.y, 0) / est.length,
    sides: est.length,
    noForearm,
  };
}

function meanOf(p, idxs, key) {
  const v = [];
  for (const i of idxs) if (p[i]) v.push(p[i][key]);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function kneeY(p) { return meanOf(p, [KP.lKnee, KP.rKnee], 'y'); }

function wristCentroid(p) {
  const x = meanOf(p, [KP.lWri, KP.rWri], 'x');
  const y = meanOf(p, [KP.lWri, KP.rWri], 'y');
  return (x == null || y == null) ? null : { x, y };
}

// Angle of the hip->shoulder segment to the floor, in the image plane.
// 0deg = horizontal trunk, 90deg = vertical. |dx| makes it independent of which
// way the lifter faces, so left- and right-facing videos score alike.
function trunkAngle(hip, sho) {
  if (!hip || !sho) return null;
  return Math.atan2(hip.y - sho.y, Math.abs(sho.x - hip.x)) * 180 / Math.PI;
}

// Interior angle at `joint` between rays to `a` and `b`, in degrees. 180deg
// means joint/a/b are collinear — a straight line through the joint, i.e. that
// joint is fully extended — regardless of how the segments are oriented in the
// image plane. Unlike trunkAngle this needs no reference axis, so it is the
// right measure for a joint angle (hip, knee) rather than a segment's tilt.
function jointAngle(joint, a, b) {
  if (!joint || !a || !b) return null;
  const v1x = a.x - joint.x, v1y = a.y - joint.y;
  const v2x = b.x - joint.x, v2y = b.y - joint.y;
  const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
  if (!m1 || !m2) return null;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
  return Math.acos(cos) * 180 / Math.PI;
}

// Wrist-centroid speed in torso-lengths per second.
//
// Deliberately measured on an extra-smoothed centroid over a wider baseline
// than one frame: a few px of per-frame pose jitter divided by a 1/30s step
// reads as ~0.5 torso-lengths/s — several times the onset threshold — so a
// one-frame difference finds "motion" in a lifter standing perfectly still.
// Over ±2 samples of a 9-wide mean, that same jitter lands around 0.07 while
// an actual pull runs ~2, which is the margin the trigger needs.
const SPEED_SMOOTH = 9, SPEED_HALF = 2;

// A 9-wide centred mean of a scalar-per-sample signal, tolerant of holes. Same
// smoothing window as wristSpeed's centroid, reused here for a position signal
// (hip elevation) rather than a derived speed, so a peak found on it has the
// same jitter immunity as the speed trigger does.
function smoothSeries(raw) {
  const half = (SPEED_SMOOTH - 1) >> 1;
  return raw.map((_, k) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, k - half); j <= Math.min(raw.length - 1, k + half); j++) {
      if (raw[j] == null) continue;
      sum += raw[j]; n++;
    }
    return n ? sum / n : null;
  });
}

function hipElevation(p) { return meanOf(p, [KP.lHip, KP.rHip], 'y'); }

function wristSpeed(samples, scale) {
  const raw = samples.map(s => wristCentroid(s.p));
  const half = (SPEED_SMOOTH - 1) >> 1;
  const c = raw.map((_, k) => {
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, k - half); j <= Math.min(raw.length - 1, k + half); j++) {
      if (!raw[j]) continue;
      sx += raw[j].x; sy += raw[j].y; n++;
    }
    return n ? { x: sx / n, y: sy / n } : null;
  });
  const out = new Array(samples.length).fill(null);
  for (let i = SPEED_HALF; i < samples.length - SPEED_HALF; i++) {
    const a = c[i - SPEED_HALF], b = c[i + SPEED_HALF];
    const dt = samples[i + SPEED_HALF].t - samples[i - SPEED_HALF].t;
    if (!a || !b || !(dt > 0)) continue;
    out[i] = Math.hypot(b.x - a.x, b.y - a.y) / dt / scale;
  }
  return out;
}

const RUN = 3;   // samples a threshold (or its release) must hold for

// The bar (wrist + 1/6 forearm) crossing from below knee height to above it,
// confirmed by persistence. This single event is both the end of the first
// pull and the start of the second by definition, so both diagnostics anchor
// on the same computation rather than each re-deriving it.
function barKneeCrossing(samples) {
  const bar = samples.map(s => barPoint(s.p));
  const knee = samples.map(s => kneeY(s.p));
  const above = i => bar[i] && knee[i] != null && bar[i].y < knee[i];
  const below = i => bar[i] && knee[i] != null && bar[i].y > knee[i];

  // Start scanning from where the bar is actually below the knee, so a clip
  // that opens with the bar already overhead doesn't "end" at sample 0.
  let first = -1;
  for (let i = 0; i < samples.length; i++) if (below(i)) { first = i; break; }
  if (first < 0) return { bar, knee, idx: -1, reason: 'no-below' };

  for (let i = first + 1; i < samples.length; i++) {
    if (!above(i)) continue;
    let holds = true;   // require persistence: one stray frame is not a crossing
    for (let j = i; j < Math.min(i + RUN, samples.length); j++) if (!above(j)) { holds = false; break; }
    if (holds) return { bar, knee, idx: i, reason: null };
  }
  return { bar, knee, idx: -1, reason: 'no-cross' };
}


// --- diagnostic 1: first pull, constant back angle ----------------------

const MOVE_ONSET = 0.15;   // torso-lengths/s — provisional
const SD_GOOD = 2.5, SD_WARN = 5.0;   // degrees — provisional, see the note

const firstPullBackAngle = {
  id: 'first-pull-back-angle',
  title: 'First pull — constant back angle',
  phaseLabel: 'first pull',
  cue: 'Through the first pull the back angle to the floor stays constant: the knees open and the bar rises, but the trunk keeps its inclination.',
  unit: '°',

  // Active phase: floor to bar-past-knee.
  //
  // Anchored on the END trigger, which is a crisp geometric crossing, then
  // searched backwards for the start, which is a soft threshold on noisy
  // velocity. Searching forwards from frame 0 for "the hands start moving"
  // finds the setup instead — grip adjustments, the hook re-set, the lifter
  // rocking into position all clear a motion threshold before the pull starts.
  phase(samples, scale) {
    const notes = [];
    const cross = barKneeCrossing(samples);
    if (cross.idx < 0) {
      return { error: cross.reason === 'no-below'
        ? 'The bar never sits below knee height in this clip — there is no first pull to score.'
        : 'The bar never crosses knee height — the first pull has no end trigger in this clip.' };
    }
    const endIdx = cross.idx, bar = cross.bar, knee = cross.knee;

    const speed = wristSpeed(samples, scale);
    let startIdx = -1;
    for (let i = endIdx - 1; i >= RUN - 1; i--) {
      let quiet = true;
      for (let j = 0; j < RUN; j++) {
        const v = speed[i - j];
        if (v == null || v >= MOVE_ONSET) { quiet = false; break; }
      }
      if (quiet) { startIdx = i; break; }
    }
    if (startIdx < 0) {
      startIdx = 0;
      notes.push('No still period was found before the bar reached the knee — the clip probably starts mid-pull. The phase start is clamped to the first frame, so the beginning of the first pull may be missing.');
    }
    if (endIdx - startIdx < RUN) {
      return { error: `The first pull resolved to only ${endIdx - startIdx + 1} sampled frame(s) — too short to score. Try a lower frame stride.` };
    }

    let onsetSpeed = null;
    for (let i = startIdx + 1; i <= endIdx; i++) {
      if (speed[i] != null && speed[i] >= MOVE_ONSET) { onsetSpeed = speed[i]; break; }
    }

    const gapPx = knee[endIdx] - bar[endIdx].y;
    return {
      startIdx, endIdx, notes,
      triggers: {
        onsetSpeed,
        clamped: startIdx === 0 && notes.length > 0,
        crossGapPx: gapPx,
        crossGapTorso: gapPx / scale,
      },
      bar, knee,
    };
  },

  // Two independent estimates from disjoint keypoints: left hip->shoulder and
  // right hip->shoulder. Their mean is the reported angle; their absolute
  // difference is the uncertainty band.
  measure(samples, phase) {
    const notes = [];
    const series = [];
    let both = 0, interp = 0, noForearm = 0;

    for (let i = phase.startIdx; i <= phase.endIdx; i++) {
      const p = samples[i].p;
      const aL = trunkAngle(p[KP.lHip], p[KP.lSho]);
      const aR = trunkAngle(p[KP.rHip], p[KP.rSho]);
      const vals = [aL, aR].filter(v => v != null);
      if (!vals.length) continue;
      if (vals.length === 2) both++;
      if ([KP.lHip, KP.lSho, KP.rHip, KP.rSho].some(k => p[k] && p[k].interp)) interp++;
      if (phase.bar[i] && phase.bar[i].noForearm) noForearm++;
      series.push({
        idx: i,
        frame: samples[i].frame,
        t: samples[i].t,
        value: vals.reduce((a, b) => a + b, 0) / vals.length,
        lo: Math.min.apply(null, vals),
        hi: Math.max.apply(null, vals),
        spread: vals.length === 2 ? Math.abs(aL - aR) : null,
      });
    }
    if (series.length < RUN) {
      return { error: 'Neither hip–shoulder pair stayed above the confidence threshold for long enough inside the first pull.' };
    }

    const vals = series.map(s => s.value);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / vals.length);
    const spreads = series.map(s => s.spread).filter(v => v != null);
    const summary = {
      mean, sd,
      range: Math.max.apply(null, vals) - Math.min.apply(null, vals),
      drift: vals[vals.length - 1] - vals[0],
      meanSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
      n: series.length,
      bothSides: both / series.length,
      interpFrac: interp / series.length,
      duration: series[series.length - 1].t - series[0].t,
    };

    if (mean > 75) {
      notes.push('The trunk reads near-vertical for the whole pull, which usually means the clip is filmed front-on rather than side-on. The angle saturates near 90° in that view and this score is not meaningful.');
    }
    if (summary.meanSpread != null && summary.meanSpread > 8) {
      notes.push('The two sides disagree by ' + fmt(summary.meanSpread) + '° on average. A steady offset means the camera is not square to the lifter (or the lifter is twisted on the bar) — real signal, not error. A jittery one means the pose track is unreliable; check the band on the plot.');
    }
    if (noForearm > series.length * 0.25) {
      notes.push('An elbow dropped below confidence on ' + Math.round(100 * noForearm / series.length) + '% of frames, so the bar estimate fell back to the bare wrist there — the phase end may be a frame or two early.');
    }
    return { series, summary, notes };
  },

  verdict(summary) {
    if (summary.sd <= SD_GOOD) return { label: 'holds well', status: 'good' };
    if (summary.sd <= SD_WARN) return { label: 'some rise', status: 'warning' };
    return { label: 'chest rises early', status: 'critical' };
  },

  // Dashed reference line: the phase's own mean, since the cue is about
  // constancy relative to the lift itself, not a fixed external target.
  referenceLine(summary) {
    return { value: summary.mean, label: 'mean ' + fmt(summary.mean) + '°' };
  },

  tiles(summary, verdict) {
    return [
      { label: 'Back-angle constancy', value: fmt(summary.sd) + '°',
        sub: verdict.label + ' · SD over the pull', status: verdict.status },
      { label: 'Drift', value: (summary.drift >= 0 ? '+' : '') + fmt(summary.drift) + '°', sub: 'end minus start' },
      { label: 'Mean angle', value: fmt(summary.mean) + '°', sub: 'to the floor' },
      { label: 'L/R disagreement', value: summary.meanSpread == null ? '—' : '±' + fmt(summary.meanSpread) + '°', sub: 'uncertainty' },
    ];
  },

  transparencyLines(res, samples, ctxExtra) {
    const s = res.summary, ph = res.phase, tr = ph.triggers;
    const pct = v => Math.round(v * 100) + '%';
    return [
      '<strong>Phase</strong> — frames ' + samples[ph.startIdx].frame + '–' +
        samples[ph.endIdx].frame + ', ' + fmt(s.duration, 2) + 's, ' + s.n + ' sampled frames measured.',
      '<strong>Start trigger</strong> — last stillness before the pull' +
        (tr.clamped ? ' (not found; clamped to the first frame)'
                    : ', wrist speed then rising past ' + fmt(MOVE_ONSET, 2) + ' torso-lengths/s (measured ' + fmt(tr.onsetSpeed, 2) + ').'),
      '<strong>End trigger</strong> — estimated bar (wrist + 1/6 forearm) crossed knee height, clearing it by ' +
        fmt(tr.crossGapPx, 0) + 'px (' + fmt(tr.crossGapTorso, 2) + ' torso-lengths).',
      '<strong>Measurement</strong> — left and right hip→shoulder scored separately; ' +
        pct(s.bothSides) + ' of frames had both sides visible, ' + pct(s.interpFrac) +
        ' relied on a detection filled in from neighbouring frames.',
      '<strong>Time smoothing</strong> — ' + (ctxExtra.smoothingMs
        ? 'trajectories were smoothed with a Gaussian of σ = ' + ctxExtra.smoothingMs +
          ' ms before scoring (the slider under the video). Widening it lowers the SD ' +
          'above whether or not the back angle actually held, so compare lifts at one setting.'
        : 'off — scored on raw per-frame detections, so pose jitter is counted as ' +
          'back-angle movement and the SD reads high.'),
      '<strong>Caveat</strong> — angles are in the image plane, so this assumes a side-on camera. The good/warning bands (' +
        fmt(SD_GOOD, 1) + '° / ' + fmt(SD_WARN, 1) + '° SD) are provisional and not fitted to labelled lifts.',
    ].concat(res.notes.map(n => '<strong>Note</strong> — ' + n));
  },

  // Everything the two triggers and the measurement rest on, drawn on the frame
  // itself while the playhead is inside the phase.
  overlay(ctx, sample, phase, res, size) {
    const p = sample.p;
    const bar = phase.bar[sample.i], knee = phase.knee[sample.i];
    const lw = Math.max(2, size / 260);

    for (const [h, s] of [[KP.lHip, KP.lSho], [KP.rHip, KP.rSho]]) {
      const a = p[h], b = p[s];
      if (!a || !b) continue;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = lw * 3.2;   // ring for legibility
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.strokeStyle = C.series; ctx.lineWidth = lw * 1.8;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // Phase-end trigger, as short ticks lying along the bar rather than a rule
    // across the frame and a ring around the hand: what the trigger compares is
    // two heights a hand's width apart, so drawing it at that scale keeps the
    // eye on the lifter. Solid is the bar estimate the trigger actually uses
    // (wrist dropped by a sixth of the forearm); dashed is the bare wrist it was
    // corrected from, so the size of that correction is visible rather than
    // taken on trust.
    const wrist = wristCentroid(p);
    const cx = bar ? bar.x : (wrist ? wrist.x : null);
    if (cx != null) {
      const half = Math.max(9, size / 22);
      const thin = Math.max(1, lw * 0.6);
      ctx.save();
      ctx.strokeStyle = C.ref; ctx.fillStyle = C.ref; ctx.lineWidth = thin;
      ctx.font = Math.max(9, size / 62) + 'px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';

      const tick = (y, len, dash, text, alpha) => {
        ctx.globalAlpha = alpha;
        ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(cx - len, y); ctx.lineTo(cx + len, y); ctx.stroke();
        ctx.fillText(text, cx + len + 4, y);
      };

      if (knee != null) tick(knee, half, [], 'knee', 0.85);
      // Skip the uncorrected tick when it would land under the corrected one —
      // on a frame where the elbow was missing they are the same estimate.
      if (wrist && bar && Math.abs(wrist.y - bar.y) > thin * 2) {
        tick(wrist.y, half * 0.6, [thin * 3, thin * 3], 'wrist', 0.55);
      }
      if (bar) tick(bar.y, half, [], 'bar', 1);
      ctx.restore();
    }
  },
};


// --- diagnostic 2: second pull, full triple extension --------------------

// Fraction of a torso-length the smoothed hip elevation must give back from its
// running minimum, and hold given back for RUN samples, before that minimum
// counts as the peak. Same "require persistence" idea as the first pull's
// motion trigger, applied to confirming a peak instead of a threshold crossing
// — a still-rising hip that dips one noisy sample must not end the phase.
const EXT_CONFIRM_RISE = 0.08;
const EXT_GOOD = 10, EXT_WARN = 20;   // degrees short of full extension — provisional

const secondPullTripleExtension = {
  id: 'second-pull-triple-extension',
  title: 'Second pull — full triple extension',
  phaseLabel: 'second pull',
  cue: 'At the top of the second pull the hips and knees open fully — "triple extension" — before the arms bend into the turnover.',
  unit: '°',

  // Active phase: bar-past-knee (the first pull's own end trigger) to peak hip
  // elevation.
  //
  // Anchored on the same bar/knee crossing diagnostic 1 ends on — it is the
  // same event by definition, so both diagnostics compute it once via
  // barKneeCrossing rather than risking two triggers drifting apart. The end
  // trigger here is softer: hip elevation is a smoothed extremum, not a crisp
  // crossing, so it needs the persistence check described above rather than a
  // single "is this the max so far" test, which would fire on the first noisy
  // sample that happens to jitter upward.
  phase(samples, scale) {
    const notes = [];
    const cross = barKneeCrossing(samples);
    if (cross.idx < 0) {
      return { error: 'The bar never crosses knee height — there is no second pull to score without the first pull\'s end trigger.' };
    }
    const startIdx = cross.idx;
    const elev = smoothSeries(samples.map(s => hipElevation(s.p)));   // smaller y = higher hip

    let bestIdx = -1, bestY = Infinity, endIdx = -1;
    for (let i = startIdx; i < samples.length; i++) {
      if (elev[i] == null) continue;
      if (elev[i] < bestY) { bestY = elev[i]; bestIdx = i; continue; }
      if (bestIdx < 0 || elev[i] - bestY <= EXT_CONFIRM_RISE * scale) continue;
      let holds = true;
      for (let j = i; j < Math.min(i + RUN, samples.length); j++) {
        if (elev[j] == null || elev[j] - bestY <= EXT_CONFIRM_RISE * scale) { holds = false; break; }
      }
      if (holds) { endIdx = bestIdx; break; }
    }
    if (endIdx < 0) {
      if (bestIdx < 0) {
        return { error: 'The hips were never confidently tracked after the bar passed the knee — there is no second pull to score.' };
      }
      // The clip may simply end at or near peak extension — report the best
      // point found so far rather than nothing, flagged as unconfirmed.
      endIdx = bestIdx;
      notes.push('The hip never confirmed a descent after its highest point in this clip — it may end right at peak extension. The phase end is the highest point found so far, not a confirmed peak, so it may be a little early.');
    }
    if (endIdx - startIdx < RUN) {
      return { error: `The second pull resolved to only ${endIdx - startIdx + 1} sampled frame(s) — too short to score. Try a lower frame stride.` };
    }

    return {
      startIdx, endIdx, notes,
      peakElevPx: bestY,
      triggers: {
        crossGapPx: cross.bar[startIdx] ? (cross.knee[startIdx] - cross.bar[startIdx].y) : null,
        confirmed: !notes.length,
      },
    };
  },

  // Hip angle (shoulder–hip–knee) is the headline, scored per side — two
  // independent estimates sharing no keypoints, same contract as diagnostic 1.
  // Knee angle (hip–knee–ankle) is tracked alongside it as the second of the
  // three joints "triple extension" names; ankle/plantarflexion is not
  // measured at all (see the note below — COCO-17 has no foot keypoint).
  measure(samples, phase) {
    const notes = [];
    const series = [];
    const kneeSeries = [];
    let both = 0, interp = 0;

    for (let i = phase.startIdx; i <= phase.endIdx; i++) {
      const p = samples[i].p;
      const hL = jointAngle(p[KP.lHip], p[KP.lSho], p[KP.lKnee]);
      const hR = jointAngle(p[KP.rHip], p[KP.rSho], p[KP.rKnee]);
      const hVals = [hL, hR].filter(v => v != null);
      if (!hVals.length) continue;
      if (hVals.length === 2) both++;
      if ([KP.lHip, KP.lSho, KP.lKnee, KP.rHip, KP.rSho, KP.rKnee].some(k => p[k] && p[k].interp)) interp++;
      series.push({
        idx: i, frame: samples[i].frame, t: samples[i].t,
        value: hVals.reduce((a, b) => a + b, 0) / hVals.length,
        lo: Math.min.apply(null, hVals),
        hi: Math.max.apply(null, hVals),
        spread: hVals.length === 2 ? Math.abs(hL - hR) : null,
      });

      const kL = jointAngle(p[KP.lKnee], p[KP.lHip], p[KP.lAnk]);
      const kR = jointAngle(p[KP.rKnee], p[KP.rHip], p[KP.rAnk]);
      const kVals = [kL, kR].filter(v => v != null);
      kneeSeries.push({ t: samples[i].t, value: kVals.length ? kVals.reduce((a, b) => a + b, 0) / kVals.length : null });
    }
    if (series.length < RUN) {
      return { error: 'Neither hip could be tracked with its shoulder and knee for long enough inside the second pull.' };
    }

    // Peak values are read from the last few samples of the phase rather than
    // the single last one: the phase end itself comes from a smoothed signal,
    // so one raw sample at that index can be noisy.
    const tailN = Math.min(3, series.length);
    const hipPeak = series.slice(-tailN).reduce((a, s) => a + s.value, 0) / tailN;
    const kneeTail = kneeSeries.slice(-tailN).filter(s => s.value != null);
    const kneePeak = kneeTail.length ? kneeTail.reduce((a, s) => a + s.value, 0) / kneeTail.length : null;

    // Synchrony: how far apart in time the hip and the knee each reach their
    // own maximum extension within the phase. "Triple extension" names a
    // simultaneous event — a lifter who extends the knees well before (or
    // after) the hips has split what the cue asks to happen together, even if
    // each joint individually reaches a good angle.
    let hipPeakIdx = 0, hipPeakVal = -Infinity;
    series.forEach((s, k) => { if (s.value > hipPeakVal) { hipPeakVal = s.value; hipPeakIdx = k; } });
    let kneePeakIdx = -1, kneePeakVal = -Infinity;
    kneeSeries.forEach((s, k) => { if (s.value != null && s.value > kneePeakVal) { kneePeakVal = s.value; kneePeakIdx = k; } });
    const syncGap = kneePeakIdx >= 0 ? Math.abs(series[hipPeakIdx].t - kneeSeries[kneePeakIdx].t) : null;

    const spreads = series.map(s => s.spread).filter(v => v != null);
    const summary = {
      hipPeak, kneePeak,
      hipDeficit: 180 - hipPeak,
      kneeDeficit: kneePeak == null ? null : 180 - kneePeak,
      syncGap,
      kneeLeadsHip: syncGap != null ? (kneeSeries[kneePeakIdx].t < series[hipPeakIdx].t) : null,
      meanSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
      n: series.length,
      bothSides: both / series.length,
      interpFrac: interp / series.length,
      duration: series[series.length - 1].t - series[0].t,
    };

    notes.push('Ankle extension (rising onto the toes) is not measured: ViTPose\'s COCO-17 output has no foot keypoint, so only two of the three joints in "triple extension" — hip and knee — are scored here.');
    if (summary.kneeDeficit == null) {
      notes.push('The knee angle could not be measured for enough of the phase (hip, knee or ankle confidence too low near the top) — only hip extension is scored this time.');
    }
    if (summary.meanSpread != null && summary.meanSpread > 8) {
      notes.push('The two sides\' hip angles disagree by ' + fmt(summary.meanSpread) + '° on average. A steady offset points to the camera not being square to the lifter (or the lifter twisted on the bar); a jittery one points to an unreliable pose track — check the band on the plot.');
    }
    return { series, summary, notes };
  },

  verdict(summary) {
    const deficits = [summary.hipDeficit].concat(summary.kneeDeficit != null ? [summary.kneeDeficit] : []);
    const worst = Math.max.apply(null, deficits);
    if (worst <= EXT_GOOD) return { label: 'full extension', status: 'good' };
    if (worst <= EXT_WARN) return { label: 'partial extension', status: 'warning' };
    return { label: 'pull cut short', status: 'critical' };
  },

  // Dashed reference line at the anatomical target itself (a straight joint),
  // not at the phase's own mean — unlike diagnostic 1, the cue here is
  // distance from a fixed reference, not internal constancy.
  referenceLine() {
    return { value: 180, label: 'full extension' };
  },

  tiles(summary, verdict) {
    return [
      { label: 'Hip extension', value: fmt(summary.hipDeficit) + '° short',
        sub: verdict.label, status: verdict.status },
      { label: 'Knee extension', value: summary.kneeDeficit == null ? '—' : fmt(summary.kneeDeficit) + '° short',
        sub: 'from full extension' },
      { label: 'Synchrony', value: summary.syncGap == null ? '—' : fmt(summary.syncGap * 1000, 0) + ' ms',
        sub: summary.kneeLeadsHip == null ? 'hip/knee peak gap' : (summary.kneeLeadsHip ? 'knee leads hip' : 'hip leads knee') },
      { label: 'L/R disagreement', value: summary.meanSpread == null ? '—' : '±' + fmt(summary.meanSpread) + '°', sub: 'hip angle uncertainty' },
    ];
  },

  transparencyLines(res, samples, ctxExtra) {
    const s = res.summary, ph = res.phase, tr = ph.triggers;
    const pct = v => Math.round(v * 100) + '%';
    return [
      '<strong>Phase</strong> — frames ' + samples[ph.startIdx].frame + '–' +
        samples[ph.endIdx].frame + ', ' + fmt(s.duration, 2) + 's, ' + s.n + ' sampled frames measured.',
      '<strong>Start trigger</strong> — bar (wrist + 1/6 forearm) crossing knee height' +
        (tr.crossGapPx != null ? ', clearing it by ' + fmt(tr.crossGapPx, 0) + 'px' : '') +
        ' — the same event that ends the first pull.',
      '<strong>End trigger</strong> — smoothed hip elevation reaching its highest point' +
        (tr.confirmed
          ? ', confirmed by the hip dropping back at least ' + fmt(EXT_CONFIRM_RISE, 2) + ' torso-lengths afterward.'
          : ' (unconfirmed in this clip — see note below).'),
      '<strong>Measurement</strong> — hip angle (shoulder–hip–knee) scored per side; knee angle (hip–knee–ankle) scored per side alongside it. ' +
        pct(s.bothSides) + ' of frames had both hip-side estimates, ' + pct(s.interpFrac) + ' relied on a detection filled in from neighbouring frames.',
      '<strong>Peak reading</strong> — the extension numbers are the mean of the last ' + Math.min(3, s.n) +
        ' sampled frames of the phase, not one raw sample, since the phase end itself comes from a smoothed signal.',
      '<strong>Time smoothing</strong> — ' + (ctxExtra.smoothingMs
        ? 'trajectories were smoothed with a Gaussian of σ = ' + ctxExtra.smoothingMs + ' ms before scoring (the slider under the video).'
        : 'off — scored on raw per-frame detections.'),
      '<strong>Caveat</strong> — angles are in the image plane (side-on camera assumed) and ankle extension is not measured (no foot keypoint). The extension bands (' +
        fmt(EXT_GOOD, 0) + '°/' + fmt(EXT_WARN, 0) + '° short of straight) are provisional and not fitted to labelled lifts.',
    ].concat(res.notes.map(n => '<strong>Note</strong> — ' + n));
  },

  // The shoulder-hip-knee-ankle chain on each side, plus a full-width
  // reference line at the peak hip height the end trigger found — so the
  // extremum the phase ended on is visible on the frame, the same way
  // diagnostic 1 draws its knee/bar ticks.
  overlay(ctx, sample, phase, res, size) {
    const p = sample.p;
    const lw = Math.max(2, size / 260);

    for (const [sh, hip, knee, ank] of [[KP.lSho, KP.lHip, KP.lKnee, KP.lAnk], [KP.rSho, KP.rHip, KP.rKnee, KP.rAnk]]) {
      const chain = [p[sh], p[hip], p[knee], p[ank]];
      if (chain.some(pt => !pt)) continue;
      for (const [w, style] of [[lw * 3.2, 'rgba(0,0,0,0.55)'], [lw * 1.8, C.series]]) {
        ctx.strokeStyle = style; ctx.lineWidth = w;
        ctx.beginPath(); ctx.moveTo(chain[0].x, chain[0].y);
        for (let k = 1; k < chain.length; k++) ctx.lineTo(chain[k].x, chain[k].y);
        ctx.stroke();
      }
    }

    if (phase.peakElevPx != null) {
      const y = phase.peakElevPx;
      ctx.save();
      ctx.strokeStyle = C.ref; ctx.globalAlpha = 0.85; ctx.lineWidth = Math.max(1, lw * 0.6);
      ctx.setLineDash([lw, lw * 1.5]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ctx.canvas.width, y); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = C.ref;
      ctx.font = Math.max(9, size / 62) + 'px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText('peak hip height', 6, y - 4);
    }
  },
};

const DIAGNOSTICS = [firstPullBackAngle, secondPullTripleExtension];

// Which diagnostics draw on the video. Only gates the overlay — a diagnostic
// that's switched off is still computed, plotted and scored, since the tickbox
// is about the frame getting crowded, not about what's being measured.
// Default on: a new diagnostic is invisible until you go looking for it
// otherwise.
const enabled = new Set(DIAGNOSTICS.map(d => d.id));


// --- runner -------------------------------------------------------------

let el = null;              // mounted elements
let state = null;           // { keypoints, meta, personId, samples, scale, results }
let smoothingMs = 0;        // time smoothing already applied to the track
let diagState = {};         // per-diagnostic render state: { canvas, ctx, stats, notes, geom, hover }

function personIds(kpByFrame) {
  const counts = new Map();
  for (const frame of Object.values(kpByFrame)) {
    for (const id of Object.keys(frame)) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || (+a[0]) - (+b[0]));
}

// Scores every diagnostic against the same prepared track. Diagnostics are
// independent: one erroring (no clean phase found) does not stop the others
// from being computed.
function run() {
  if (!state || !state.keypoints || !state.meta || !state.personId) return;
  const samples = buildTrack(state.keypoints, state.meta, state.personId);
  state.samples = samples;
  state.results = {};

  if (samples.length < FILL_WIN) {
    const err = { error: `Person ${state.personId} was detected in only ${samples.length} sampled frame(s).` };
    for (const d of DIAGNOSTICS) state.results[d.id] = err;
    return;
  }
  preparePoints(samples);
  const scale = torsoScale(samples);
  if (!scale) {
    const err = { error: 'No frame had a confident hip and shoulder on the same side, so there is no body scale to work from.' };
    for (const d of DIAGNOSTICS) state.results[d.id] = err;
    return;
  }
  state.scale = scale;
  samples.forEach((s, i) => { s.i = i; });

  for (const d of DIAGNOSTICS) {
    const phase = d.phase(samples, scale);
    if (phase.error) { state.results[d.id] = { error: phase.error }; continue; }
    const m = d.measure(samples, phase);
    if (m.error) { state.results[d.id] = { error: m.error }; continue; }
    state.results[d.id] = {
      phase,
      series: m.series,
      summary: m.summary,
      verdict: d.verdict(m.summary),
      notes: (phase.notes || []).concat(m.notes || []),
    };
  }
}


// --- rendering ----------------------------------------------------------

const PAD = { l: 48, r: 18, t: 24, b: 30 };

function tDomain() {
  const meta = state.meta, samples = state.samples;
  const last = samples && samples.length ? samples[samples.length - 1].t : 0;
  const byCount = (meta.frame_count && meta.fps) ? meta.frame_count / meta.fps : 0;
  return Math.max(last, byCount, 0.001);
}

function drawChart(d, ds) {
  const cv = ds.canvas, ctx = ds.ctx;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ds.geom = null;
  const res = state && state.results ? state.results[d.id] : null;
  if (!res) return;
  if (res.error) {
    ctx.fillStyle = C.muted;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    wrapText(ctx, res.error, cv.width / 2, cv.height / 2 - 6, cv.width - 60, 17);
    return;
  }

  const w = cv.width, h = cv.height;
  const gw = w - PAD.l - PAD.r, gh = h - PAD.t - PAD.b;
  const tMax = tDomain();

  // y domain: at least a 10-unit window (so a flat trace isn't magnified into
  // apparent wobble), and wide enough to include the reference line.
  let vMin = Infinity, vMax = -Infinity;
  for (const s of res.series) { vMin = Math.min(vMin, s.lo); vMax = Math.max(vMax, s.hi); }
  const ref = d.referenceLine ? d.referenceLine(res.summary) : null;
  if (ref) { vMin = Math.min(vMin, ref.value); vMax = Math.max(vMax, ref.value); }
  const span = Math.max(vMax - vMin, 10);
  const mid = (vMin + vMax) / 2;
  vMin = mid - span / 2 - span * 0.08;
  vMax = mid + span / 2 + span * 0.08;

  const X = t => PAD.l + (t / tMax) * gw;
  const Y = v => PAD.t + (1 - (v - vMin) / (vMax - vMin)) * gh;
  ds.geom = { X, Y, tMax, vMin, vMax, gw, gh };

  // active phase, shaded — the rest of the clip stays visible as context so the
  // phase's position in the lift is legible
  const t0 = res.series[0].t, t1 = res.series[res.series.length - 1].t;
  ctx.fillStyle = C.phase;
  ctx.fillRect(X(t0), PAD.t, Math.max(1, X(t1) - X(t0)), gh);

  ctx.font = '10px system-ui, sans-serif';
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  ctx.fillStyle = C.muted; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = vMin + (i / 4) * (vMax - vMin), y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke();
    ctx.fillText(fmt(v, 0) + d.unit, PAD.l - 6, y + 3);
  }
  ctx.strokeStyle = C.axis;
  ctx.beginPath(); ctx.moveTo(PAD.l, PAD.t); ctx.lineTo(PAD.l, PAD.t + gh); ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = C.muted;
  ctx.fillText('0s', PAD.l, h - 8);
  ctx.fillText(fmt(tMax) + 's', w - PAD.r, h - 8);
  ctx.fillText(d.phaseLabel || d.title, (X(t0) + X(t1)) / 2, PAD.t - 9);

  // uncertainty band: the left-side and right-side estimates. Same hue as the
  // trace at low alpha — it is not a second series.
  ctx.fillStyle = C.band;
  ctx.beginPath();
  res.series.forEach((s, i) => { const x = X(s.t), y = Y(s.hi); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  for (let i = res.series.length - 1; i >= 0; i--) ctx.lineTo(X(res.series[i].t), Y(res.series[i].lo));
  ctx.closePath(); ctx.fill();

  // reference line, direct-labeled — the phase mean (diagnostic 1) or a fixed
  // anatomical target (diagnostic 2); each diagnostic decides which is
  // meaningful for its own cue.
  if (ref) {
    const ry = Y(ref.value);
    ctx.save();
    ctx.strokeStyle = C.ink2; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(t0), ry); ctx.lineTo(X(t1), ry); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = C.ink2; ctx.textAlign = 'left';
    ctx.fillText(ref.label, Math.min(X(t1) + 4, w - PAD.r - 70), ry - 4);
  }

  ctx.strokeStyle = C.series; ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  res.series.forEach((s, i) => { const x = X(s.t), y = Y(s.value); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();

  for (const s of [res.series[0], res.series[res.series.length - 1]]) {
    ctx.fillStyle = C.series;
    ctx.beginPath(); ctx.arc(X(s.t), Y(s.value), 4, 0, 2 * Math.PI); ctx.fill();
  }

  const v = el.video();
  if (v && isFinite(v.currentTime)) {
    const x = X(Math.min(v.currentTime, tMax));
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + gh); ctx.stroke();
    ctx.restore();
  }

  if (ds.hover != null) drawTooltip(ctx, res, w, h, ds, d);
}

function drawTooltip(ctx, res, w, h, ds, d) {
  const s = res.series[ds.hover];
  if (!s) return;
  const x = ds.geom.X(s.t), y = ds.geom.Y(s.value);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, PAD.t + ds.geom.gh); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = C.series;
  ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = C.surface; ctx.lineWidth = 2; ctx.stroke();

  const lines = [
    fmt(s.t, 2) + 's · frame ' + s.frame,
    fmt(s.value) + d.unit,
    s.spread == null ? 'single estimate' : 'L/R differ ' + fmt(s.spread) + d.unit,
  ];
  ctx.font = '11px system-ui, sans-serif';
  const bw = Math.max.apply(null, lines.map(l => ctx.measureText(l).width)) + 16;
  const bh = lines.length * 14 + 10;
  const bx = Math.min(Math.max(x + 10, PAD.l), w - PAD.r - bw);
  const by = Math.min(Math.max(y - bh - 10, PAD.t), h - PAD.b - bh);
  ctx.fillStyle = 'rgba(13,13,13,0.94)';
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.fill(); ctx.stroke();
  ctx.textAlign = 'left';
  lines.forEach((l, i) => {
    ctx.fillStyle = i === 0 ? C.muted : C.ink;
    ctx.fillText(l, bx + 8, by + 17 + i * 14);
  });
}

function wrapText(ctx, text, cx, cy, maxW, lh) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const trial = line ? line + ' ' + word : word;
    if (ctx.measureText(trial).width > maxW && line) { lines.push(line); line = word; }
    else line = trial;
  }
  if (line) lines.push(line);
  const top = cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, top + i * lh));
}

function tile(label, value, sub, status) {
  const color = status ? C[status] : C.ink;
  return '<div class="diag-tile">' +
    '<div class="diag-tile-label">' + label + '</div>' +
    '<div class="diag-tile-value" style="color:' + color + '">' + value + '</div>' +
    '<div class="diag-tile-sub">' + (sub || '') + '</div></div>';
}

function drawPanels(d, ds, ctxExtra) {
  const res = state && state.results ? state.results[d.id] : null;
  if (!res) { ds.stats.innerHTML = ''; ds.notes.innerHTML = ''; return; }
  if (res.error) {
    ds.stats.innerHTML = '';
    ds.notes.innerHTML = '<p class="diag-note"><strong>Not scored.</strong> ' + res.error + '</p>';
    return;
  }
  ds.stats.innerHTML = d.tiles(res.summary, res.verdict).map(t => tile(t.label, t.value, t.sub, t.status)).join('');
  const items = d.transparencyLines(res, state.samples, ctxExtra);
  ds.notes.innerHTML = '<p class="diag-cue">' + d.cue + '</p><ul class="diag-notes">' +
    items.map(i => '<li>' + i + '</li>').join('') + '</ul>';
}

function redrawAll() {
  const ctxExtra = { smoothingMs, scale: state && state.scale };
  for (const d of DIAGNOSTICS) {
    const ds = diagState[d.id];
    if (!ds) continue;
    drawChart(d, ds);
    drawPanels(d, ds, ctxExtra);
  }
}


// --- public API ---------------------------------------------------------

// One tickbox per diagnostic. Built from DIAGNOSTICS rather than from the
// current track, so the list is stable across uploads and a diagnostic that
// couldn't be scored on this clip still shows why in the panel below.
function buildToggles() {
  if (!el.toggles) return;
  el.toggles.innerHTML = '';
  for (const d of DIAGNOSTICS) {
    const label = document.createElement('label');
    label.className = 'diag-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = enabled.has(d.id);
    box.addEventListener('change', () => {
      if (box.checked) enabled.add(d.id); else enabled.delete(d.id);
      if (el.redraw) el.redraw();   // the video overlay is owned by app.py
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(' ' + d.title));
    el.toggles.appendChild(label);
  }
}

function nearestSample(ds, res, clientX) {
  if (!ds.geom || !res || res.error) return null;
  const rect = ds.canvas.getBoundingClientRect();
  const x = (clientX - rect.left) * (ds.canvas.width / rect.width);
  let best = null, bestD = Infinity;
  res.series.forEach((s, i) => {
    const d = Math.abs(ds.geom.X(s.t) - x);
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD <= 24 ? best : null;
}

// One section per diagnostic — its own tiles, canvas and notes — built into
// el.sections. A diagnostic's tickbox (buildToggles, above) only ever gates
// its video overlay; its section here is always present.
function buildSections() {
  if (!el.sections) return;
  el.sections.innerHTML = '';
  diagState = {};
  for (const d of DIAGNOSTICS) {
    const block = document.createElement('div');
    block.className = 'diag-block';

    const h = document.createElement('h4');
    h.className = 'diag-block-title';
    h.textContent = d.title;

    const stats = document.createElement('div');
    stats.className = 'diag-tiles';

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'diag-canvas-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = 620; canvas.height = 240;
    canvas.className = 'diag-canvas';
    canvasWrap.appendChild(canvas);

    const notes = document.createElement('div');

    block.appendChild(h);
    block.appendChild(stats);
    block.appendChild(canvasWrap);
    block.appendChild(notes);
    el.sections.appendChild(block);

    const ds = { canvas, ctx: canvas.getContext('2d'), stats, notes, geom: null, hover: null };
    diagState[d.id] = ds;

    canvas.addEventListener('mousemove', e => {
      const res = state && state.results ? state.results[d.id] : null;
      const hIdx = nearestSample(ds, res, e.clientX);
      if (hIdx !== ds.hover) { ds.hover = hIdx; drawChart(d, ds); }
    });
    canvas.addEventListener('mouseleave', () => { if (ds.hover != null) { ds.hover = null; drawChart(d, ds); } });
    // click-to-seek, same contract as the keypoint plot: any point on the curve
    // goes back to the frame that produced it
    canvas.addEventListener('click', e => {
      if (!ds.geom) return;
      const v = el.video();
      if (!v) return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (canvas.width / rect.width);
      const ratio = Math.max(0, Math.min(1, (x - PAD.l) / ds.geom.gw));
      v.currentTime = ratio * ds.geom.tMax;
    });
  }
}

const Diagnostics = {
  mount(opts) {
    el = opts;
    buildToggles();
    buildSections();
    el.select.addEventListener('change', () => {
      state.personId = el.select.value;
      run();
      redrawAll();
    });
  },

  // opts.smoothingMs — the Gaussian σ the caller already applied to these
  // trajectories, reported in the notes below. Scoring depends on it, so it
  // belongs with the other things the lifter needs in order to distrust the
  // number.
  setTrack(keypoints, meta, opts) {
    smoothingMs = (opts && opts.smoothingMs) || 0;
    for (const d of DIAGNOSTICS) {
      const ds = diagState[d.id];
      if (ds) { ds.hover = null; ds.geom = null; }
    }
    if (!keypoints || !meta) {
      state = null;
      el.wrap.style.display = 'none';
      for (const d of DIAGNOSTICS) {
        const ds = diagState[d.id];
        if (!ds) continue;
        ds.ctx.clearRect(0, 0, ds.canvas.width, ds.canvas.height);
        ds.stats.innerHTML = ''; ds.notes.innerHTML = '';
      }
      return;
    }
    // The same track re-arrives whenever the frontend's time smoothing changes,
    // so hold onto the chosen lifter: re-picking them on every drag of that
    // slider would make it unusable on a clip with more than one person in it.
    const prev = state && state.personId;
    const ids = personIds(keypoints);
    el.select.innerHTML = '';
    for (const [id, n] of ids) {
      const o = document.createElement('option');
      o.value = id; o.textContent = 'person ' + id + ' (' + n + ' frames)';
      el.select.appendChild(o);
    }
    el.wrap.style.display = 'block';   // not '' — the stylesheet's own rule
                                       // hides #diagWrap until there's a track
    const keep = ids.some(([id]) => id === prev) ? prev : (ids.length ? ids[0][0] : null);
    if (keep != null) el.select.value = keep;
    state = { keypoints, meta, personId: keep };
    if (!state.personId) {
      state.results = {};
      const err = { error: 'No person was detected in any sampled frame.' };
      for (const d of DIAGNOSTICS) state.results[d.id] = err;
    } else {
      run();
    }
    redrawAll();
  },

  draw() {
    for (const d of DIAGNOSTICS) {
      const ds = diagState[d.id];
      if (ds) drawChart(d, ds);
    }
  },

  // Called from the video overlay loop with the source frame index on screen.
  // Every enabled diagnostic whose phase covers this frame draws; their phase
  // labels stack rather than overwrite so more than one can be visible at once.
  overlay(ctx, frameIdx) {
    if (!state || !state.results) return;
    const size = ctx.canvas.height || 720;
    let shown = 0;
    for (const d of DIAGNOSTICS) {
      if (!enabled.has(d.id)) continue;
      const res = state.results[d.id];
      if (!res || res.error) continue;
      const ph = res.phase;
      const a = state.samples[ph.startIdx].frame, b = state.samples[ph.endIdx].frame;
      if (frameIdx < a || frameIdx > b) continue;
      let sample = null;
      for (let i = ph.startIdx; i <= ph.endIdx; i++) {
        if (state.samples[i].frame === frameIdx) { sample = state.samples[i]; break; }
      }
      if (!sample) continue;
      d.overlay(ctx, sample, ph, res, size);
      ctx.fillStyle = C.series;
      ctx.font = Math.max(12, size / 38) + 'px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(d.phaseLabel || d.title, 8, Math.max(16, size / 30) + shown * (size / 26));
      shown++;
    }
  },
};

window.Diagnostics = Diagnostics;
})();
