// SPDX-License-Identifier: AGPL-3.0-or-later
/** Display-only bar/grip constraint. Raw landmarks and diagnostic inputs are
 * never modified. Precomputed clip references make scrubbing deterministic. */
import {REST,add,sub,mul,mix,dist,unit,dot,cross,clamp} from './pose-rig.mjs';
import {barbellPose} from './barbell.mjs';
const SIDES=['left','right'];
const quantile=(a,q=.5)=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?s[Math.floor(q*(s.length-1))]:null;};
function barBasis(axis,up=[0,1,0]){
 let y=sub(up,mul(axis,dot(up,axis)));
 if(dist(y,[0,0,0])<.01)y=sub([0,0,1],mul(axis,axis[2]));
 y=unit(y);return [axis,y,unit(cross(axis,y))];
}
const local=(p,b)=>b.map(v=>dot(p,v));
const world=(p,b)=>add(add(mul(b[0],p[0]),mul(b[1],p[1])),mul(b[2],p[2]));
export function buildGripTrack(sequence,options={}){
 if(!sequence?.frames.length||!options.lockHands||options.mode==='off')return null;
 const {frames,bodyScale:scale}=sequence;
 const raw=frames.map(f=>{const b=barbellPose(f,options);if(!b||dist(b.a,b.b)<.01*scale)return null;
  return {...b,centre:mix(b.a,b.b,.5),axis:unit(sub(b.b,b.a)),time:f.time};});
 const valid=raw.map((b,i)=>b?i:-1).filter(i=>i>=0);if(!valid.length)return null;
 // Keep a consistent axis sign before smoothing directions.
 let last=null;for(const b of raw)if(b){if(last&&dot(b.axis,last)<0)b.axis=mul(b.axis,-1);last=b.axis;}
 const trusted=valid.filter(i=>SIDES.every(s=>frames[i].jointSources[s+'Wrist']==='tracked'&&(frames[i].confidence[s+'Wrist']??0)>=.5));
 const referencePool=trusted.length?trusted:valid;
 const ref=Number.isFinite(options.gripTime)?referencePool.reduce((a,b)=>Math.abs(frames[b].time-options.gripTime)<Math.abs(frames[a].time-options.gripTime)?b:a,referencePool[0]):referencePool[Math.floor(referencePool.length/2)];
 const reference=frames[ref],basis=barBasis(raw[ref].axis,reference.axes?.up);
 const widthAt=i=>dist(frames[i].points.leftWrist,frames[i].points.rightWrist);
 const shoulderSpan=quantile(frames.map(f=>dist(f.points.leftShoulder,f.points.rightShoulder)))||.322*scale;
 const minimum=options.mode==='back'?shoulderSpan+.14*scale:.25*scale;
 const width=clamp(Math.max(minimum,Number.isFinite(options.gripTime)?widthAt(ref):quantile(referencePool.map(widthAt)))*(options.gripScale??1),.2*scale,1.6*scale);
 const length=options.mode==='auto'?quantile(valid.map(i=>dist(raw[i].a,raw[i].b))):Math.max((options.length??2.2)*scale,width+.25*scale);
 const hands={};
 for(const s of SIDES){
  const p=reference.points,dir=unit(sub(p[s+'Wrist'],p[s+'Elbow']));
  hands[s]={direction:local(dist(dir,[0,0,0])>.1?dir:[0,-1,0],basis)};
  for(const [key,a,b,limits] of [['upper','Shoulder','Elbow',[.18,.46]],['lower','Elbow','Wrist',[.15,.40]]]){
   const values=frames.filter(f=>!f.held&&f.jointSources[s+a]==='tracked'&&f.jointSources[s+b]==='tracked').map(f=>dist(f.points[s+a],f.points[s+b]));
   hands[s][key]=clamp((quantile(values,.95)??dist(REST[s+a],REST[s+b])*scale)*1.04,limits[0]*scale,limits[1]*scale);
  }
 }
 // A short symmetric window damps bar-centre and axis noise without cumulative
 // filter state or a delay that depends on playback order. Never bridge a cut.
 const bars=raw.map((b,i)=>{
  if(!b)return null;let centre=[0,0,0],axis=[0,0,0],sum=0;
  for(let j=Math.max(0,i-5);j<=Math.min(frames.length-1,i+5);j++){
   const dt=Math.abs(frames[j].time-b.time);if(!raw[j]||dt>.18)continue;
   if(raw.slice(Math.min(i,j),Math.max(i,j)+1).some((x,k,a)=>!x||(k&&x.time-a[k-1].time>.25)))continue;
   const w=Math.exp(-.5*(dt/.085)**2);centre=add(centre,mul(raw[j].centre,w));axis=add(axis,mul(raw[j].axis,w));sum+=w;
  }
  centre=mul(centre,1/sum);axis=unit(axis);return {...b,mode:options.mode,centre,axis,a:add(centre,mul(axis,-length/2)),b:add(centre,mul(axis,length/2)),length,scale};
 });
 return {width,hands,referenceTime:reference.time,sample(time){
  let lo=0,hi=frames.length-1;while(lo<hi){const m=Math.ceil((lo+hi)/2);if(frames[m].time<=time)lo=m;else hi=m-1;}
  const a=bars[lo],b=bars[Math.min(lo+1,bars.length-1)],dt=frames[Math.min(lo+1,frames.length-1)].time-frames[lo].time;
  if(!a)return null;let bar=a;
  if(b&&dt>0&&dt<.5){const t=clamp((time-a.time)/dt),centre=mix(a.centre,b.centre,t),axis=unit(mix(a.axis,b.axis,t));bar={...a,centre,axis,a:add(centre,mul(axis,-length/2)),b:add(centre,mul(axis,length/2))};}
  return {bar,width,hands};
 }};
}
function elbowFor(shoulder,wrist,hint,l1,l2,fallback){
 const d=dist(shoulder,wrist);if(d>l1+l2+.002||d<Math.abs(l1-l2)+.002)return null;
 const axis=unit(sub(wrist,shoulder)),along=(l1*l1-l2*l2+d*d)/(2*Math.max(d,1e-6));
 let bend=sub(sub(hint,shoulder),mul(axis,dot(sub(hint,shoulder),axis)));
 if(dist(bend,[0,0,0])<.01)bend=sub(fallback,mul(axis,dot(fallback,axis)));
 if(dist(bend,[0,0,0])<.01){const v=Math.abs(axis[0])<.8?[1,0,0]:[0,0,1];bend=sub(v,mul(axis,dot(v,axis)));}
 return add(add(shoulder,mul(axis,along)),mul(unit(bend),Math.sqrt(Math.max(0,l1*l1-along*along))));
}
export function constrainGrip(pose,sample){
 if(!pose?.anchorsAvailable||!sample)return pose;
 const {bar,width,hands}=sample,basis=barBasis(bar.axis,pose.axes?.up),scale=bar.scale;
 const points={...pose.points},jointSources={...pose.jointSources},provenance={...pose.provenance},confidence={...pose.confidence},lockedSides=[],releasedSides=[];
 const grips={};
 for(const [side,sign] of [['left',1],['right',-1]]){
  const hand=hands[side],grip=add(bar.centre,mul(bar.axis,sign*width/2)),direction=unit(world(hand.direction,basis));
  const wrist=sub(grip,mul(direction,.045*scale)),shoulder=points[side+'Shoulder'];
  const elbow=elbowFor(shoulder,wrist,points[side+'Elbow'],hand.upper,hand.lower,pose.forward??basis[2]);
  if(!elbow){releasedSides.push(side);continue;}
  points[side+'Elbow']=elbow;points[side+'Wrist']=wrist;points[side+'Hand']=add(wrist,mul(direction,.095*scale));
  for(const suffix of ['Elbow','Wrist','Hand']){jointSources[side+suffix]='estimated';provenance[side+suffix]='grip-constrained';confidence[side+suffix]=0;}
  grips[side]=grip;lockedSides.push(side);
 }
 return {...pose,points,jointSources,provenance,confidence,displayBar:bar,grip:{lockedSides,releasedSides,points:grips,width},estimatedJoints:Object.keys(jointSources).filter(k=>jointSources[k]==='estimated')};
}
