// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared pose adapter. No exercise-specific forward kinematics.
 * Image coordinates are preserved; missing joints stay missing.
 * Regional spine anchors are inferred reference points unless manually marked.
 */
export const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
export const add=(a,b)=>a.map((v,i)=>v+b[i]);
export const sub=(a,b)=>a.map((v,i)=>v-b[i]);
export const mul=(a,n)=>a.map(v=>v*n);
export const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
export const length=a=>Math.hypot(...a);
export const unit=a=>mul(a,1/(length(a)||1));
export const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const mix=(a,b,t)=>add(mul(a,1-t),mul(b,t));
export const dist=(a,b)=>length(sub(a,b));
const finite=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite);
const median=a=>{const b=a.slice().sort((a,b)=>a-b);return b.length?b[Math.floor(b.length/2)]:NaN;};
export const jointAngle=(a,b,c)=>a&&b&&c?Math.acos(clamp(dot(unit(sub(a,b)),unit(sub(c,b))),-1,1))*180/Math.PI:NaN;
export const flexion=(a,b,c)=>180-jointAngle(a,b,c);

export const COCO={nose:0,leftEar:3,rightEar:4,leftShoulder:5,rightShoulder:6,leftElbow:7,rightElbow:8,leftWrist:9,rightWrist:10,leftHip:11,rightHip:12,leftKnee:13,rightKnee:14,leftAnkle:15,rightAnkle:16};
export const MEDIAPIPE={nose:0,leftEar:7,rightEar:8,leftShoulder:11,rightShoulder:12,leftElbow:13,rightElbow:14,leftWrist:15,rightWrist:16,leftHip:23,rightHip:24,leftKnee:25,rightKnee:26,leftAnkle:27,rightAnkle:28,leftHeel:29,rightHeel:30,leftToe:31,rightToe:32};
export const ANCHORS=[
  ['pelvis','Pelvis centre'],['sacrum','Sacrum / L5–S1'],['lumbar','Lower back / L3'],
  ['thoracolumbar','Thoracolumbar / T12'],['thoracic','Upper back / T6'],['neck','Neck / C7'],
];
export const REST={
  pelvis:[0,.902,-.025],sacrum:[0,.989,-.042],lumbar:[0,1.068,-.012],
  thoracolumbar:[0,1.166,-.032],thoracic:[0,1.312,-.064],neck:[0,1.456,-.048],head:[0,1.602,.025],
  leftHip:[.081,.902,-.025],rightHip:[-.081,.902,-.025],
  leftKnee:[.077,.452,-.017],rightKnee:[-.077,.452,-.017],
  leftAnkle:[.070,.077,-.022],rightAnkle:[-.070,.077,-.022],
  leftToe:[.073,.028,.12],rightToe:[-.073,.028,.12],
  leftShoulder:[.161,1.396,-.025],rightShoulder:[-.161,1.396,-.025],
  leftElbow:[.218,1.114,-.027],rightElbow:[-.218,1.114,-.027],
  leftWrist:[.263,.887,-.025],rightWrist:[-.263,.887,-.025],
  leftHand:[.280,.79,-.006],rightHand:[-.280,.79,-.006],
};

/** Broad editable fitting priors, NOT healthy/unsafe thresholds.
 * CDC/Soucie passive ROM means are in ROM.md; these wider bounds are engineering
 * defaults. Unsigned three-point flexion cannot resolve hyperextension/twist.
 */
export const DEFAULT_ROM={knee:160,elbow:160};
export const CHAINS=['left','right'].flatMap(side=>[
  {id:side+'Leg',a:side+'Hip',b:side+'Knee',c:side+'Ankle',joint:'knee'},
  {id:side+'Arm',a:side+'Shoulder',b:side+'Elbow',c:side+'Wrist',joint:'elbow'},
]);

export function fromCoco(points,meta={},time=0,minConfidence=.3){
  const width=Number(meta.width),height=Number(meta.height);
  if(!(width>0&&height>0))return {time,points:{},image:{},space:'image',aspect:1};
  const image={},p={},confidence={};
  for(const [name,i] of Object.entries(COCO)){
    const q=points?.[i];if(!q||!q.every(Number.isFinite))continue;
    confidence[name]=q[2];if(q[2]<minConfidence)continue;
    image[name]=[q[1]/width,q[0]/height,q[2]];
    p[name]=[(q[1]-width/2)/height,.5-q[0]/height,0];
  }
  return {time,points:p,image,confidence,space:'image',aspect:width/height};
}

export function fromMediaPipe(frame,width,height){
  const image={},p={},flat={},confidence={};const aspect=width/height;
  const world=Array.isArray(frame?.world)&&frame.world.length===33&&
    Object.values(MEDIAPIPE).every(i=>{
      const w=frame.world[i];return w&&[w.x,w.y,w.z].every(Number.isFinite);
    });
  for(const [name,i] of Object.entries(MEDIAPIPE)){
    const q=frame?.landmarks?.[i];if(!q||![q.x,q.y].every(Number.isFinite))continue;
    confidence[name]=q.visibility??0;if(confidence[name]<.3)continue;
    image[name]=[q.x,q.y,q.visibility??1];flat[name]=[(q.x-.5)*aspect,.5-q.y,0];
    const w=frame.world?.[i];p[name]=world?[w.x,-w.y,-w.z]:flat[name].slice();
  }
  return {time:frame?.t??0,points:p,image,flat,confidence,space:world?'estimated-3d':'image',aspect};
}

/** A display-only depth prior for COCO's flat tracks. It preserves every image
 * coordinate and separates overlapping left/right limbs in a side view. The
 * near side is ambiguous; this is not input to activation or ROM fitting.
 */
export function displayDepth(pose){
  if(pose.space!=='image')return pose;
  const points=Object.fromEntries(Object.entries(pose.points).map(([k,p])=>[k,p.slice()]));
  const lh=points.leftHip,rh=points.rightHip,ls=points.leftShoulder,rs=points.rightShoulder;
  if(!lh||!rh||!ls||!rs)return pose;
  const scale=dist(mix(lh,rh,.5),mix(ls,rs,.5))/.494;
  const hipDepth=Math.sqrt(Math.max(0,(.162*scale)**2-dist(lh,rh)**2));
  const shoulderDepth=Math.sqrt(Math.max(0,(.322*scale)**2-dist(ls,rs)**2));
  const shoulders=mix(ls,rs,.5),hips=mix(lh,rh,.5);
  const faceDx=pose.points.nose?pose.points.nose[0]-shoulders[0]:0;
  const depthSign=(Math.abs(faceDx)>.01?faceDx:shoulders[0]-hips[0])>0?-1:1;
  for(const [side,sign] of [['left',1],['right',-1]]){
    for(const suffix of ['Hip','Knee','Ankle','Heel','Toe'])if(points[side+suffix])points[side+suffix][2]=sign*depthSign*hipDepth/2;
    for(const suffix of ['Shoulder','Elbow','Wrist'])if(points[side+suffix])points[side+suffix][2]=sign*depthSign*shoulderDepth/2;
  }
  return {...pose,points,displayDepth:true};
}

export function withAnchors(pose,manual={},articulate=true){
  const points=Object.fromEntries(Object.entries(pose.points).map(([k,p])=>[k,p.slice()]));
  const provenance=Object.fromEntries(Object.keys(points).map(k=>[k,pose.jointSources?.[k]??'tracked']));
  const {leftHip:lh,rightHip:rh,leftShoulder:ls,rightShoulder:rs}=points;
  if(!lh||!rh||!ls||!rs)return {...pose,points,provenance,anchorsAvailable:false};
  const pelvis=mix(lh,rh,.5),shoulders=mix(ls,rs,.5),up=unit(sub(shoulders,pelvis));
  // A front/side projection may collapse hip width. Never infer a reliable
  // axial rotation from that; use the camera-plane normal as a display prior.
  let lateral=pose.axes?.lateral??unit(add(sub(lh,rh),sub(ls,rs)));
  let forward=pose.axes?.forward??unit(cross(lateral,up));
  if(length(forward)<.1)forward=[0,0,1];
  const scale=pose.bodyScale||dist(pelvis,shoulders)/(.494);
  const spineScale=dist(pelvis,shoulders)/(.494);
  for(const [id] of ANCHORS){
    const delta=sub(REST[id],REST.pelvis);
    points[id]=add(pelvis,add(mul(up,delta[1]*spineScale),mul(forward,articulate?delta[2]*scale:0)));
    provenance[id]='inferred';
    if(finite(manual[id])){points[id]=manual[id].slice();provenance[id]='manual';}
  }
  if(points.leftEar&&points.rightEar){
    points.head=add(mix(points.leftEar,points.rightEar,.5),[0,.01*scale,0]);
  }else{
    // A nose alone does not locate the skull centre or resolve neck pitch.
    // Use an upright display prior instead of amplifying its offset into
    // extreme cervical extension. Ears override it when both are visible.
    const headForward=unit([forward[0],0,forward[2]]);
    points.head=add(points.neck,add([0,.146*scale,0],mul(headForward,.073*scale)));
  }
  provenance.head='inferred';
  for(const side of ['left','right']){
    const wrist=points[side+'Wrist'],elbow=points[side+'Elbow'];
    if(wrist&&elbow){points[side+'Hand']=add(wrist,mul(unit(sub(wrist,elbow)),.095*scale));provenance[side+'Hand']='inferred';}
    if(!points[side+'Toe']&&points[side+'Ankle']){
      points[side+'Toe']=add(points[side+'Ankle'],add(mul(forward,.142*scale),mul(up,-.049*scale)));
      provenance[side+'Toe']='inferred';
    }
  }
  return {...pose,points,provenance,anchorsAvailable:true,scale,forward,up};
}

/** Fit one pair of constant segment lengths across a sequence, including a
 * soft ROM penalty on root-to-end reach. Only estimated 3D is eligible.
 * Image-plane lengths are lower bounds under foreshortening, not limb lengths.
 */
export function calibrateLengths(poses,limits=DEFAULT_ROM){
  const result={chains:{},eligible:0};
  for(const ch of CHAINS){
    const samples=poses.filter(p=>p.space==='estimated-3d'&&[ch.a,ch.b,ch.c].every(k=>p.points[k]))
      .map(p=>[dist(p.points[ch.a],p.points[ch.b]),dist(p.points[ch.b],p.points[ch.c]),dist(p.points[ch.a],p.points[ch.c])])
      .filter(s=>s.every(v=>Number.isFinite(v)&&v>.015));
    if(samples.length<5)continue;
    const base=[median(samples.map(s=>s[0])),median(samples.map(s=>s[1]))];
    const robust=samples.filter(s=>s.slice(0,2).every((v,i)=>v/base[i]>.65&&v/base[i]<1.4));
    let best=null;
    for(let a=-3;a<=3;a++)for(let b=-3;b<=3;b++){
      const L=[base[0]*(1+a*.02),base[1]*(1+b*.02)];let cost=0;
      for(const s of robust){
        cost+=((L[0]-s[0])/base[0])**2+((L[1]-s[1])/base[1])**2;
        const c=(L[0]**2+L[1]**2-s[2]**2)/(2*L[0]*L[1]);
        const f=180-Math.acos(clamp(c,-1,1))*180/Math.PI;
        cost+=.12*(Math.max(0,f-limits[ch.joint])/20)**2;
        cost+=2*(Math.max(0,s[2]-L[0]-L[1])/(L[0]+L[1]))**2;
      }
      if(!best||cost<best.cost)best={lengths:L,cost,samples:robust.length};
    }
    if(best){result.chains[ch.id]=best;result.eligible=Math.max(result.eligible,best.samples);}
  }
  return result;
}

export function fitPose(pose,calibration,limits=DEFAULT_ROM){
  const points=Object.fromEntries(Object.entries(pose.points).map(([k,v])=>[k,v.slice()]));
  const diagnostics=[];
  if(pose.space!=='estimated-3d')return {...pose,points,fit:{applied:false,reason:'2D: limb length and depth are ambiguous.',diagnostics}};
  for(const ch of CHAINS){
    const prior=calibration?.chains[ch.id];if(!prior||![ch.a,ch.b,ch.c].every(k=>points[k]))continue;
    const [L1,L2]=prior.lengths,A=points[ch.a],B=points[ch.b],C=points[ch.c];
    const axis=unit(sub(C,A)),observedReach=dist(A,C);
    if(observedReach<1e-5)continue;
    const reach=clamp(observedReach,Math.abs(L1-L2)+1e-5,L1+L2-1e-5);
    const along=(L1*L1-L2*L2+reach*reach)/(2*reach);
    let perpendicular=sub(sub(B,A),mul(axis,dot(sub(B,A),axis)));
    if(length(perpendicular)<1e-5)perpendicular=cross(axis,Math.abs(axis[2])<.9?[0,0,1]:[1,0,0]);
    points[ch.b]=add(A,add(mul(axis,along),mul(unit(perpendicular),Math.sqrt(Math.max(0,L1*L1-along*along)))));
    points[ch.c]=add(A,mul(axis,reach));
    const angle=flexion(A,points[ch.b],points[ch.c]);
    diagnostics.push({joint:ch.b,angle,limit:limits[ch.joint],outsidePrior:angle>limits[ch.joint],
      displacement:Math.max(dist(B,points[ch.b]),dist(C,points[ch.c]))});
    // Distal observed foot points move with a fitted ankle, preserving their
    // relative orientation; raw landmarks and every upstream joint stay intact.
    if(ch.joint==='knee')for(const suffix of ['Heel','Toe']){
      const k=ch.a.replace('Hip',suffix);if(points[k])points[k]=add(points[k],sub(points[ch.c],C));
    }
  }
  return {...pose,points,fit:{applied:diagnostics.length>0,diagnostics}};
}

export function nearestManual(keyframes,time,maxGap=.12){
  const best=Object.keys(keyframes).map(Number).sort((a,b)=>Math.abs(a-time)-Math.abs(b-time))[0];
  return best!==undefined&&Math.abs(best-time)<=maxGap?keyframes[String(best)]:{};
}

/** UI persistence is explicit: only finite, named, per-frame points accepted. */
export function cleanAnchorTrack(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid anchor track.');
  const out={};let count=0;
  for(const [t,points] of Object.entries(input)){
    if(++count>20000||!Number.isFinite(Number(t))||Number(t)<0||Number(t)>3600)throw new Error('Invalid anchor time.');
    const clean={};for(const [id] of ANCHORS){const p=points?.[id];if(p!==undefined){if(!finite(p)||p.some(v=>Math.abs(v)>10))throw new Error('Invalid anchor position.');clean[id]=p.slice();}}
    if(Object.keys(clean).length)out[String(Number(t))]=clean;
  }
  return out;
}
