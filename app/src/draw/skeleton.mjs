// SPDX-License-Identifier: AGPL-3.0-or-later
// The skeleton on a 2D canvas, as the old page draws it (drawOverlay in INDEX_HTML,
// src/app.py), in the mockup's look (design/mockups/Result.dc.html): a bone between
// two joints and a dot on each joint, but only where the model was sure. A joint
// below the confidence gate (CONF_THRESHOLD) is not drawn, and neither is any bone
// that ends in it; a missing joint (null) likewise. Nothing is guessed or faded in.
// Colours, widths and sizes come from the tokens (overlayStyle reads them), never from
// a literal here. Plain module, no DOM, no Preact: it draws on whatever 2D context it is given.
import { CONF_THRESHOLD } from './interpolate.mjs';
import { COCO17_SKELETON } from '../contracts/track.mjs';

const sure = p => !!p && p[2] >= CONF_THRESHOLD;

/**
 * The bones to draw: the track's own skeleton (meta.skeleton) or COCO-17's.
 * @param {{skeleton?: Array<[number, number]>}|null} meta
 */
export const bonesOf = meta => (meta && Array.isArray(meta.skeleton) && meta.skeleton.length ? meta.skeleton : COCO17_SKELETON);

/**
 * What one person's pose shows: the bones whose two ends are both sure, and the
 * sure joints, as canvas coordinates ([y, x, conf] becomes x, y), in drawing order.
 * @param {Array<[number, number, number]|null>} points
 * @param {ReadonlyArray<ReadonlyArray<number>>} bones
 * @returns {{bones: Array<[number, number, number, number]>, joints: Array<[number, number]>}}
 */
export function skeletonShapes(points, bones) {
  const out = { bones: [], joints: [] };
  for (const [a, b] of bones) {
    const pa = points[a], pb = points[b];
    if (!sure(pa) || !sure(pb)) continue;
    out.bones.push([pa[1], pa[0], pb[1], pb[0]]);
  }
  for (const p of points) if (sure(p)) out.joints.push([p[1], p[0]]);
  return out;
}

/**
 * The joints the model was unsure of (A3's "Unsure joints"): a joint below the gate, as canvas
 * coordinates. A joint that is missing (null) is not unsure, it is missing: nothing to draw.
 * @param {Array<[number, number, number]|null>} points
 * @returns {Array<[number, number]>}
 */
export const unsureJoints = points => points.filter(p => Array.isArray(p) && p[2] < CONF_THRESHOLD).map(p => [p[1], p[0]]);

const px = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

/**
 * The overlay's look, read from the tokens. `read(name)` gives a custom
 * property's value (`getComputedStyle(el).getPropertyValue`); `scale` is canvas
 * pixels per CSS pixel (the frame is drawn in its own pixels, shown smaller).
 * @param {(name: string) => string} read
 * @param {number} [scale]
 */
export function overlayStyle(read, scale = 1) {
  const v = name => String(read(name) || '').trim();
  return {
    bone: v('--accent-bone'),
    boneWidth: px(v('--bone-width')) * scale,
    joint: v('--text'),
    jointRadius: px(v('--joint-size')) * scale / 2,
    ring: v('--ground'),
    ringWidth: px(v('--joint-ring')) * scale,
  };
}

/**
 * The unsure joints' look, read from the tokens like overlayStyle's: a ring in the quiet text colour,
 * the joints' size and the ring's width. Kept apart from overlayStyle so its shape stays what it was.
 * @param {(name: string) => string} read
 * @param {number} [scale]
 */
export function unsureStyle(read, scale = 1) {
  const v = name => String(read(name) || '').trim();
  return { color: v('--text-quiet'), radius: px(v('--joint-size')) * scale / 2, width: px(v('--joint-ring')) * scale };
}

/**
 * Draws every person of a pose: bones first, then joints with a ring in the
 * ground colour so they read on any picture. With `unsure` (and style.unsure, unsureStyle()),
 * the joints below the gate are drawn too, as hollow rings: no bone leads to them.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object<string, Array>} pose { personId: points }, or null (draws nothing)
 * @param {ReadonlyArray<ReadonlyArray<number>>} bones bonesOf(meta)
 * @param {ReturnType<typeof overlayStyle>} style
 */
export function drawSkeleton(ctx, pose, bones, style, { unsure = false } = {}) {
  if (!pose) return;
  for (const points of Object.values(pose)) {
    const shapes = skeletonShapes(points, bones);
    ctx.strokeStyle = style.bone;
    ctx.lineWidth = style.boneWidth;
    ctx.lineCap = 'round';
    for (const [ax, ay, bx, by] of shapes.bones) {
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    ctx.fillStyle = style.joint;
    ctx.strokeStyle = style.ring;
    ctx.lineWidth = style.ringWidth;
    for (const [x, y] of shapes.joints) {
      ctx.beginPath();
      ctx.arc(x, y, style.jointRadius, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
    if (unsure && style.unsure) {
      ctx.strokeStyle = style.unsure.color;
      ctx.lineWidth = style.unsure.width;
      for (const [x, y] of unsureJoints(points)) {
        ctx.beginPath();
        ctx.arc(x, y, style.unsure.radius, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
  }
}
