// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the existing MediaPipe prototype (src/pose/pose.mjs, the code
// local-mode.mjs uses) on every example clip, the way local-mode does
// (fps 20), and returns timings plus COCO-17 tracks in the fixture format.
(async () => {
  const {toCoco17} = await import('/pose/coco17.mjs');
  const FPS = 20;
  const pose = await import('/pose/pose.mjs');
  const ids = (await (await fetch('/api/examples')).json()).map(e => e.id);
  const out = [];
  for (const id of ids) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.src = '/api/examples/' + encodeURIComponent(id) + '/video';
    document.body.appendChild(v);
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video error ' + id)); });
    const count = Math.ceil(v.duration * FPS);
    // Seek-only pass: what the frame-by-frame <video> seeking costs on its own.
    const s0 = performance.now();
    for (let i = 0; i < count; i++) await pose.seekVideo(v, i / FPS);
    const seekMs = performance.now() - s0;
    const t0 = performance.now();
    const session = await pose.analyseVideo(v, { fps: FPS });
    const totalMs = performance.now() - t0;
    const keypoints = {};
    session.frames.forEach((f, i) => {
      keypoints[String(i)] = f.landmarks.length
        ? { '0': toCoco17(f.landmarks, session.width, session.height) }
        : {};
    });
    out.push({
      id, duration: v.duration, videoWidth: v.videoWidth, videoHeight: v.videoHeight,
      frames: session.frames.length, detected: session.frames.filter(f => f.landmarks.length).length,
      seekMs: Math.round(seekMs), totalMs: Math.round(totalMs),
      track: { keypoints, meta: { width: session.width, height: session.height, fps: FPS,
        frame_count: session.frames.length, frame_indices: session.frames.map((f, i) => i),
        frame_times_ms: session.frames.map(f => f.t * 1000), source: 'mediapipe-local' } },
    });
    v.remove();
  }
  return out;
})()
