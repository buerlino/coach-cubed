// SPDX-License-Identifier: AGPL-3.0-or-later
/** Squat prototype. Transparent, provisional rules; not a trained activation model.
 * All angles are projected camera-plane angles. Self-report is deliberately
 * absent from frame metrics and activation estimation. See METHOD.md.
 */
export const GROUPS = [
  ['quads','Quadriceps'],['glutes','Gluteals'],['adductors','Adductors'],
  ['hamstrings','Hamstrings'],['calves','Calves'],['erectors','Spinal extensors'],
  ['abdominals','Abdominals / bracing'],
];
export const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
export const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
export const median=a=>{const b=[...a].sort((x,y)=>x-y);return b.length?b[Math.floor(b.length/2)]:0;};
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const angle=(a,b,c)=>{
  const u=[a.x-b.x,a.y-b.y],v=[c.x-b.x,c.y-b.y];
  const d=Math.hypot(...u)*Math.hypot(...v);
  return d>1e-7?Math.acos(clamp((u[0]*v[0]+u[1]*v[1])/d,-1,1))*180/Math.PI:NaN;
};
const vis=p=>p&&Number.isFinite(p.visibility??1)&&Number.isFinite(p.presence??1)?clamp(Math.min(p.visibility??1,p.presence??1)):0;
const finitePoint=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
const SIDES={left:[11,23,25,27,29,31],right:[12,24,26,28,30,32]};

export function validateSession(data) {
  if(!data||!Array.isArray(data.frames)||data.frames.length<3||data.frames.length>20000)
    throw new Error('A track must contain 3–20,000 timestamped frames.');
  if(!Number.isFinite(data.width)||!Number.isFinite(data.height)||data.width<=0||data.height<=0)
    throw new Error('The track needs its original video width and height.');
  if(data.duration!==undefined&&(!Number.isFinite(data.duration)||data.duration<=0||data.duration>3600))
    throw new Error('The track duration must be a finite number of seconds.');
  if(data.fps!==undefined&&(!Number.isFinite(data.fps)||data.fps<=0||data.fps>240))
    throw new Error('The track sample rate must be between 0 and 240 fps.');
  let previous=-1;
  for(const f of data.frames){
    if(!Number.isFinite(f.t)||f.t<0||f.t<=previous)throw new Error('Frame times must be finite and strictly increasing.');
    previous=f.t;
    if(!Array.isArray(f.landmarks)||![0,33].includes(f.landmarks.length))
      throw new Error('Use MediaPipe 33-landmark tracks; undetected frames may have an empty array.');
    for(const p of f.landmarks){
      if(!finitePoint(p)||Math.abs(p.x)>10||Math.abs(p.y)>10||
        (p.visibility!==undefined&&(!Number.isFinite(p.visibility)||p.visibility<0||p.visibility>1)))
        throw new Error('The track contains invalid landmark coordinates or confidence values.');
    }
  }
  return data;
}

export function analyseSession(session, options={}) {
  validateSession(session);
  const view=options.view??'side';
  const side=options.side&&SIDES[options.side]?options.side:
    (mean(session.frames.map(f=>mean(SIDES.left.slice(0,4).map(i=>vis(f.landmarks[i])))))>=
     mean(session.frames.map(f=>mean(SIDES.right.slice(0,4).map(i=>vis(f.landmarks[i])))))?'left':'right');
  const ids=SIDES[side], ratio=session.width/session.height;
  const frames=session.frames.map(f=>{
    const landmarks=f.landmarks;
    const pts=ids.map(i=>landmarks[i]);
    const confidence=Math.min(...pts.slice(0,4).map(vis));
    if(pts.some(p=>!finitePoint(p))||confidence<.55)return{t:f.t,valid:false,confidence,landmarks};
    const [s,h,k,a,heel,toe]=pts.map(p=>({...p,x:p.x*ratio}));
    const thigh=dist(h,k),shin=dist(k,a),torso=dist(s,h);
    const knee=180-angle(h,k,a),hip=180-angle(s,h,k);
    const trunk=Math.atan2(Math.abs(s.x-h.x),h.y-s.y)*180/Math.PI;
    const shinAngle=Math.atan2(Math.abs(k.x-a.x),a.y-k.y)*180/Math.PI;
    const inFrame=pts.slice(0,4).every(p=>p.x>=-.02&&p.x<=1.02&&p.y>=-.02&&p.y<=1.02);
    const valid=inFrame&&[knee,hip,trunk,shinAngle].every(Number.isFinite)&&thigh>.035&&shin>.035&&torso>.06&&
      trunk<85&&knee>=-1&&knee<170;
    return{t:f.t,valid,confidence,landmarks,knee,hip,trunk,shin:shinAngle,
      hipY:h.y,shoulderY:s.y,ankleY:a.y,torso,leg:thigh+shin,
      heelLift:vis(pts[4])>.65&&vis(pts[5])>.65?(toe.y-heel.y)/(thigh+shin):null};
  });
  // Local median filtering never bridges a missing frame or a >250 ms gap.
  const keys=['knee','hip','trunk','shin','hipY','shoulderY','heelLift'];
  const filtered=frames.map((f,i)=>{
    if(!f.valid)return f;
    const window=[];
    for(let j=Math.max(0,i-2);j<=Math.min(frames.length-1,i+2);j++){
      if(!frames[j].valid||Math.abs(frames[j].t-f.t)>.18)continue;
      if(frames.slice(Math.min(i,j),Math.max(i,j)+1).some(p=>!p.valid))continue;
      window.push(frames[j]);
    }
    const out={...f};
    for(const key of keys){const values=window.map(x=>x[key]).filter(Number.isFinite);out[key]=values.length?median(values):null;}
    return out;
  });
  const good=filtered.filter(f=>f.valid);
  const standing=good.length?Math.min(35,median(good.map(f=>f.knee).sort((a,b)=>a-b).slice(0,Math.max(3,Math.floor(good.length*.12))))):0;
  for(let i=0;i<filtered.length;i++){
    const f=filtered[i],prev=filtered[i-1];
    f.velocity=0;f.hipVelocity=0;f.phase='untracked';
    if(!f.valid)continue;
    if(prev?.valid&&f.t-prev.t<.25){
      f.velocity=(f.knee-prev.knee)/(f.t-prev.t);
      f.hipVelocity=-(f.hipY-prev.hipY)/(f.t-prev.t)/f.leg;
    }
    f.phase=f.knee<standing+12?'standing':f.velocity>8?'descent':f.velocity< -8?'ascent':'hold';
    f.activation=view==='front'?null:estimateActivation(f);
  }
  let reps=[],start=null,bottom=null,up=false,lastGood=null;
  for(let i=0;i<filtered.length;i++){
    const f=filtered[i];
    if(!f.valid){
      if(start!==null&&lastGood!==null&&f.t-filtered[lastGood].t>.25){
        reps.push(buildRep(filtered,start,bottom??lastGood,lastGood,'tracking-gap',standing));
        start=null;bottom=null;up=false;
      }
      continue;
    }
    if(lastGood!==null&&f.t-filtered[lastGood].t>.25&&start!==null){
      reps.push(buildRep(filtered,start,bottom??lastGood,lastGood,'tracking-gap',standing));
      start=null;bottom=null;up=false;
    }
    if(start===null&&f.knee>standing+28){start=i;bottom=i;up=false;}
    if(start!==null){
      if(f.knee>filtered[bottom].knee)bottom=i;
      if(filtered[bottom].knee-f.knee>10)up=true;
      if(up&&f.knee<standing+15){
        reps.push(buildRep(filtered,start,bottom,i,'complete',standing));start=null;bottom=null;up=false;
      }
    }
    lastGood=i;
  }
  if(start!==null&&lastGood!==null)reps.push(buildRep(filtered,start,bottom??lastGood,lastGood,'incomplete',standing));
  reps=reps.filter(r=>r.duration>.65&&r.maxKnee-standing>38);
  reps.forEach((r,i)=>{r.id=i+1;});
  const coverage=good.length/frames.length;
  const warnings=[];
  if(coverage<.7)warnings.push('Too much of the clip is untracked. Keep the full lifter in view and use a shorter clip.');
  if(view==='front')warnings.push('This version needs a side or near-side view for squat angles and activation estimates.');
  if(view==='oblique')warnings.push('Oblique camera view: projected angles and movement hypotheses are less reliable.');
  if(!reps.length)warnings.push('No clear squat cycle found. Include a standing start, descent, and return or attempted ascent.');
  return{frames:filtered,reps,side,view,coverage,warnings,standing,source:session.source,
    eligible:coverage>=.7&&view!=='front'&&reps.some(r=>r.quality>=.8&&r.status!=='tracking-gap')};
}

function buildRep(frames,start,bottom,end,status,standing){
  const all=frames.slice(start,end+1),valid=all.filter(f=>f.valid),b=frames[bottom];
  const rising=frames.slice(bottom,end+1).filter(f=>f.valid);
  const baseline=median(frames.slice(bottom,Math.min(end+1,bottom+3)).filter(f=>f.valid).map(f=>f.trunk));
  const trunkRise=Math.max(0,...rising.filter(f=>f.knee>standing+25).map(f=>f.trunk-baseline));
  let slowStart=null,slowSeconds=0,slowAt=null;
  for(const f of rising){
    if(f.t-b.t>.3&&f.knee>standing+30&&Math.abs(f.velocity)<12){
      if(slowStart===null)slowStart=f.t;
      if(f.t-slowStart>slowSeconds){slowSeconds=f.t-slowStart;slowAt=slowStart;}
    }else slowStart=null;
  }
  const heelValues=valid.map(f=>f.heelLift).filter(Number.isFinite);
  return{start,end,bottom,startTime:frames[start].t,endTime:frames[end].t,bottomTime:b.t,
    duration:frames[end].t-frames[start].t,status,maxKnee:Math.max(...valid.map(f=>f.knee)),
    maxTrunk:Math.max(...valid.map(f=>f.trunk)),trunkRise,slowSeconds,slowAt,
    heelChange:heelValues.length>5?Math.max(...heelValues)-Math.min(...heelValues):null,
    quality:valid.length/all.length,ascentSeconds:frames[end].t-b.t,
    hasAscent:rising.some(f=>b.knee-f.knee>10),
    startsMidRep:frames[start].t===frames[0].t&&frames[start].knee>standing+28};
}

/** Values are heuristic relative activation indices, NOT %MVC or probabilities.
 * Includes a nonzero holding term and an eccentric/concentric phase term.
 * We deliberately omit perceived weakness, failure outcome and bar load: those
 * cannot supply an individual's activation calibration in this prototype.
 */
export function estimateActivation(f){
  if(!f?.valid)return null;
  const k=clamp(f.knee/115),h=clamp(f.hip/125),lean=clamp(f.trunk/60);
  const active=clamp((f.knee-8)/35);
  const phase=f.phase==='ascent'?1:f.phase==='descent'?.78:f.phase==='hold'?.9:.45;
  return{
    quads:clamp(.08+phase*(.65*k+.13*active)),
    glutes:clamp(.06+phase*(.52*h+.18*k)),
    adductors:clamp(.04+phase*(.43*h+.18*k*k)),
    hamstrings:clamp(.06+phase*(.13*h+.09*lean+.08*active)),
    calves:clamp(.06+phase*(.13*k+.15*clamp(f.shin/40))),
    erectors:clamp(.08+phase*(.39*lean+.22*active)),
    abdominals:clamp(.08+phase*(.18*lean+.25*active)),
  };
}

export function explainRep(analysis,rep,feedback={}){
  const reported=Array.isArray(feedback.groups)?feedback.groups.filter(x=>GROUPS.some(g=>g[0]===x)):[];
  const blocked=!rep||analysis.view==='front'||rep.quality<.8||rep.status==='tracking-gap'||analysis.coverage<.7;
  if(blocked)return{blocked:true,observations:[],hypotheses:[],reported,
    summary:'Video evidence is insufficient for a muscle-group hypothesis. Your feedback is recorded, but cannot fill this gap.'};
  const observations=[{time:rep.bottomTime,text:`Deepest tracked position: ${Math.round(rep.maxKnee)}° projected knee flexion.`}];
  if(rep.trunkRise>=10)observations.push({time:rep.bottomTime,text:`Torso inclination increased by ${Math.round(rep.trunkRise)}° during the attempted ascent.`});
  if(rep.slowSeconds>=.35)observations.push({time:rep.slowAt,text:`A slow / held region lasted about ${rep.slowSeconds.toFixed(1)} s. A deliberate pause can look similar.`});
  if(rep.status==='incomplete')observations.push({time:rep.endTime,text:'The tracked attempt did not return to standing before the clip ended. Confirm whether it failed, stopped, or was cut short.'});
  if(rep.heelChange>.04)observations.push({time:rep.bottomTime,text:'The visible heel-to-toe relationship changed. Check the video for heel rise or tracking error.'});
  const hypotheses=[];
  if(rep.hasAscent&&rep.trunkRise>=10){
    hypotheses.push({group:'quads',score:50+Math.min(18,rep.trunkRise/2),label:'Knee-extensor capacity or ascent strategy',
      evidence:'The torso became more inclined as the ascent progressed.',
      alternatives:'Bar position, body proportions, fatigue, balance and an intentional hip-dominant strategy can produce a similar pattern.',
      next:'Compare with a successful rep at the same stance and depth. If a knee-extensor limitation is corroborated, consider quadriceps work such as leg extensions or a supported squat variation.'});
    hypotheses.push({group:'erectors',score:45+Math.min(15,rep.trunkRise/3),label:'Trunk-control demand',
      evidence:'The torso changed orientation during the ascent.',
      alternatives:'This does not establish lumbar flexion or weak spinal extensors. Hip motion alone can change torso inclination.',
      next:'Compare trunk control at a lower load and review bracing. Back-extension or bracing work is a candidate only if additional assessment supports it.'});
  }
  // Slowing alone cannot distinguish gluteal, adductor, quadriceps or global
  // fatigue. Do not manufacture a muscle candidate from a stall or self-report.
  for(const h of hypotheses){
    h.reportSupport=reported.includes(h.group);
    h.videoScore=h.score;
    h.score+=h.reportSupport?6:0; // fixed bounded tie-breaker, never a probability
  }
  hypotheses.sort((a,b)=>b.score-a.score);
  const comparison=analysis.reps.filter(r=>r.id!==rep.id&&r.status==='complete'&&r.quality>=.8&&r.maxKnee>=rep.maxKnee-15);
  if(comparison.length)observations.push({time:rep.bottomTime,text:`Other completed reps in this clip showed a median ${Math.round(median(comparison.map(r=>r.trunkRise)))}° ascent inclination change.`});
  return{blocked:false,observations,hypotheses,reported,
    unmatched:reported.filter(g=>!hypotheses.some(h=>h.group===g)),
    summary:hypotheses.length?'Movement-supported possibilities; the limiting muscle is not established.':
      'The video does not distinguish a particular limiting muscle group. A sticking point or local sensation alone is insufficient.',
    outcome:feedback.outcome??'unsure'};
}

export function demoSession(){
  const fps=24,duration=14,frames=[];
  for(let i=0;i<=fps*duration;i++){
    const t=i/fps;let d=0,leanExtra=0;
    if(t>=1&&t<6)d=Math.sin(Math.PI*(t-1)/5)**2;
    if(t>=7&&t<13.5){
      const u=(t-7)/6.5;d=Math.sin(Math.PI*u)**2;
      if(u>.5)leanExtra=28*Math.sin(Math.PI*(u-.5)*2);
    }
    const k=105*d,sh=28*d,lean=7+31*d+leanExtra;
    const rad=x=>x*Math.PI/180;
    const a={x:.57,y:.9},kn={x:a.x+Math.sin(rad(sh))*.245,y:a.y-Math.cos(rad(sh))*.245};
    const hip={x:kn.x+Math.sin(rad(sh-k))*.265,y:kn.y-Math.cos(rad(sh-k))*.265};
    const shoulder={x:hip.x+Math.sin(rad(lean))*.285,y:hip.y-Math.cos(rad(lean))*.285};
    const lm=Array.from({length:33},()=>({x:0,y:0,z:0,visibility:0}));
    lm[0]={x:shoulder.x+.08,y:shoulder.y-.09,z:0,visibility:.97};
    for(const ear of [7,8])lm[ear]={x:shoulder.x+.04,y:shoulder.y-.10,z:0,visibility:.97};
    for(const ids of Object.values(SIDES)){
      const points=[shoulder,hip,kn,a,{x:a.x-.045,y:.915},{x:a.x+.09,y:.925}];
      ids.forEach((idx,j)=>{lm[idx]={...points[j],z:0,visibility:.97};});
    }
    for(const [s,e,w] of [[11,13,15],[12,14,16]]){
      lm[e]={x:shoulder.x-.045,y:shoulder.y+.11,z:0,visibility:.97};
      lm[w]={x:shoulder.x-.075,y:shoulder.y+.02,z:0,visibility:.97};
    }
    frames.push({t,landmarks:lm});
  }
  return{schemaVersion:1,source:'demo',label:'Illustrative squat · synthetic motion',width:720,height:720,duration,fps,frames};
}
