// SPDX-License-Identifier: AGPL-3.0-or-later
import {analyseVideo} from './pose.mjs';
import {toCoco17} from './coco17.mjs';
const EDGES=[[15,13],[13,11],[16,14],[14,12],[11,12],[5,11],[6,12],[5,6],[5,7],[6,8],[7,9],[8,10],[0,5],[0,6]];
export function setup({applyTrack,video}){
 const $=id=>document.getElementById(id);let controller=null;
 $('vrun').textContent='Track video locally (MediaPipe)';
 $('vrun').title='This lightweight local launcher uses the bundled browser detector. The full Flask app retains ViTPose.';
 const note=document.createElement('p');note.className='control-help';note.textContent='Local preview · bundled examples use the original ViTPose tracks. New clips use MediaPipe in your browser.';
 $('vrun').parentElement.append(note);
 const home=document.createElement('a');home.href='./squat/';home.textContent='Squat review →';home.style.cssText='margin-left:auto;padding:8px;font-size:12px';document.querySelector('.tabs').append(home);
 $('run').disabled=true;$('run').textContent='Image inference needs the full Flask app';
 $('vrun').onclick=async()=>{
  if(controller)return;
  if(!video.src||!Number.isFinite(video.duration)){ $('vstatus').textContent='Choose a video first.';return; }
  video.pause();controller=new AbortController();$('vrun').disabled=true;$('vcancel').style.display='';
  $('vfile').disabled=true;$('vexample').disabled=true;
  try{
   const session=await analyseVideo(video,{fps:20,signal:controller.signal,onProgress:(p,msg)=>{$('vstatus').textContent=msg;}});
   const keypoints={};session.frames.forEach((f,i)=>{keypoints[String(i)]=f.landmarks.length?{'0':toCoco17(f.landmarks,session.width,session.height)}:{};});
   applyTrack({keypoints,anatomyFrames:session.frames,meta:{width:session.width,height:session.height,fps:20,frame_count:session.frames.length,
    frame_indices:session.frames.map((f,i)=>i),frame_times_ms:session.frames.map(f=>f.t*1000),frame_stride:1,
    frames_processed:session.frames.length,skeleton:EDGES,equipment:null,source:'mediapipe-local',tracks:{kept:'0',kept_frames:session.frames.filter(f=>f.landmarks.length).length,dropped:[]}}});
   video.currentTime=0;$('vstatus').textContent='Local pose ready. Play the clip; enable Anatomy above the video.';
  }catch(e){$('vstatus').textContent=e.name==='AbortError'?'Tracking cancelled.':e.message;}
  finally{controller=null;$('vrun').disabled=false;$('vcancel').style.display='none';$('vfile').disabled=false;$('vexample').disabled=false;}
 };
 $('vcancel').onclick=()=>controller?.abort();
}
