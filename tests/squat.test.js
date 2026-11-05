// SPDX-License-Identifier: AGPL-3.0-or-later
const test=require('node:test');
const assert=require('node:assert/strict');
const load=()=>import('../src/squat/analysis.mjs');

test('squat: complete cycles and a cut attempt are distinguished',async()=>{
  const {analyseSession,demoSession}=await load();
  const full=demoSession(),a=analyseSession(full);
  assert.equal(a.reps.length,2);assert.ok(a.reps.every(r=>r.status==='complete'));
  const cut={...full,frames:full.frames.filter(f=>f.t<11.5),duration:11.5};
  const b=analyseSession(cut);assert.equal(b.reps.at(-1).status,'incomplete');
  assert.ok(!JSON.stringify(b.reps).includes('failed'));
});
test('squat: padding the same motion to a wider video does not change angles',async()=>{
  const {analyseSession,demoSession}=await load();
  const original=demoSession(),wide=structuredClone(original);wide.width*=2;
  for(const f of wide.frames)for(const p of f.landmarks)p.x=p.x/2+.25;
  const a=analyseSession(original),b=analyseSession(wide);
  assert.equal(a.reps.length,b.reps.length);
  a.frames.forEach((f,i)=>{assert.equal(f.valid,b.frames[i].valid);if(f.valid)assert.ok(Math.abs(f.knee-b.frames[i].knee)<1e-8);});
});
test('squat: perceived weakness cannot manufacture a muscle hypothesis',async()=>{
  const {analyseSession,demoSession,explainRep}=await load();const a=analyseSession(demoSession());
  const no=explainRep(a,a.reps[0],{}),yes=explainRep(a,a.reps[0],{groups:['glutes','quads'],outcome:'failed'});
  assert.equal(no.hypotheses.length,0);assert.equal(yes.hypotheses.length,0);assert.deepEqual(yes.reported,['glutes','quads']);
});
test('squat: feedback is bounded secondary support and never alters activation',async()=>{
  const {analyseSession,demoSession,explainRep}=await load();const a=analyseSession(demoSession());
  const before=JSON.stringify(a.frames.map(f=>f.activation));
  const base=explainRep(a,a.reps[1],{}),withReport=explainRep(a,a.reps[1],{groups:['erectors'],outcome:'failed'});
  assert.ok(base.hypotheses.length>=2);
  for(const h of withReport.hypotheses){const original=base.hypotheses.find(x=>x.group===h.group);assert.ok(original);assert.ok(h.score-original.score<=6.00001);assert.ok(h.score-original.score>=0);}
  assert.equal(withReport.hypotheses[0].group,base.hypotheses[0].group);
  assert.equal(JSON.stringify(a.frames.map(f=>f.activation)),before);
});
test('squat: poor tracking and frontal views cannot be rescued by self-report',async()=>{
  const {analyseSession,demoSession,explainRep}=await load();
  const original=demoSession(),front=analyseSession(original,{view:'front'});
  assert.ok(explainRep(front,front.reps[1],{groups:['quads']}).blocked);
  assert.ok(front.frames.every(f=>!f.activation));
  for(const f of original.frames)for(const p of f.landmarks)p.visibility=.1;
  const poor=analyseSession(original);assert.equal(poor.coverage,0);assert.equal(poor.reps.length,0);
  assert.ok(explainRep(poor,null,{groups:['quads']}).blocked);
});
test('squat: tracking loss breaks a rep instead of interpolating through it',async()=>{
  const {analyseSession,demoSession,explainRep}=await load();const s=demoSession();
  for(const f of s.frames)if(f.t>9.5&&f.t<10.2)f.landmarks=[];
  const a=analyseSession(s),broken=a.reps.find(r=>r.status==='tracking-gap');
  assert.ok(broken);assert.ok(explainRep(a,broken,{groups:['erectors']}).blocked);
  assert.ok(a.frames.filter(f=>f.t>9.5&&f.t<10.2).every(f=>!f.valid&&!f.activation));
});
test('squat: an isometric deep hold retains estimated activation',async()=>{
  const {estimateActivation}=await load();
  const hold=estimateActivation({valid:true,knee:105,hip:105,trunk:35,shin:28,phase:'hold'});
  const rest=estimateActivation({valid:true,knee:0,hip:0,trunk:0,shin:0,phase:'standing'});
  assert.ok(hold.quads>.5);assert.ok(hold.erectors>rest.erectors);
  assert.ok(Object.values(hold).every(x=>Number.isFinite(x)&&x>=0&&x<=1));
  assert.equal(estimateActivation({valid:false}),null);
});
test('squat: invalid tracks fail with an actionable error',async()=>{
  const {validateSession,demoSession}=await load();
  const s=demoSession();s.frames[2].t=s.frames[1].t;
  assert.throws(()=>validateSession(s),/strictly increasing/);
  const t=demoSession();t.frames[0].landmarks[0].x=NaN;
  assert.throws(()=>validateSession(t),/invalid landmark/);
  const u=demoSession();u.duration='forever';assert.throws(()=>validateSession(u),/duration/);
});
