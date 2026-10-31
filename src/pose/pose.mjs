// Bundled MediaPipe Pose, processed entirely in this browser.
let scriptPromise;
function loadRuntime(){
  if(window.Pose)return Promise.resolve();
  if(!scriptPromise)scriptPromise=new Promise((resolve,reject)=>{
    const s=document.createElement('script');s.src=new URL('./vendor/mediapipe-pose/pose.js',import.meta.url).href;
    s.onload=()=>window.Pose?resolve():reject(new Error('The local pose runtime did not initialise.'));
    s.onerror=()=>{scriptPromise=null;s.remove();reject(new Error('Pose files are missing. Extract the entire ZIP, then launch run_squat.py.'));};
    document.head.appendChild(s);
  });
  return scriptPromise;
}
const aborted=signal=>{if(signal?.aborted)throw new DOMException('Analysis cancelled','AbortError');};
export async function seekVideo(video,time,signal){
  aborted(signal);
  const target=Math.min(Math.max(0,time),Math.max(0,video.duration-.002));
  if(Math.abs(video.currentTime-target)<.0001&&video.readyState>=2)return;
  await new Promise((resolve,reject)=>{
    let timeout;
    const cleanup=()=>{clearTimeout(timeout);video.removeEventListener('seeked',done);video.removeEventListener('error',fail);signal?.removeEventListener('abort',cancel);};
    const done=()=>{cleanup();resolve();};
    const fail=()=>{cleanup();reject(new Error('Cannot decode this video. Try an H.264 MP4 in Chrome or Edge.'));};
    const cancel=()=>{cleanup();reject(new DOMException('Analysis cancelled','AbortError'));};
    video.addEventListener('seeked',done,{once:true});video.addEventListener('error',fail,{once:true});signal?.addEventListener('abort',cancel,{once:true});
    timeout=setTimeout(()=>{cleanup();reject(new Error('Seeking this video timed out. Try a shorter MP4 clip.'));},15000);
    video.currentTime=target;
  });
}
export async function analyseVideo(video,{fps=20,signal,onProgress=()=>{}}={}){
  if(!Number.isFinite(video.duration)||video.duration<1||video.duration>90)
    throw new Error('Choose a clip between 1 and 90 seconds. Trim it around the movement first.');
  await loadRuntime();aborted(signal);
  const pose=new window.Pose({locateFile:file=>new URL(`./vendor/mediapipe-pose/${file}`,import.meta.url).href});
  const canvas=document.createElement('canvas'),scale=Math.min(1,960/Math.max(video.videoWidth,video.videoHeight));
  canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
  const ctx=canvas.getContext('2d',{alpha:false});let result=null;
  pose.setOptions({modelComplexity:1,smoothLandmarks:true,enableSegmentation:false,minDetectionConfidence:.6,minTrackingConfidence:.6,selfieMode:false});
  pose.onResults(r=>{result=r;});
  const frames=[],count=Math.ceil(video.duration*fps);
  const originalTime=video.currentTime;video.pause();
  try{
    onProgress(0,'Loading the bundled pose detector…');
    await pose.initialize();aborted(signal);
    for(let i=0;i<count;i++){
      const t=i/fps;aborted(signal);await seekVideo(video,t,signal);
      ctx.drawImage(video,0,0,canvas.width,canvas.height);result=null;
      await pose.send({image:canvas},t*1000);aborted(signal);
      frames.push({t,landmarks:result?.poseLandmarks?.map(p=>({x:p.x,y:p.y,z:p.z??0,visibility:p.visibility??0}))??[],
        world:result?.poseWorldLandmarks?.map(p=>({x:p.x,y:p.y,z:p.z,visibility:p.visibility??0}))??[]});
      onProgress((i+1)/count,`Analysing locally · ${i+1} / ${count} frames`);
      if(i%3===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
  }finally{
    await pose.close().catch(()=>{});canvas.width=0;canvas.height=0;
    if(!signal?.aborted)await seekVideo(video,Math.min(originalTime,video.duration-.002)).catch(()=>{});
  }
  return{schemaVersion:1,source:'video',label:'Local video',duration:video.duration,width:video.videoWidth,height:video.videoHeight,fps,
    detector:'MediaPipe Pose 0.5.1675469404 · full model',frames};
}
