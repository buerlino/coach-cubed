// SPDX-License-Identifier: AGPL-3.0-or-later
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const rig=import('../src/anatomy/pose-rig.mjs');

test('anatomy: original lateral-raise and weightlifting tracks move independent limbs',async()=>{
 const {fromCoco,withAnchors,dist}=await rig;
 for(const name of ['lateral-raise-cable-1','lateral-raise-cable-2','athlete-a-trim']){
  const track=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/global/example',name+'.track.json')));
  const poses=Object.entries(track.keypoints).map(([i,f])=>withAnchors(fromCoco(Object.values(f)[0],track.meta,Number(i)/track.meta.fps))).filter(p=>p.anchorsAvailable);
  assert.ok(poses.length>10);const first=poses[0];
  assert.ok(['leftWrist','rightWrist'].some(k=>poses.some(p=>p.points[k]&&first.points[k]&&dist(p.points[k],first.points[k])>.025)),name+' active wrist must move');
  for(const pose of poses)assert.ok(['pelvis','sacrum','lumbar','thoracolumbar','thoracic','neck'].every(id=>pose.provenance[id]==='inferred'));
 }
});
test('anatomy: inferred spine anchors can be corrected independently without editing tracked hips',async()=>{
 const {REST,withAnchors}=await rig;const original=structuredClone(REST),pose={points:original,space:'estimated-3d',aspect:1};
 const base=withAnchors(pose),mark=[.08,1.07,-.03],corrected=withAnchors(pose,{lumbar:mark});
 assert.deepEqual(corrected.points.lumbar,mark);assert.equal(corrected.provenance.lumbar,'manual');
 assert.deepEqual(corrected.points.leftHip,base.points.leftHip);assert.deepEqual(corrected.points.neck,base.points.neck);
 assert.deepEqual(original,REST);assert.notDeepEqual(corrected.points.lumbar,base.points.lumbar);
});
test('anatomy: missing tracking cannot leave a complete or invented body',async()=>{
 const {REST,withAnchors}=await rig;const p=structuredClone(REST);delete p.leftHip;
 assert.equal(withAnchors({points:p}).anchorsAvailable,false);
 const full=structuredClone(REST);delete full.leftWrist;delete full.leftHand;
 assert.equal(withAnchors({points:full}).points.leftHand,undefined);
});
test('anatomy: 2D ROM fitting abstains rather than lengthening a foreshortened limb',async()=>{
 const {REST,fitPose,calibrateLengths}=await rig;const p={space:'image',points:structuredClone(REST)};
 const calibration=calibrateLengths(Array(20).fill(p));assert.equal(calibration.eligible,0);
 const fitted=fitPose(p,calibration);assert.equal(fitted.fit.applied,false);assert.deepEqual(fitted.points,p.points);
});
test('anatomy: one set of fitted lengths spans a sequence and preserves raw coordinates',async()=>{
 const {REST,calibrateLengths,fitPose,dist}=await rig;
 const frames=Array.from({length:20},(_,i)=>{const points=structuredClone(REST);points.leftKnee[0]+=.012*Math.sin(i);points.leftKnee[2]=.025*Math.cos(i);return {space:'estimated-3d',points};});
 const before=structuredClone(frames),calibration=calibrateLengths(frames),lengths=calibration.chains.leftLeg.lengths;
 for(const f of frames){const p=fitPose(f,calibration);assert.equal(p.fit.applied,true);assert.ok(Math.abs(dist(p.points.leftHip,p.points.leftKnee)-lengths[0])<1e-6);assert.ok(Math.abs(dist(p.points.leftKnee,p.points.leftAnkle)-lengths[1])<1e-6);}
 assert.deepEqual(frames,before);
});
test('anatomy: soft ROM prior affects fitting without forcing every pose inside the range',async()=>{
 const {calibrateLengths,fitPose}=await rig;
 const frames=Array.from({length:10},()=>({space:'estimated-3d',points:{leftHip:[0,0,0],leftKnee:[.4,0,0],leftAnkle:[.03,.2,0]}}));
 const broad=calibrateLengths(frames,{knee:175,elbow:160}),narrow=calibrateLengths(frames,{knee:100,elbow:160});
 assert.notDeepEqual(broad.chains.leftLeg.lengths,narrow.chains.leftLeg.lengths);
 assert.ok(fitPose(frames[0],narrow,{knee:100,elbow:160}).fit.diagnostics.some(d=>d.outsidePrior));
});
test('anatomy: manual points are time-bounded and validated',async()=>{
 const {nearestManual,cleanAnchorTrack}=await rig;const track=cleanAnchorTrack({'1':{lumbar:[0,1,0]}});
 assert.deepEqual(nearestManual(track,1.04),track['1']);assert.deepEqual(nearestManual(track,1.5),{});
 assert.throws(()=>cleanAnchorTrack({'1':{lumbar:[null,0,0]}}));assert.throws(()=>cleanAnchorTrack({'NaN':{}}));
});
test('anatomy: bundled geometry matches its manifest and preserves named source identity',()=>{
 const dir=path.join(__dirname,'../src/anatomy/models'),m=JSON.parse(fs.readFileSync(path.join(dir,'body.json'))),b=fs.readFileSync(path.join(dir,'body.bin'));
 assert.equal(b.length,m.bytes);assert.equal(crypto.createHash('sha256').update(b).digest('hex'),m.sha256);assert.equal(m.parts.length,337);
 for(const p of m.parts){assert.ok(p.sourceSHA&&p.sourceSHA256&&p.conceptId);assert.ok(p.indices+p.indexCount*4<=b.length);assert.equal(p.indexCount%3,0);}
 for(const name of ['hip bone','lumbar vertebra','gluteus maximus','rectus femoris','deltoid'])assert.ok(m.parts.some(p=>p.name.toLowerCase().includes(name)),name);
});
test('anatomy: similarly named bones, muscles and cartilage attach to the correct region',async()=>{
 const {regionFor}=await import('../src/anatomy/regions.mjs');
 const m=JSON.parse(fs.readFileSync(path.join(__dirname,'../src/anatomy/models/body.json')));
 const part=name=>{const p=m.parts.find(p=>p.name===name);assert.ok(p,name);return p;};
 for(const side of ['Left','Right']){
  const prefix=side.toLowerCase();
  for(const name of ['tibialis anterior','tibialis posterior','fibularis brevis','fibularis longus']){
   const p=part(side+' '+name);assert.equal(p.system,'muscular');assert.ok(regionFor(p).includes(prefix+'Shin'));
  }
  const tract=part(side+' iliotibial tract');assert.equal(tract.system,'connective');assert.ok(regionFor(tract).includes(prefix+'Thigh'));
  assert.deepEqual(regionFor(part(side+' cuneiform cartilage')),['head']);
  for(const name of ['capitate','hamate','lunate','pisiform','scaphoid','trapezium','trapezoid','triquetral'])assert.deepEqual(regionFor(part(side+' '+name)),[prefix+'Hand']);
  for(const name of ['scapula','clavicle'])assert.deepEqual(regionFor(part(side+' '+name)),[prefix+'Girdle']);
  assert.equal(part(side+' subscapularis').system,'muscular');
 }
});
