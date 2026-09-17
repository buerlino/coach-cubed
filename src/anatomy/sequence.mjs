/** Display pose continuity. Raw detector data and diagnostic input are never
 * changed. Invisible joints remain an explicitly ESTIMATED anatomical pose.
 */
import {COCO,REST,fromCoco,fromMediaPipe,add,sub,mul,mix,dist,unit,dot,cross,clamp} from './pose-rig.mjs';
import {denoise,completeBody,stableFeet,torsoFrame} from './stability.mjs';
const median=a=>{const v=a.filter(Number.isFinite).sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:0;};
const quantile=(a,q)=>{const v=a.filter(Number.isFinite).sort((a,b)=>a-b);return v.length?v[Math.min(v.length-1,Math.floor(q*(v.length-1)))]:0;};
const CORE=['leftHip','rightHip','leftShoulder','rightShoulder'];
const PAIRS=[['leftShoulder','leftElbow'],['leftElbow','leftWrist'],['rightShoulder','rightElbow'],['rightElbow','rightWrist'],['leftHip','leftKnee'],['leftKnee','leftAnkle'],['rightHip','rightKnee'],['rightKnee','rightAnkle']];
const finite=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite);
const copy=p=>Object.fromEntries(Object.entries(p).filter(([,v])=>finite(v)).map(([k,v])=>[k,v.slice()]));
function torso(p){return CORE.every(k=>p[k])?dist(mix(p.leftHip,p.rightHip,.5),mix(p.leftShoulder,p.rightShoulder,.5)):0;}
function basis(p,defaultLateral=[1,0,0]){
 const hip=p.leftHip&&p.rightHip?mix(p.leftHip,p.rightHip,.5):[0,0,0];
 const sh=p.leftShoulder&&p.rightShoulder?mix(p.leftShoulder,p.rightShoulder,.5):add(hip,[0,1,0]);
 const y=unit(sub(sh,hip));let x=p.leftShoulder&&p.rightShoulder?sub(p.leftShoulder,p.rightShoulder):defaultLateral.slice();
 x=sub(x,mul(y,dot(x,y)));if(dist(x,[0,0,0])<.005)x=defaultLateral.slice();x=unit(x);
 return [x,y,unit(cross(x,y))];
}
const local=(v,b)=>b.map(a=>dot(v,a));
const world=(v,b)=>add(add(mul(b[0],v[0]),mul(b[1],v[1])),mul(b[2],v[2]));
function scales(image,xyz){
 const ratios=[];
 for(const [a,b] of [...PAIRS,['leftHip','leftShoulder'],['rightHip','rightShoulder']])if(image[a]&&image[b]&&xyz[a]&&xyz[b]){
  const u=sub(image[a],image[b]),v=sub(xyz[a],xyz[b]);const den=v[0]*v[0]+v[1]*v[1];
  const s=den>1e-8?(u[0]*v[0]+u[1]*v[1])/den:0;if(s>0&&Number.isFinite(s))ratios.push(s);
 }
 return median(ratios);
}
export function trackEntries(data){
 const {meta,keypoints}=data,frames=meta.frame_indices?.length?meta.frame_indices:Object.keys(keypoints).map(Number).sort((a,b)=>a-b);
 const preferred=meta.tracks?.kept;
 const worldFrames=new Map((data.anatomyFrames??[]).map(f=>[Math.round(f.t*1000),f]));
 return frames.map((idx,i)=>{
  const f=keypoints[String(idx)],raw=f?.[String(preferred)]??(f?Object.values(f)[0]:null),time=(meta.frame_times_ms?.[i]??idx/(meta.fps||30)*1000)/1000;
  let pose=fromCoco(raw,meta,time);
  const world=worldFrames.get(Math.round(time*1000));
  if(world?.world?.length){const mp=fromMediaPipe(world,meta.width,meta.height);pose={...mp,flat:pose.points,confidence:pose.confidence};}
  return {idx,time,pose,equipment:meta.equipment?.[String(idx)]??null,videoWidth:meta.width,videoHeight:meta.height};
 }).sort((a,b)=>a.time-b.time);
}
export function mediaPipeEntries(session){return session.frames.map((frame,idx)=>({idx:frame.idx??idx,time:frame.t,pose:fromMediaPipe(frame,session.width,session.height),equipment:frame.equipment??null,videoWidth:session.width,videoHeight:session.height}));}
/** Camera-aligned x/y with optional display smoothing and registered depth.
 * Clip-level scale prevents framing and atlas thickness from breathing.
 */
export function buildSequence(entries,{candidate=null,stabilize=true,footLock=true,depthMode='stable'}={}){
 const frames=entries.map(e=>({...e,points:copy(e.pose.flat??e.pose.points),confidence:{...e.pose.confidence},jointSources:{},image:e.pose.image}));
 const bodyScale=(quantile(frames.map(f=>torso(f.points)).filter(v=>v>.03),.8)||.45)/.494;
 // The fallback's near side is one clip-level choice, never a nose-sign flip.
 const facing=median(frames.map(f=>{const p=f.points;if(!p.leftShoulder||!p.rightShoulder)return 0;
  const c=mix(p.leftShoulder,p.rightShoulder,.5);return p.nose?p.nose[0]-c[0]:0;}));
 const first=frames.find(f=>CORE.every(k=>f.points[k]));
 const lean=first?mix(first.points.leftShoulder,first.points.rightShoulder,.5)[0]-mix(first.points.leftHip,first.points.rightHip,.5)[0]:0;
 const sign=(Math.abs(facing)>.005?facing:lean)>=0?-1:1;
 const depths=frames.map((f,i)=>{
  const c=candidate?.frames?.[String(f.idx)];
  // A single-frame candidate is never silently repeated over a whole clip.
  if(c){return Object.fromEntries(Object.entries(COCO).filter(([,j])=>finite(c[j])).map(([name,j])=>[name,[c[j][0],-c[j][1],c[j][2]]]));}
  return entries[i].pose.space==='estimated-3d'?copy(entries[i].pose.points):null;
 });
 const registration=median(frames.map((f,i)=>depths[i]?scales(f.points,depths[i]):0).filter(s=>s>0));
 const shoulderWidth=Math.max(.322*bodyScale,quantile(frames.map(f=>f.points.leftShoulder&&f.points.rightShoulder?dist(f.points.leftShoulder,f.points.rightShoulder):NaN),.85));
 const hipWidth=Math.max(.162*bodyScale,quantile(frames.map(f=>f.points.leftHip&&f.points.rightHip?dist(f.points.leftHip,f.points.rightHip):NaN),.85));
 const fixedShoulderDepth=Math.sqrt(Math.max(0,shoulderWidth**2-quantile(frames.map(f=>f.points.leftShoulder&&f.points.rightShoulder?dist(f.points.leftShoulder,f.points.rightShoulder):NaN),.5)**2));
 const fixedHipDepth=Math.sqrt(Math.max(0,hipWidth**2-quantile(frames.map(f=>f.points.leftHip&&f.points.rightHip?dist(f.points.leftHip,f.points.rightHip):NaN),.5)**2));
 for(let i=0;i<frames.length;i++){
  const f=frames[i],z=depths[i],rootZ=z?.leftHip&&z?.rightHip?(z.leftHip[2]+z.rightHip[2])/2:0;
  for(const [name,p] of Object.entries(f.points)){
   const side=name.startsWith('left')?1:name.startsWith('right')?-1:0;
   const fallback=side*sign*(/Hip|Knee|Ankle|Toe|Heel/.test(name)?fixedHipDepth:fixedShoulderDepth)/2;
   const estimatedZ=z?.[name]&&registration?((z[name][2]-rootZ)*registration):fallback;
   // Default camera overlay uses a conservative depth blend; raw reconstructed
   // depth is available separately for inspection, not forced on the video.
   p[2]=depthMode==='reconstruction'?estimatedZ:CORE.includes(name)?fallback:.25*clamp(estimatedZ,-.9*bodyScale,.9*bodyScale)+.75*fallback;
   f.jointSources[name]='tracked';
  }
 }
 if(stabilize)denoise(frames,bodyScale);
 // Bridge an occluded trunk reference. Complete missing frames are held by
 // completeBody below, explicitly estimated and excluded from diagnostics.
 for(const [a,b] of [['leftHip','rightHip'],['leftShoulder','rightShoulder'],['rightHip','leftHip'],['rightShoulder','leftShoulder']]){
  const usable=frames.map((f,i)=>f.points[a]&&f.points[b]?i:-1).filter(i=>i>=0);
  for(let i=0;i<frames.length;i++){const f=frames[i];if(f.points[a]||!f.points[b])continue;
   if(!usable.length){
    const other=a.includes('Hip')?['leftShoulder','rightShoulder']:['leftHip','rightHip'];
    const reference=frames.find(g=>g.points[other[0]]&&g.points[other[1]]);
    const lateral=reference?unit(sub(reference.points[other[0]],reference.points[other[1]])):[0,0,sign];
    const width=(a.includes('Hip')?.162:.322)*bodyScale,side=a.startsWith('left')?1:-1;
    f.points[a]=add(f.points[b],mul(lateral,width*side));f.jointSources[a]='estimated';f.confidence[a]=0;continue;
   }
   const j=usable.reduce((best,k)=>Math.abs(frames[k].time-f.time)<Math.abs(frames[best].time-f.time)?k:best,usable[0]);
   f.points[a]=add(f.points[b],sub(frames[j].points[a],frames[j].points[b]));f.jointSources[a]='estimated';
  }
 }
 completeBody(frames,bodyScale);
 const refBasis=first?basis(first.points):[[1,0,0],[0,1,0],[0,0,1]];
 const bases=frames.map(f=>basis(f.points,refBasis[0]));
 for(const [parent,child] of PAIRS){
  const samples=frames.map((f,i)=>f.points[parent]&&f.points[child]&&f.jointSources[child]==='tracked'?{i,t:f.time,v:local(sub(f.points[child],f.points[parent]),bases[i])}:null);
  const defaultVector=local(mul(sub(REST[child],REST[parent]),bodyScale),[[1,0,0],[0,1,0],[0,0,1]]);
  let previous=null;const nexts=Array(frames.length);let next=null;
  for(let i=frames.length-1;i>=0;i--){if(samples[i])next=samples[i];nexts[i]=next;}
  for(let i=0;i<frames.length;i++){
   const f=frames[i];if(samples[i]){previous=samples[i];continue;}if(!f.points[parent])continue;
   const later=nexts[i];let v=previous?.v??later?.v??defaultVector;
   if(previous&&later){const span=later.t-previous.t;
    // Short gaps interpolate; long gaps retain the last parent-relative pose,
    // then blend to reacquisition over 200 ms. Neither is a new measurement.
    const u=span<=.5?(f.time-previous.t)/span:clamp((f.time-(later.t-.2))/.2);v=mix(previous.v,later.v,u);
   }
   f.points[child]=add(f.points[parent],world(v,bases[i]));f.jointSources[child]='estimated';f.confidence[child]=0;
  }
 }
 // A segment projected directly toward the camera must not collapse to zero
 // and make the mesh disappear when no useful depth was available.
 for(const f of frames)for(const [a,b] of PAIRS)if(f.points[a]&&f.points[b]&&dist(f.points[a],f.points[b])<1e-5){
  f.points[b][2]=f.points[a][2]+sign*dist(REST[a],REST[b])*bodyScale;f.jointSources[b]='estimated';
 }
 const contacts=stableFeet(frames,bodyScale,{lock:footLock});
 // A full detector dropout holds a completed display pose, including its
 // planted feet, rather than recomputing some parts against missing evidence.
 let lastComplete=null;
 for(const f of frames){
  if(!f.held){lastComplete=f;continue;}
  const ref=lastComplete??frames.find(x=>!x.held);
  if(ref){f.points=copy(ref.points);f.contacts={...ref.contacts};}
  f.jointSources=Object.fromEntries(Object.keys(f.points).map(k=>[k,'estimated']));
  f.confidence=Object.fromEntries(Object.keys(f.points).map(k=>[k,0]));
 }
 for(const f of frames){f.axes=torsoFrame(f.points,refBasis[0]);}
 // Constant atlas thickness, including on a bent/foreshortened torso.
 for(const f of frames){f.bodyScale=bodyScale;f.aspect=entries[0]?.pose.aspect||1;f.space='registered-display';f.depthSource=candidate?.frames?candidate.method:depths.some(Boolean)?'MediaPipe world landmarks':'fixed display prior';}
 function sample(time,observed=null){
  if(!frames.length)return null;let lo=0,hi=frames.length-1;
  while(lo<hi){const m=Math.ceil((lo+hi)/2);if(frames[m].time<=time)lo=m;else hi=m-1;}
  const A=frames[lo],B=frames[Math.min(lo+1,frames.length-1)],span=B.time-A.time;

  const u=span>0&&span<.5?clamp((time-A.time)/span):0,near=u<.5?A:B,points=copy(near.points),jointSources={...near.jointSources};
  for(const name of Object.keys(points))if(A.points[name]&&B.points[name]){
   points[name]=mix(A.points[name],B.points[name],u);
   if(A.jointSources[name]==='estimated'||B.jointSources[name]==='estimated')jointSources[name]='estimated';
  }
  if(observed&&!stabilize&&!footLock)for(const [name,p] of Object.entries(observed.points))if(points[name]&&jointSources[name]==='tracked'){points[name][0]=p[0];points[name][1]=p[1];}
  const held=!!near.held||Math.abs(time-near.time)>.3&&span>=.5||time>frames.at(-1).time+.3||time<frames[0].time-.3;
  if(held)for(const k of Object.keys(points))jointSources[k]='estimated';
  return {...near,time,points,jointSources,held,confidence:held?Object.fromEntries(Object.keys(points).map(k=>[k,0])):near.confidence,axes:torsoFrame(points,near.axes?.lateral),estimatedJoints:Object.keys(jointSources).filter(k=>jointSources[k]==='estimated')};
 }
 return {frames,bodyScale,registration,sample,contacts,stabilize,footLock,depthMode,depthSource:frames[0]?.depthSource};
}
