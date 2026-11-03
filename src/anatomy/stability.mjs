// SPDX-License-Identifier: AGPL-3.0-or-later
/** Display-only continuity. The diagnostic track never passes through here. */
import {REST,add,sub,mul,mix,dist,unit,cross,dot,clamp} from './pose-rig.mjs';
export const median=a=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:0;};
const clone=p=>Object.fromEntries(Object.entries(p).map(([k,v])=>[k,v.slice()]));
const CORE=['leftHip','rightHip','leftShoulder','rightShoulder'];
const avg=(a,b)=>mix(a,b,.5);
export function denoise(frames,scale){
 const names=new Set(frames.flatMap(f=>Object.keys(f.points)));
 for(const name of names){
  const raw=frames.map(f=>f.points[name]?.slice());
  const clean=raw.map((p,i)=>{
   if(!p)return null;const a=raw[i-1],b=raw[i+1];
   if(a&&b&&frames[i+1].time-frames[i-1].time<.22&&dist(a,b)<.09*scale&&dist(p,avg(a,b))>.12*scale){
    frames[i].jointSources[name]='estimated';return avg(a,b);
   }return p;
  });
  for(let i=0;i<frames.length;i++){
   if(!clean[i])continue;let sum=[0,0,0],weight=0;
   for(let j=Math.max(0,i-3);j<=Math.min(frames.length-1,i+3);j++){
    const dt=Math.abs(frames[j].time-frames[i].time);if(!clean[j]||dt>.13)continue;
    if(frames.slice(Math.min(i,j),Math.max(i,j)+1).some((f,k,a)=>!f.points[name]||(k&&f.time-a[k-1].time>.25)))continue;
    const w=Math.exp(-.5*(dt/.055)**2)*Math.max(.15,frames[j].confidence[name]??1);sum=add(sum,mul(clean[j],w));weight+=w;
   }
   if(weight)frames[i].points[name]=mul(sum,1/weight);
  }
 }
}
/** Freeze body orientation across unresolved lateral-axis observations. */
export function torsoFrame(points,fallback=[1,0,0]){
 const hip=avg(points.leftHip,points.rightHip),shoulder=avg(points.leftShoulder,points.rightShoulder),up=unit(sub(shoulder,hip));
 let lateral=sub(points.leftShoulder,points.rightShoulder);lateral=sub(lateral,mul(up,dot(lateral,up)));
 if(dist(lateral,[0,0,0])<.01)lateral=sub(fallback,mul(up,dot(fallback,up)));
 if(dist(lateral,[0,0,0])<.01)lateral=[1,0,0];lateral=unit(lateral);
 return {up,lateral,forward:unit(cross(lateral,up))};
}
/** Fill the whole body, including the torso, before any mesh is transformed.
 * Missing entire frames hold the nearest complete pose and are labelled held.
 * Never delete a mesh on a per-joint confidence threshold.
 */
export function completeBody(frames,scale){
 let good=frames.map((f,i)=>CORE.every(k=>f.points[k])?i:-1).filter(i=>i>=0);
 const rest=Object.fromEntries(Object.entries(REST).map(([k,v])=>[k,mul(sub(v,[0,.95,0]),scale)]));
 for(let i=0;i<frames.length;i++){
  const f=frames[i];if(CORE.every(k=>f.points[k]))continue;
  const before=good.filter(j=>j<i).at(-1),after=good.find(j=>j>i),j=before??after;
  const ref=j===undefined?rest:frames[j].points;
  const root=CORE.find(k=>f.points[k]);const offset=root?sub(f.points[root],ref[root]):[0,0,0];
  const present=Object.keys(f.points).length;
  for(const k of CORE)if(!f.points[k]){f.points[k]=add(ref[k],offset);f.jointSources[k]='estimated';f.confidence[k]=0;}
  if(!present){f.held=true;f.confidence={};f.jointSources={};for(const [k,v] of Object.entries(ref)){f.points[k]=v.slice();f.jointSources[k]='estimated';f.confidence[k]=0;}}
 }
}
export function stableFeet(frames,scale,{lock=true}={}){
 const contactCounts={left:0,right:0};
 for(const side of ['left','right']){
  const ankle=side+'Ankle',toe=side+'Toe',heel=side+'Heel';
  const offsets=frames.filter(f=>f.points[toe]&&f.points[ankle]&&f.jointSources[toe]!=='estimated').map(f=>sub(f.points[toe],f.points[ankle]));
  let direction=offsets.length?[0,1,2].map(k=>median(offsets.map(p=>p[k]))):null;
  if(!direction||dist(direction,[0,0,0])<.015*scale){
   const noseDx=median(frames.map(f=>f.points.nose&&f.points.leftShoulder&&f.points.rightShoulder?f.points.nose[0]-(f.points.leftShoulder[0]+f.points.rightShoulder[0])/2:0));
   direction=Math.abs(noseDx)>.015*scale?[Math.sign(noseDx)*.142*scale,-.049*scale,0]:[0,-.049*scale,.142*scale];
  }
  for(const f of frames){
   if(!f.points[ankle])continue;
   if(!f.points[toe]){f.points[toe]=add(f.points[ankle],direction);f.jointSources[toe]='estimated';}
  }
  if(!lock)continue;
  const raw=frames.map(f=>({p:f.points[ankle]?.slice(),toe:f.points[toe]?.slice(),heel:f.points[heel]?.slice()}));
  let anchor=null,run=[];
  for(let i=0;i<frames.length;i++){
   const f=frames[i],p=raw[i].p;if(!p)continue;f.contacts??={};
   if(f.held){f.contacts[side]=!!anchor;continue;}
   const dt=i?f.time-frames[i-1].time:0,velocity=i&&raw[i-1].p&&dt>0?dist(p,raw[i-1].p)/dt:0;
   if(dt>.25||velocity>.18*scale||anchor&&(dist(p,anchor.p)>.028*scale||dist(raw[i].toe,anchor.toe)>.035*scale)){anchor=null;run=[];}
   if(!anchor){
    if((f.confidence[ankle]??0)>=.45){run.push(i);while(run.length&&f.time-frames[run[0]].time>.5)run.shift();}
    else run=[];
    if(run.length>=4&&f.time-frames[run[0]].time>=.3){
     const centre=[0,1,2].map(k=>median(run.map(j=>raw[j].p[k])));
     if(run.every(j=>dist(raw[j].p,centre)<.012*scale)&&velocity<.09*scale){
      anchor={p:centre,toe:[0,1,2].map(k=>median(run.map(j=>raw[j].toe[k]))),since:f.time};
      if(raw[i].heel)anchor.heel=[0,1,2].map(k=>median(run.map(j=>raw[j].heel?.[k])));
     }
    }
   }
   f.contacts[side]=!!anchor;
   if(anchor){const blend=clamp((f.time-anchor.since)/.1);f.points[ankle]=mix(p,anchor.p,blend);f.points[toe]=mix(raw[i].toe,anchor.toe,blend);if(raw[i].heel&&anchor.heel)f.points[heel]=mix(raw[i].heel,anchor.heel,blend);contactCounts[side]++;}
  }
 }
 return contactCounts;
}
export function snapshotPose(f){return {...f,points:clone(f.points),jointSources:{...f.jointSources},confidence:{...f.confidence}};}
