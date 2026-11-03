// SPDX-License-Identifier: AGPL-3.0-or-later
/** Adapter for squat review. Uses detector landmarks only, never the display's
 * occlusion fill, fitted limbs, or manually edited spine points. */
import {COCO17_FROM_MP33 as COCO_TO_MP,toCoco17} from '../pose/coco17.mjs';
export function trackSession(data){
 const {meta,keypoints}=data,ids=meta.frame_indices?.length?meta.frame_indices:Object.keys(keypoints).map(Number).sort((a,b)=>a-b);
 const frames=ids.map((id,i)=>{
  const t=(meta.frame_times_ms?.[i]??id/(meta.fps||30)*1000)/1000;
  const source=keypoints[String(id)],raw=source?.[String(meta.tracks?.kept)]??Object.values(source??{})[0];
  if(!raw)return {t,idx:id,landmarks:[],equipment:meta.equipment?.[String(id)]??null};
  const landmarks=Array.from({length:33},()=>({x:0,y:0,visibility:0}));
  COCO_TO_MP.forEach((mp,k)=>{const p=raw[k];if(p?.every(Number.isFinite))landmarks[mp]={x:p[1]/meta.width,y:p[0]/meta.height,visibility:Math.max(0,Math.min(1,p[2]))};});
  return {t,idx:id,landmarks,equipment:meta.equipment?.[String(id)]??null};
 }).sort((a,b)=>a.t-b.t);
 return {width:meta.width,height:meta.height,fps:meta.fps||30,duration:frames.at(-1)?.t||1,source:meta.source||'detector-track',frames};
}

export function sessionTrack(session){
 const keypoints={};session.frames.forEach((f,i)=>{keypoints[f.idx??i]=f.landmarks.length?{0:toCoco17(f.landmarks,session.width,session.height)}:{};});
 return {keypoints,anatomyFrames:session.frames,meta:{width:session.width,height:session.height,fps:session.fps||20,frame_count:Math.round((session.duration||1)*(session.fps||20)),frame_indices:session.frames.map((f,i)=>f.idx??i),frame_times_ms:session.frames.map(f=>f.t*1000),frame_stride:1,equipment:Object.fromEntries(session.frames.map((f,i)=>[f.idx??i,f.equipment]).filter(([,equipment])=>equipment)),skeleton:[[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]],tracks:{kept:'0'},source:session.source}};
}
