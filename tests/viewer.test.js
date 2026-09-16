'use strict';
// Regression tests for clicking a joint in the 3D view to flip its depth sign.
//
// This exists because the interaction broke twice in ways that were invisible
// to every other check: the module parsed, the API round-tripped, and the page
// loaded — but load() threw on a stale reference, and the pick was taken on
// mouseup while the video draw loop was still moving the skeleton underneath
// the cursor. Both need the viewer to actually run, which is what loadViewer
// makes possible without a GPU.
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadViewer } = require('./loadViewer');

const W = 640, H = 340;

// COCO edges the backend ships, minus the face chain (one head point).
const EDGES = [[5, 6], [5, 11], [6, 12], [11, 12], [5, 7], [7, 9], [6, 8],
               [8, 10], [11, 13], [13, 15], [12, 14], [14, 16], [0, 5], [0, 6]];

// A spread-out pose in the keypoint-lift's units (pixels relative to the
// pelvis): one head point, no eyes or ears, limbs at assorted depths.
function pose(shiftX = 0, shiftY = 0) {
  return Array.from({ length: 17 }, (_, i) =>
    (i >= 1 && i <= 4) ? null
      : [((i * 37) % 200) - 100 + shiftX, -((i * 53) % 420) + shiftY, ((i * 29) % 200) - 100]);
}

const SIGNABLE = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

function candidate() {
  return {
    method: 'keypoint-lift', edges: EDGES, joints3d: pose(), signed: true,
    frames: { 10: pose(), 11: pose(60, -50) },
  };
}

function signTables() {
  const signs = new Array(17).fill(0), labels = new Array(17).fill(null);
  for (const i of SIGNABLE) { signs[i] = 1; labels[i] = 'joint ' + i; }
  return { signs, labels };
}

// Sweep the canvas for a pixel whose hover names `joint <i>`; that is the only
// honest way to ask "where is this joint on screen" without duplicating the
// viewer's own projection in the test.
function findJointPixel(v, wrap, i) {
  const want = 'joint ' + i;
  for (let y = 2; y < H; y += 2) {
    for (let x = 2; x < W; x += 2) {
      wrap.fire('mousemove', { clientX: x, clientY: y });
      if (v.el('v3dhint').textContent.startsWith(want + ' ')) return { x, y };
    }
  }
  return null;
}

async function mounted() {
  const v = await loadViewer({ width: W, height: H });
  assert.ok(v.Viewer, `viewer did not build: ${v.error}`);
  v.Viewer.load(candidate());
  const { signs, labels } = signTables();
  v.Viewer.setSigns(signs, labels);
  return v;
}

test('load() runs without throwing', async () => {
  const v = await loadViewer({ width: W, height: H });
  assert.equal(v.error, null);
  assert.doesNotThrow(() => v.Viewer.load(candidate()));
  v.Viewer.setSigns(...Object.values(signTables()));
  v.cleanup();
});

test('clicking a joint dispatches that joint', async () => {
  const v = await mounted();
  const wrap = v.el('v3dcanvasWrap');
  let got = null;
  wrap.addEventListener('v3djointclick', e => { got = e.detail.joint; });

  let checked = 0;
  for (const i of [13, 15, 7, 9]) {
    const px = findJointPixel(v, wrap, i);
    if (!px) continue;                 // off-canvas at this framing; skip
    got = null;
    wrap.fire('mousedown', { clientX: px.x, clientY: px.y });
    v.fireWindow('mouseup', { clientX: px.x, clientY: px.y });
    assert.equal(got, i, `click on joint ${i} dispatched ${got}`);
    checked++;
  }
  assert.ok(checked >= 2, 'expected at least two joints on screen to test');
  v.cleanup();
});

test('the pick survives the skeleton moving between press and release', async () => {
  // showFrame() is driven by the video draw loop, so with the clip playing the
  // joints move under a stationary cursor. The joint must be latched on press.
  const v = await mounted();
  const wrap = v.el('v3dcanvasWrap');
  let got = null;
  wrap.addEventListener('v3djointclick', e => { got = e.detail.joint; });

  const px = findJointPixel(v, wrap, 13);
  assert.ok(px, 'joint 13 should be on screen');
  wrap.fire('mousedown', { clientX: px.x, clientY: px.y });
  v.Viewer.showFrame(11);              // the video advances mid-click
  v.fireWindow('mouseup', { clientX: px.x, clientY: px.y });
  assert.equal(got, 13);
  v.cleanup();
});

test('a small wobble is still a click; a drag is not', async () => {
  const v = await mounted();
  const wrap = v.el('v3dcanvasWrap');
  let got = null;
  wrap.addEventListener('v3djointclick', e => { got = e.detail.joint; });
  const px = findJointPixel(v, wrap, 13);
  assert.ok(px);

  // A shaky hand inside the dead zone: still a click.
  got = null;
  wrap.fire('mousedown', { clientX: px.x, clientY: px.y });
  for (const [dx, dy] of [[1, 0], [2, 1], [1, 2], [0, 1], [0, 0]]) {
    v.fireWindow('mousemove', { clientX: px.x + dx, clientY: px.y + dy });
  }
  v.fireWindow('mouseup', { clientX: px.x, clientY: px.y });
  assert.equal(got, 13, 'a wobbly click should still register');

  // A real turntable drag: no click.
  got = null;
  wrap.fire('mousedown', { clientX: px.x, clientY: px.y });
  for (let k = 1; k <= 12; k++) {
    v.fireWindow('mousemove', { clientX: px.x + k * 6, clientY: px.y });
  }
  v.fireWindow('mouseup', { clientX: px.x + 72, clientY: px.y });
  assert.equal(got, null, 'a drag should not flip a sign');
  v.cleanup();
});

test('joints with no direction to choose are not clickable', async () => {
  // The head is one point on the midline: no sign, so no label, so no pick.
  const v = await loadViewer({ width: W, height: H });
  const wrap = v.el('v3dcanvasWrap');
  v.Viewer.load(candidate());
  const { signs, labels } = signTables();
  labels[0] = null; signs[0] = 0;
  v.Viewer.setSigns(signs, labels);

  let got = null;
  wrap.addEventListener('v3djointclick', e => { got = e.detail.joint; });
  // Every pixel on the canvas, coarsely: none of them may dispatch the head.
  for (let y = 4; y < H; y += 12) {
    for (let x = 4; x < W; x += 12) {
      wrap.fire('mousedown', { clientX: x, clientY: y });
      v.fireWindow('mouseup', { clientX: x, clientY: y });
      assert.notEqual(got, 0, `head dispatched from (${x},${y})`);
    }
  }
  v.cleanup();
});

test('an unsigned candidate (plate-anchor) is inert', async () => {
  const v = await loadViewer({ width: W, height: H });
  const wrap = v.el('v3dcanvasWrap');
  const c = candidate(); c.signed = false;
  v.Viewer.load(c);
  v.Viewer.setSigns(null, null);       // what v3dPushSigns does for signed:false

  let got = null;
  wrap.addEventListener('v3djointclick', e => { got = e.detail.joint; });
  for (let y = 4; y < H; y += 10) {
    for (let x = 4; x < W; x += 10) {
      wrap.fire('mousedown', { clientX: x, clientY: y });
      v.fireWindow('mouseup', { clientX: x, clientY: y });
    }
  }
  assert.equal(got, null, 'nothing should be clickable without a sign table');
  v.cleanup();
});
