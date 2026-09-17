const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const deps=Promise.all([import('../src/anatomy/sequence.mjs'),import('../src/anatomy/pose-rig.mjs'),import('../src/anatomy/track-session.mjs')]);
function entries(R,n=61){return Array.from({length:n},(_,i)=>{const points=structuredClone(R.REST);for(const p of Object.values(points)){p[0]+=.12*Math.sin(i/20);p[1]-=1;}
 // An actually moving left wrist, not a held squat template.
 points.leftWrist[0]+=.1*Math.sin(i/10);
 return {idx:i*3,time:i/30,pose:{points,space:'image',aspect:1,confidence:Object.fromEntries(Object.keys(points).map(k=>[k,1]))}};});}
test('display sequence: hidden arm stays attached, labelled estimated, then reacquires',async()=>{
 const [S,R]=await deps,a=entries(R),raw=structuredClone(a);
 for(let i=15;i<45;i++)for(const k of ['leftElbow','leftWrist','leftHand'])delete a[i].pose.points[k];
 const input=JSON.stringify(a),seq=S.buildSequence(a);
 for(let i=15;i<45;i++){const p=R.withAnchors(seq.sample(i/30));for(const k of ['leftShoulder','leftElbow','leftWrist','leftHand'])assert.ok(p.points[k]?.every(Number.isFinite),k);assert.equal(p.jointSources.leftWrist,'estimated');assert.ok(R.dist(p.points.leftElbow,p.points.leftShoulder)<.5);}
 assert.equal(seq.sample(50/30).jointSources.leftWrist,'tracked');assert.equal(JSON.stringify(a),input,'display must not edit detector input');
 assert.ok(Math.hypot(...seq.sample(50/30).points.leftWrist.slice(0,2).map((v,i)=>v-raw[50].pose.points.leftWrist[i]))<.01,'smoothing preserves the moving wrist');
 const before=seq.sample(44/30).points.leftWrist,after=seq.sample(45/30).points.leftWrist;assert.ok(R.dist(before,after)<.09,'reacquisition must not snap across the body');
});
test('display sequence: an arm never detected is retained; whole-body loss holds an explicitly estimated pose',async()=>{
 const [S,R]=await deps,a=entries(R);for(const f of a)for(const k of ['rightShoulder','rightElbow','rightWrist','rightHand'])delete f.pose.points[k];
 a[30].pose.points={};const seq=S.buildSequence(a);
 assert.equal(R.withAnchors(seq.sample(.5)).anchorsAvailable,true);assert.equal(seq.sample(.5).jointSources.rightWrist,'estimated');
 const held=seq.sample(1);assert.equal(R.withAnchors(held).anchorsAvailable,true);assert.equal(held.held,true);
 assert.ok(Object.values(held.confidence).every(v=>v===0));assert.ok(Object.values(held.jointSources).every(v=>v==='estimated'));
 for(const name of ['leftShoulder','rightShoulder','leftElbow','rightElbow','leftWrist','rightWrist','leftKnee','rightKnee','leftAnkle','rightAnkle','leftToe','rightToe'])assert.ok(held.points[name]?.every(Number.isFinite),name);
 assert.deepEqual(a[30].pose.points,{},'held display must never fill the raw track');
});
test('display sequence: backend original frame indices and pixel units register without XY drift',async()=>{
 const [S,R]=await deps,a=entries(R),frames={};
 for(const f of a){frames[f.idx]=Array(17).fill(null);for(const [k,i] of Object.entries(R.COCO))if(f.pose.points[k]){const p=f.pose.points[k];frames[f.idx][i]=[p[0]*1000,-p[1]*1000,f.idx*2];}}
 const seq=S.buildSequence(a,{candidate:{method:'keypoint-lift',frames},stabilize:false,footLock:false,depthMode:'reconstruction'});assert.ok(Math.abs(seq.registration-.001)<1e-10);
 for(const f of a){const sample=seq.sample(f.time);for(const k of Object.keys(f.pose.points))assert.deepEqual(sample.points[k].slice(0,2),f.pose.points[k].slice(0,2));assert.equal(sample.bodyScale,seq.bodyScale);}
 const before=JSON.stringify(seq.sample(.4).points);assert.notEqual(before,JSON.stringify(seq.sample(.8).points));
});
test('display sequence: a still-frame candidate cannot freeze the clip or flip facing every frame',async()=>{
 const [S,R]=await deps,a=entries(R);for(let i=0;i<a.length;i++)a[i].pose.points.nose=[i%2?.3:-.3,.5,0];
 const seq=S.buildSequence(a,{candidate:{method:'still',joints3d:Array(17).fill([0,0,0])}});
 const signs=seq.frames.map(f=>Math.sign(f.points.leftShoulder[2]-f.points.rightShoulder[2]));assert.equal(new Set(signs).size,1);
 assert.notDeepEqual(seq.sample(.3).points.leftWrist,seq.sample(1).points.leftWrist);
});
test('display sequence: all upstream clips retain both arms and use actual frame times',async()=>{
 const [S,R]=await deps;for(const name of ['lateral-raise-cable-1','lateral-raise-cable-2','athlete-a-trim']){
 const track=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/global/example',name+'.track.json'))),entries=S.trackEntries(track),seq=S.buildSequence(entries);
 for(const f of seq.frames){const pose=R.withAnchors(f);if(!pose.anchorsAvailable)continue;for(const k of ['leftElbow','rightElbow','leftWrist','rightWrist'])assert.ok(pose.points[k],`${name}: ${k} @ ${f.time}`);}
 }
 const t={meta:{width:100,height:100,fps:30,frame_indices:[0,3,6],frame_times_ms:[0,124,261]},keypoints:{0:{},3:{},6:{}}};assert.deepEqual(S.trackEntries(t).map(f=>f.time),[0,.124,.261]);
});
test('squat track adapter uses raw confidences and cannot turn an occlusion into diagnostic evidence',async()=>{
 const [S,R,A]=await deps,points=Array.from({length:17},()=>[50,50,.1]);const track={meta:{width:100,height:100,fps:30},keypoints:{0:{0:points},1:{0:points},2:{0:points}}};
 const session=A.trackSession(track);assert.equal(session.frames[0].landmarks[13].visibility,.1);assert.equal(session.frames[0].landmarks[29].visibility,0);
 const {analyseSession}=await import('../src/squat/analysis.mjs');assert.equal(analyseSession(session).coverage,0);
});

test('display sequence: a visible wrist stays on the video when its elbow is hidden',async()=>{
 const [S,R]=await deps,a=entries(R);for(let i=10;i<30;i++)delete a[i].pose.points.leftElbow;
 const seq=S.buildSequence(a,{stabilize:false,footLock:false});for(let i=10;i<30;i++){const p=seq.sample(i/30);assert.deepEqual(p.points.leftWrist.slice(0,2),a[i].pose.points.leftWrist.slice(0,2));assert.equal(p.jointSources.leftWrist,'tracked');assert.equal(p.jointSources.leftElbow,'estimated');}
});
