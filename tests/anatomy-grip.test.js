// SPDX-License-Identifier: AGPL-3.0-or-later
const test=require('node:test'),assert=require('node:assert/strict');
const modules=Promise.all([import('../src/anatomy/grip.mjs'),import('../src/anatomy/sequence.mjs'),import('../src/anatomy/pose-rig.mjs')]);
function entries(R){return Array.from({length:90},(_,i)=>{const points=structuredClone(R.REST),shift=.03*Math.sin(i/15);for(const p of Object.values(points)){p[0]+=shift;p[1]-=.9;}points.leftWrist[0]+=.006*(i%2?1:-1);return {time:i/30,idx:i,pose:{points,aspect:1,space:'image',confidence:Object.fromEntries(Object.keys(points).map(k=>[k,1]))},videoWidth:1000,videoHeight:1000};});}
test('grip: both palms stay on a moving bar with constant spacing; raw landmarks are unchanged',async()=>{
 const [G,S,R]=await modules,a=entries(R),input=JSON.stringify(a),seq=S.buildSequence(a),g=G.buildGripTrack(seq,{mode:'hands',lockHands:true});let previous;
 for(let i=5;i<85;i++){const original=R.withAnchors(seq.sample(i/30)),p=G.constrainGrip(original,g.sample(i/30));assert.deepEqual(p.grip.lockedSides,['left','right']);assert.ok(p.points.leftWrist.every(Number.isFinite));
  const palms=['left','right'].map(side=>{const palm=R.mix(p.points[side+'Wrist'],p.points[side+'Hand'],.045/.095);assert.ok(R.dist(palm,p.grip.points[side])<1e-8);assert.equal(p.provenance[side+'Wrist'],'grip-constrained');assert.equal(p.confidence[side+'Wrist'],0);return palm;});assert.ok(Math.abs(R.dist(...palms)-g.width)<1e-8);
  if(previous)assert.ok(R.dist(palms[0],previous)<.02,'no hand snap between nearby frames');previous=palms[0];
 }
 assert.equal(JSON.stringify(a),input);
});
test('grip: paused/backward scrubbing gives exactly the same constrained pose',async()=>{
 const [G,S,R]=await modules,seq=S.buildSequence(entries(R)),g=G.buildGripTrack(seq,{mode:'hands',lockHands:true});const at=t=>G.constrainGrip(R.withAnchors(seq.sample(t)),g.sample(t));
 const first=JSON.stringify(at(.7));at(2.6);at(.1);assert.equal(JSON.stringify(at(.7)),first);
});
test('grip: constraint is off without a bar or when the user releases it',async()=>{
 const [G,S,R]=await modules,seq=S.buildSequence(entries(R));assert.equal(G.buildGripTrack(seq,{mode:'auto',lockHands:true}),null);assert.equal(G.buildGripTrack(seq,{mode:'off',lockHands:true}),null);assert.equal(G.buildGripTrack(seq,{mode:'hands',lockHands:false}),null);
 const p=R.withAnchors(seq.sample(.5));assert.equal(G.constrainGrip(p,null),p);
});
test('grip: back-rack squat uses a grip outside the shoulders and retains both arms',async()=>{
 const [G,S,R]=await modules,{demoSession}=await import('../src/squat/analysis.mjs');const seq=S.buildSequence(S.mediaPipeEntries(demoSession())),g=G.buildGripTrack(seq,{mode:'back',lockHands:true});
 let locked=0;for(const f of seq.frames){const p=G.constrainGrip(R.withAnchors(f),g.sample(f.time));if(p.grip.lockedSides.length===2)locked++;assert.ok(Object.values(p.points).flat().every(Number.isFinite));}
 assert.equal(locked,seq.frames.length);
});
test('grip: impossible contact releases the arm instead of stretching it to a distant bar',async()=>{
 const [G,S,R]=await modules,seq=S.buildSequence(entries(R)),g=G.buildGripTrack(seq,{mode:'hands',lockHands:true}),pose=R.withAnchors(seq.sample(.7)),sample=structuredClone(g.sample(.7));sample.bar.centre[1]+=5;
 const p=G.constrainGrip(pose,sample);assert.deepEqual(p.grip.lockedSides,[]);assert.deepEqual(p.points.leftWrist,pose.points.leftWrist);assert.deepEqual(p.points.rightWrist,pose.points.rightWrist);
});
test('grip: wider grip adjusts contact spacing and activation stays independent',async()=>{
 const [G,S,R]=await modules,seq=S.buildSequence(entries(R)),a=G.buildGripTrack(seq,{mode:'back',lockHands:true}),b=G.buildGripTrack(seq,{mode:'back',lockHands:true,gripScale:1.3,gripTime:.8});assert.ok(b.width>a.width);assert.ok(Math.abs(b.referenceTime-.8)<.04);
 const pose={...R.withAnchors(seq.sample(.8)),activation:{quads:.5}};assert.equal(G.constrainGrip(pose,b.sample(.8)).activation,pose.activation);
});
test('grip: a hidden wrist retains contact during a back-rack hold',async()=>{
 const [G,S,R]=await modules,a=entries(R);for(let i=20;i<55;i++)for(const key of ['leftElbow','leftWrist','leftHand'])delete a[i].pose.points[key];
 const seq=S.buildSequence(a),g=G.buildGripTrack(seq,{mode:'back',lockHands:true});
 for(let i=20;i<55;i++){const p=G.constrainGrip(R.withAnchors(seq.sample(i/30)),g.sample(i/30));assert.ok(p.grip.lockedSides.includes('left'));assert.equal(p.jointSources.leftWrist,'estimated');assert.ok(R.dist(R.mix(p.points.leftWrist,p.points.leftHand,.045/.095),p.grip.points.left)<1e-8);}
});
