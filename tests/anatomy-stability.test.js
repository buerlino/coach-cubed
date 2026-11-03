// SPDX-License-Identifier: AGPL-3.0-or-later
const test=require('node:test'),assert=require('node:assert/strict');
const deps=Promise.all([import('../src/anatomy/stability.mjs'),import('../src/anatomy/pose-rig.mjs'),import('../src/anatomy/barbell.mjs')]);
function clip(R,n=90){return Array.from({length:n},(_,i)=>({time:i/30,points:structuredClone(R.REST),confidence:Object.fromEntries(Object.keys(R.REST).map(k=>[k,1])),jointSources:Object.fromEntries(Object.keys(R.REST).map(k=>[k,'tracked']))}));}
test('stabilization rejects an isolated wrist jump without freezing a genuine arm raise',async()=>{
 const [S,R]=await deps,f=clip(R);for(let i=0;i<f.length;i++){f[i].points.leftWrist[1]+=.6*i/90+.004*(i%2?1:-1);}
 const original=f[40].points.leftWrist.slice();f[40].points.leftWrist[0]+=.7;S.denoise(f,1);
 assert.ok(R.dist(f[40].points.leftWrist,original)<.01);assert.equal(f[40].jointSources.leftWrist,'estimated');
 assert.ok(f[85].points.leftWrist[1]-f[5].points.leftWrist[1]>.5,'real arm movement remains');
});
test('foot contact suppresses planted jitter and releases for a real step',async()=>{
 const [S,R]=await deps,f=clip(R);
 for(let i=0;i<f.length;i++)for(const k of ['leftAnkle','leftToe','leftHeel'])if(f[i].points[k])f[i].points[k][0]+=(i>=50?(i-49)*.01:.001*(i%2?1:-1));
 const before=structuredClone(f);const counts=S.stableFeet(f,1);
 assert.ok(counts.left>20);assert.equal(f[40].contacts.left,true);
 assert.ok(R.dist(f[30].points.leftAnkle,f[40].points.leftAnkle)<1e-9,'planted foot does not jitter');
 assert.equal(f[51].contacts.left,false);assert.deepEqual(f[70].points.leftAnkle,before[70].points.leftAnkle,'step is not pinned to old contact');
 const free=structuredClone(before);S.stableFeet(free,1,{lock:false});assert.deepEqual(free.map(x=>x.points.leftAnkle),before.map(x=>x.points.leftAnkle));
});
test('a complete tracking gap retains a full finite estimated body and raw evidence remains missing',async()=>{
 const [S,R]=await deps,{buildSequence}=await import('../src/anatomy/sequence.mjs');const f=clip(R);
 const input=f.map((x,i)=>({idx:i,time:x.time,pose:{...x,aspect:1,space:'image'}}));
 for(let i=30;i<50;i++)input[i].pose.points={};const sequence=buildSequence(input);
 for(let i=30;i<50;i++){const p=sequence.sample(i/30);assert.equal(p.held,true);assert.ok(Object.values(p.points).flat().every(Number.isFinite));assert.ok(Object.keys(p.points).length>=20);assert.equal(Object.keys(input[i].pose.points).length,0);}
 assert.ok(sequence.sample(100).points.leftWrist,'timeline end holds the last complete body');
});
test('bar is opt-in without equipment evidence; hand-held and back placements follow the body',async()=>{
 const [,R,B]=await deps,p={points:structuredClone(R.REST),scale:1,videoWidth:1000,videoHeight:1000};
 assert.equal(B.barbellPose(p),null);assert.equal(B.barbellPose(p,{mode:'off'}),null);
 const held=B.barbellPose(p,{mode:'hands',plates:true});assert.equal(held.plates,true);assert.ok(Math.abs(R.dist(held.a,held.b)-2.2)<1e-6);
 const moved=structuredClone(p);for(const k of ['leftWrist','rightWrist'])moved.points[k][1]+=.5;
 assert.ok(Math.abs(B.barbellPose(moved,{mode:'hands'}).a[1]-held.a[1]-.5)<1e-6);
 const back=B.barbellPose(p,{mode:'back'});assert.match(back.source,/user-placed/);assert.ok(back.a[1]>p.points.leftShoulder[1]);
 p.equipment={bar:{box:[200,300,800,320],score:.9},plates:[{}]};const detected=B.barbellPose(p);assert.match(detected.source,/detected/);assert.ok(Math.abs(R.dist(detected.a,detected.b)-.6)<1e-6);
 p.equipment.bar.score=.1;assert.equal(B.barbellPose(p),null);
});
