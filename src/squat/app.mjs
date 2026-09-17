import {GROUPS,clamp,analyseSession,explainRep,demoSession,validateSession} from './analysis.mjs';
import {AnatomyViewer,activationColour} from './anatomy.mjs';
import {analyseVideo} from './pose.mjs';
import {fromMediaPipe,withAnchors,calibrateLengths,fitPose,DEFAULT_ROM,ANCHORS,nearestManual,cleanAnchorTrack} from '../anatomy/pose-rig.mjs';
import {buildSequence,mediaPipeEntries} from '../anatomy/sequence.mjs';
import {trackSession,sessionTrack} from '../anatomy/track-session.mjs';
import {mountOriginalTools} from './original-tools.mjs';
const $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const fmt=t=>`${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
const groupName=id=>GROUPS.find(g=>g[0]===id)?.[1]??id;
const EXERCISES={squat:'Squat','lateral-raise':'Lateral raise',snatch:'Snatch','clean-and-jerk':'Clean & jerk'};
let exercise='squat',originalTools=null,depthCandidate=null,sourceTrack=null;
let session=null,analysis=null,viewer=null,selectedRepId=1,time=0,playing=false,lastTick=0,lastFrameIndex=-1;
let rigFrames=[],sequence=null,calibration=null,anchorMarks={},placingAnchor=false;
let videoURL=null,videoFile=null,hasVideo=false,busy=false,controller=null,feedback=new Map(),feedbackRepId=null,clipGeneration=0;
const video=$('video'),poseCanvas=$('pose-canvas'),ctx=poseCanvas.getContext('2d');
function status(message,error=false){$('status').textContent=message;$('status').classList.toggle('error',error);}
function options(){return{view:$('camera-view').value,side:$('tracking-side').value};}
function setPlaying(value){playing=value;$('play').textContent=value?'Ⅱ':'▶';$('play').setAttribute('aria-label',value?'Pause':'Play');if(hasVideo){if(value)video.play().catch(e=>{setPlaying(false);status(e.message,true);});else video.pause();}}
function setBusy(value){
  busy=value;for(const id of ['demo','import-button','video-file','camera-view','tracking-side','sample-rate','lab-example'])$(id).disabled=value;
  $('analyse').disabled=value||!hasVideo;$('cancel').hidden=!value;$('progress').hidden=!value;
  for(const id of ['play','step-back','step-forward','timeline','feedback-open','export'])$(id).disabled=value||!session;
  document.querySelector('.upload-label').style.pointerEvents=value?'none':'';
}
function currentRep(){return analysis?.reps.find(r=>r.id===selectedRepId);}
function setSession(data,{restoreFeedback=null}={}){
  placingAnchor=false;poseCanvas.style.pointerEvents='';poseCanvas.style.cursor='';
  depthCandidate=null;viewer?.setBarbell({gripTime:null});sourceTrack=data.rawTrack??sessionTrack(data);
  session=validateSession(data);analysis=analyseSession(session,options());feedback=restoreFeedback??new Map();selectedRepId=analysis.reps[0]?.id??0;
  rigFrames=session.frames.map(f=>fromMediaPipe(f,session.width,session.height));
  anchorMarks={};calibration=calibrateLengths(rigFrames,romLimits());rebuildSequence();
  time=0;lastFrameIndex=-1;$('timeline').max=Math.max(session.duration??0,session.frames.at(-1).t);
  const demo=session.source==='demo';
  $('source-name').textContent=session.label??'Pose track';
  $('source-badge').textContent=demo?'ILLUSTRATIVE DEMO':hasVideo?'YOUR VIDEO':'IMPORTED TRACK';
  $('source-badge').className=`badge ${demo?'amber':'teal'}`;
  $('demo-watermark').hidden=hasVideo;
  $('demo-watermark').replaceChildren(document.createTextNode(demo?'ILLUSTRATIVE MOTION':'POSE TRACK'),el('span',demo?'No lifter video loaded':'Original video not loaded'));
  $('quality-value').textContent=`${Math.round(analysis.coverage*100)}%`;
  renderRepButtons();renderTrace();renderReview();setBusy(false);seek(0);
  originalTools?.setTrack(sourceTrack);$('lab-diagnostic-empty').hidden=true;updateExerciseUI();
  status(demo?'Demo uses synthetic motion. Choose your video for a personal review.':analysis.warnings[0]??'Analysis ready. Scrub the clip, choose a rep, and add what you felt.');
}
function recalculate(){
  if(!session)return;analysis=analyseSession(session,options());feedback.clear();selectedRepId=analysis.reps[0]?.id??0;lastFrameIndex=-1;
  $('quality-value').textContent=`${Math.round(analysis.coverage*100)}%`;renderRepButtons();renderTrace();renderReview();renderFrame();
  status(analysis.warnings[0]??'Measurements recalculated. Rep feedback was cleared because the tracking settings changed.');
}
function detachVideo(){clipGeneration++;setPlaying(false);hasVideo=false;videoFile=null;video.removeAttribute('src');video.load();video.hidden=true;if(videoURL){URL.revokeObjectURL(videoURL);videoURL=null;}}
function loadDemo(){detachVideo();$('camera-view').value='side';$('tracking-side').value='auto';setSession(demoSession());}
async function openVideo(file){
  placingAnchor=false;poseCanvas.style.pointerEvents='';poseCanvas.style.cursor='';
  if(!file||busy)return;
  if(file.size>500*1024*1024){status('Choose a video smaller than 500 MB.',true);return;}
  detachVideo();originalTools?.reset();sourceTrack=null;depthCandidate=null;session=null;analysis=null;sequence=null;feedback.clear();time=0;lastFrameIndex=-1;
  const generation=clipGeneration;
  videoFile=file;videoURL=URL.createObjectURL(file);video.src=videoURL;video.hidden=false;
  $('demo-watermark').hidden=true;$('source-name').textContent=file.name;$('source-badge').textContent='VIDEO READY';$('source-badge').className='badge teal';
  $('rep-buttons').replaceChildren();$('rep-empty').hidden=false;$('motion-trace').replaceChildren();$('quality-value').textContent='—';renderReview();renderActivity(null);viewer?.setPose(null);setBusy(false);$('analyse').disabled=true;
  status('Opening local video…');
  try{
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error('Video metadata timed out. Try H.264 MP4.'));},12000);
      const cleanup=()=>{clearTimeout(timer);video.removeEventListener('loadeddata',done);video.removeEventListener('error',fail);};
      const done=()=>{cleanup();resolve();};const fail=()=>{cleanup();reject(new Error('This video format could not be decoded. Try H.264 MP4.'));};
      video.addEventListener('loadeddata',done,{once:true});video.addEventListener('error',fail,{once:true});
    });
    if(generation!==clipGeneration)return;
    if(!Number.isFinite(video.duration)||video.duration>90||video.duration<1)throw new Error('Trim your clip to between 1 and 90 seconds.');
    hasVideo=true;$('analyse').disabled=false;$('timeline').max=video.duration;resizePose();drawPose(null);
    status('Video ready. Confirm the camera view, then select Analyse video.');
  }catch(e){if(generation===clipGeneration){status(e.message,true);$('analyse').disabled=true;}}
}
async function runAnalysis(){
  if(!hasVideo||busy)return;setPlaying(false);setBusy(true);controller=new AbortController();
  // Never show an old analysis over a new in-progress pass.
  session=null;analysis=null;sequence=null;feedback.clear();renderReview();renderActivity(null);
  viewer?.setPose(null);$('rep-buttons').replaceChildren();$('rep-empty').hidden=false;$('motion-trace').replaceChildren();$('quality-value').textContent='—';
  try{
    const result=await analyseVideo(video,{fps:Number($('sample-rate').value),signal:controller.signal,onProgress:(p,msg)=>{$('progress').value=p;status(msg);}});
    result.label=videoFile.name;setSession(result);
  }catch(e){status(e.name==='AbortError'?'Analysis cancelled. Your video is still available.':`Analysis failed: ${e.message}`,e.name!=='AbortError');}
  finally{controller=null;setBusy(false);}
}
function frameAt(t){
  if(!analysis)return[-1,null];const a=analysis.frames;let lo=0,hi=a.length-1;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(a[mid].t<t)lo=mid+1;else hi=mid;}
  if(lo>0&&Math.abs(a[lo-1].t-t)<Math.abs(a[lo].t-t))lo--;
  return[lo,Math.abs(a[lo].t-t)>.25?null:a[lo]];
}
function seek(t){
  if(busy)return;const end=Number($('timeline').max)||0;time=clamp(t,0,end);
  if(hasVideo&&Number.isFinite(video.duration))video.currentTime=Math.min(time,Math.max(0,video.duration-.003));
  const found=analysis?.reps.find(r=>time>=r.startTime&&time<=r.endTime);
  if(found&&found.id!==selectedRepId){selectedRepId=found.id;renderRepButtons();renderReview();}
  lastFrameIndex=-1;renderFrame();
}
function renderFrame(){
  const [i,f]=frameAt(time);$('timeline').value=time;$('time-display').textContent=`${fmt(time)} / ${fmt(Number($('timeline').max)||0)}`;
  lastFrameIndex=i;
  $('knee-value').textContent=f?.valid?`${Math.round(f.knee)}°`:'—';$('trunk-value').textContent=f?.valid?`${Math.round(f.trunk)}°`:'—';
  $('phase-badge').textContent=exercise!=='squat'?'MOVEMENT':f?.valid?f.phase.toUpperCase():analysis?'UNTRACKED':'READY';
  const validForModel=exercise==='squat'&&f?.valid&&analysis?.view!=='front';
  let pose=sequence?.sample(time)??null;
  if(pose)pose=withAnchors(pose,nearestManual(anchorMarks,time),$('articulate-spine').checked);
  if(pose)pose.activation=validForModel?f.activation:null;
  viewer?.setPose(pose);
  const fitted=Object.keys(calibration?.chains??{}).length;
  $('fit-note').textContent=!$('fit-limbs').checked?'Camera-aligned pose; stabilization and foot contact may adjust display positions slightly.':fitted?'Fitted world-space lengths guide depth. Display stabilization remains separate.':'No usable 3D track for fitting; keeping the display prior.';
  if(viewer)$('model-state').textContent=pose?pose.held?'Tracking lost · complete pose held':`${pose.estimatedJoints?.length||0} inferred joints · ${Object.values(pose.contacts??{}).filter(Boolean).length} feet held`:'No tracked body';
  renderActivity(validForModel?f.activation:null);drawPose(f);originalTools?.draw(time);
  $('barbell-status').textContent=viewer?.barSource??'No bar detected. Select a placement if a barbell is present.';
  const grip=viewer?.pose?.grip;
  $('grip-status').textContent=!$('lock-hands').checked?'Hands follow the pose track.':grip?.lockedSides.length?`${grip.lockedSides.length} hand(s) held on the bar · estimated grip${grip.releasedSides.length?' · unreachable side released':''}`:viewer?.barSource?'Grip could not be fitted at this frame.':'Grip locking needs a bar. Choose its placement above.';
  const cursor=$('trace-cursor');if(cursor)cursor.setAttribute('x1',1000*time/Number($('timeline').max)),cursor.setAttribute('x2',1000*time/Number($('timeline').max));
}
function resizePose(){const r=$('video-stage').getBoundingClientRect();poseCanvas.width=Math.round(r.width*devicePixelRatio);poseCanvas.height=Math.round(r.height*devicePixelRatio);lastFrameIndex=-1;renderFrame();}
function drawPose(f){
  const w=poseCanvas.width,h=poseCanvas.height;ctx.clearRect(0,0,w,h);
  const width=session?.width??video.videoWidth??720,height=session?.height??video.videoHeight??720;
  const scale=Math.min(w/(width||720),h/(height||720)),dw=(width||720)*scale,dh=(height||720)*scale,ox=(w-dw)/2,oy=(h-dh)/2;
  if(!hasVideo&&(!$('enable-anatomy').checked||$('anatomy-layout').value!=='overlay')){
    ctx.fillStyle='#101d26';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#203440';ctx.lineWidth=devicePixelRatio*.6;
    for(let x=0;x<w;x+=35*devicePixelRatio){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
    for(let y=0;y<h;y+=35*devicePixelRatio){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  }
  if(!f?.landmarks?.length||!$('pose-overlay').checked&&hasVideo)return;
  const pts=f.landmarks.map(p=>({x:ox+p.x*dw,y:oy+p.y*dh,v:p.visibility??0}));
  const edges=[[11,12],[11,23],[12,24],[23,24],[11,13],[13,15],[12,14],[14,16],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[28,30],[30,32]];
  if(!hasVideo&&!$('enable-anatomy').checked){
    ctx.lineCap='round';ctx.strokeStyle='#344e59';ctx.lineWidth=21*devicePixelRatio;
    for(const [a,b] of edges.slice(2,14)){ctx.beginPath();ctx.moveTo(pts[a].x,pts[a].y);ctx.lineTo(pts[b].x,pts[b].y);ctx.stroke();}
    const head=pts[0];ctx.fillStyle='#48616a';ctx.beginPath();ctx.ellipse(head.x,head.y,17*devicePixelRatio,21*devicePixelRatio,0,0,Math.PI*2);ctx.fill();
  }
  ctx.lineWidth=2*devicePixelRatio;ctx.lineCap='round';
  for(const [a,b] of edges){if(pts[a].v<.45||pts[b].v<.45)continue;ctx.strokeStyle=f.valid?'#9fdfc3':'#a48a6c';ctx.beginPath();ctx.moveTo(pts[a].x,pts[a].y);ctx.lineTo(pts[b].x,pts[b].y);ctx.stroke();}
  drawAnchorMarks(f,{w,h,dw,dh,ox,oy});
  for(const i of [11,12,13,14,15,16,23,24,25,26,27,28,29,30,31,32]){if(pts[i].v<.45)continue;ctx.fillStyle='#d0f5e4';ctx.beginPath();ctx.arc(pts[i].x,pts[i].y,3*devicePixelRatio,0,Math.PI*2);ctx.fill();}
}
function renderActivity(activation){
  const visible=$('show-activation').checked;
  for(const [id] of GROUPS){const row=$(`activity-${id}`),v=activation?.[id];
    row.querySelector('i').style.width=visible&&Number.isFinite(v)?`${v*100}%`:'0%';
    row.querySelector('i').style.background=Number.isFinite(v)?`#${activationColour(v).getHexString()}`:'#344e59';
    row.querySelector('.level').textContent=!visible?'Hidden':!Number.isFinite(v)?'Unavailable':v<.3?'Low':v<.62?'Moderate':'High';
  }
  $('activity-note').textContent=exercise!=='squat'?'Activation estimates are currently available for squats only':!visible?'Activation display is off':activation?'Synced to the selected frame':'Waiting for usable motion data';
}
function focusMuscle(id,name){
  $('isolate').value=id;viewer?.isolate(id);
  for(const [g] of GROUPS)$(`activity-${g}`).classList.toggle('selected',g===id);
  $('muscle-tooltip').hidden=id==='all';$('muscle-tooltip').textContent=name??groupName(id);
}
function renderRepButtons(){
  $('rep-buttons').replaceChildren();$('rep-empty').hidden=!!analysis?.reps.length;
  for(const r of analysis?.reps??[]){const b=el('button',`Rep ${r.id}`,'rep-button');b.classList.toggle('active',r.id===selectedRepId);b.setAttribute('aria-pressed',String(r.id===selectedRepId));b.append(el('span',r.status==='complete'?'Completed':r.status==='tracking-gap'?'Tracking gap':'Incomplete'));b.onclick=()=>{setPlaying(false);selectedRepId=r.id;seek(r.bottomTime);renderRepButtons();renderReview();};$('rep-buttons').append(b);}
}
function renderTrace(){
  const svg=$('motion-trace');svg.replaceChildren();if(!analysis)return;
  const ns='http://www.w3.org/2000/svg',duration=Number($('timeline').max)||1;
  const path=document.createElementNS(ns,'path');let d='',pen=false;
  for(const f of analysis.frames){if(!f.valid){pen=false;continue;}d+=`${pen?'L':'M'}${(f.t/duration*1000).toFixed(1)},${(61-clamp(f.knee/150)*55).toFixed(1)} `;pen=true;}
  path.setAttribute('d',d);path.setAttribute('fill','none');path.setAttribute('stroke','#83c5aa');path.setAttribute('stroke-width','1.8');path.setAttribute('vector-effect','non-scaling-stroke');svg.append(path);
  for(const r of analysis.reps){const line=document.createElementNS(ns,'line');line.setAttribute('x1',r.bottomTime/duration*1000);line.setAttribute('x2',r.bottomTime/duration*1000);line.setAttribute('y1','3');line.setAttribute('y2','65');line.setAttribute('stroke','#456875');line.setAttribute('stroke-dasharray','3 4');svg.append(line);}
  const cursor=document.createElementNS(ns,'line');cursor.id='trace-cursor';cursor.setAttribute('y1','0');cursor.setAttribute('y2','65');cursor.setAttribute('stroke','#e6ba83');svg.append(cursor);
}
function renderReview(){
  const rep=currentRep(),report=feedback.get(selectedRepId)??{};
  $('review-rep').textContent=rep?`REP ${rep.id}`:'NO REP';$('observations').replaceChildren();$('hypotheses').replaceChildren();$('feedback-open').disabled=exercise!=='squat'||!rep||busy;
  if(!analysis||!rep){$('analysis-summary').textContent='Analyse a side-view squat clip to review movement evidence.';$('feedback-summary').textContent='Select an analysed rep to add feedback.';$('quality-warnings').hidden=true;return;}
  const result=explainRep(analysis,rep,report);$('analysis-summary').textContent=result.summary;
  for(const o of result.observations){const p=el('div',undefined,'observation'),b=el('button',`${o.time.toFixed(1)}s`,'time-link');b.onclick=()=>{setPlaying(false);seek(o.time);};p.append(b,el('span',o.text));$('observations').append(p);}
  if(!result.observations.length)$('observations').append(el('p','Not enough reliable motion evidence for this rep.'));
  for(const h of result.hypotheses){const box=el('div',undefined,'hypothesis');box.append(el('strong',h.label));if(h.reportSupport)box.append(el('div','Also reported by lifter · supporting context','report-tag'));box.append(el('p',h.evidence),el('p',h.alternatives));const details=el('details');details.append(el('summary','What to check / possible accessory work'),el('p',h.next));box.append(details);$('hypotheses').append(box);}
  if(result.unmatched?.length)$('hypotheses').append(el('p',`You reported ${result.unmatched.map(groupName).join(', ')}. The current video rules do not independently support those groups as the limiter.`));
  const warnings=[...analysis.warnings];if(session.source==='demo')warnings.unshift('Illustrative demo: these are synthetic movements, not findings about you.');if(rep.startsMidRep)warnings.push('The clip may start partway through this rep; its beginning is incomplete.');
  $('quality-warnings').hidden=!warnings.length;$('quality-warnings').textContent=warnings.join(' ');
  if(feedback.has(selectedRepId)){
    const outcome={complete:'Completed',failed:'Reported failed rep',stopped:'Stopped intentionally',unsure:'Outcome unsure'}[report.outcome]??'Outcome unsure';
    $('feedback-summary').textContent=`${outcome} · ${report.unsure?'Whole-body fatigue / unsure':report.groups?.length?report.groups.map(groupName).join(', '):'No muscle group selected'}`;
    $('feedback-open').textContent='Edit lifter feedback';
  }else{$('feedback-summary').textContent='No feedback for this rep yet.';$('feedback-open').textContent='Add lifter feedback ＋';}
}
function openFeedback(){
  if(!currentRep())return;setPlaying(false);feedbackRepId=selectedRepId;const f=feedback.get(feedbackRepId)??{};
  $('feedback-rep-label').textContent=`REP ${feedbackRepId}`;
  document.querySelectorAll('input[name=outcome]').forEach(x=>x.checked=x.value===(f.outcome??'unsure'));
  document.querySelectorAll('input[name=muscle]').forEach(x=>x.checked=f.groups?.includes(x.value)??false);
  $('feedback-unsure').checked=!!f.unsure;$('feedback-notes').value=f.notes??'';$('feedback-dialog').showModal();
}
function exportSession(){
  if(!session)return;
  const payload={format:'coach-squat-session',version:1,exportedAt:new Date().toISOString(),track:session,settings:{...options(),exercise},
    feedback:Object.fromEntries(feedback),anatomy:{anchorMarks,limits:romLimits(),fit:$('fit-limbs').checked},analysis:{method:'provisional-squat-rules-v1',activation:'uncalibrated-relative-index',reps:analysis.reps,coverage:analysis.coverage},
    notes:'Video is not included. Spine motion is inferred. Activation indices are not EMG, %MVC, forces, or probabilities.'};
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload)],{type:'application/json'}));const a=el('a');a.href=url;a.download='coach-squat-session.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
async function importTrack(file){
  if(!file)return;try{
    if(file.size>40*1024*1024)throw new Error('Track files must be smaller than 40 MB.');
    const data=JSON.parse(await file.text());if(data.keypoints&&data.meta){detachVideo();setSession({...trackSession(data),rawTrack:data,label:'Imported original track'});return;}const track=data.track??data;validateSession(track);
    if(EXERCISES[data.settings?.exercise])setExercise(data.settings.exercise);
    detachVideo();if(['side','oblique','front'].includes(data.settings?.view))$('camera-view').value=data.settings.view;
    if(['auto','left','right'].includes(data.settings?.side))$('tracking-side').value=data.settings.side;
    const clean=new Map();for(const [id,f] of Object.entries(data.feedback??{})){if(!f||typeof f!=='object')continue;
      clean.set(Number(id),{groups:(Array.isArray(f.groups)?f.groups:[]).filter(x=>GROUPS.some(g=>g[0]===x)).slice(0,3),outcome:['complete','failed','stopped','unsure'].includes(f.outcome)?f.outcome:'unsure',unsure:!!f.unsure,notes:String(f.notes??'').slice(0,1000)});}
    setSession({...track,label:typeof track.label==='string'?track.label.slice(0,200):'Imported pose track'}, {restoreFeedback:clean});
    if(data.anatomy?.anchorMarks)anchorMarks=cleanAnchorTrack(data.anatomy.anchorMarks);
    for(const id of ['knee','elbow']){const v=data.anatomy?.limits?.[id];if(Number.isFinite(v)&&v>=90&&v<=180)$(`rom-${id}`).value=v;}
    $('fit-limbs').checked=!!data.anatomy?.fit;calibration=calibrateLengths(rigFrames,romLimits());rebuildSequence();lastFrameIndex=-1;renderFrame();
  }catch(e){status(`Cannot open this track: ${e.message}`,true);}
}
for(const [id,name] of GROUPS){
  const option=el('option',name);option.value=id;$('isolate').append(option);
  const b=el('button',undefined,'activity-row');b.id=`activity-${id}`;b.setAttribute('aria-label',`Focus ${name}`);
  const label=el('div',undefined,'activity-label');label.append(el('span',name),el('span','Low','level'));const bar=el('div',undefined,'activity-bar');bar.append(el('i'));b.append(label,bar);b.onclick=()=>focusMuscle($('isolate').value===id?'all':id);$('activation-bars').append(b);
  const choice=el('label'),input=el('input');input.type='checkbox';input.name='muscle';input.value=id;choice.append(input,document.createTextNode(name));$('feedback-groups').append(choice);
  input.onchange=()=>{if(document.querySelectorAll('input[name=muscle]:checked').length>3)input.checked=false;if(input.checked)$('feedback-unsure').checked=false;};
}
function romLimits(){const read=id=>{const v=Number($(`rom-${id}`).value);return Number.isFinite(v)&&v>=90&&v<=180?v:DEFAULT_ROM[id];};return {...DEFAULT_ROM,knee:read('knee'),elbow:read('elbow')};}
async function enableAnatomy(){
  const enabled=$('enable-anatomy').checked;
  document.querySelector('.workspace').classList.toggle('anatomy-off',!enabled);
  if(!enabled){placingAnchor=false;poseCanvas.style.pointerEvents='';poseCanvas.style.cursor='';}
  if(enabled&&!viewer){try{viewer=new AnatomyViewer($('anatomy'),{cameraAligned:true,onSelect:focusMuscle,onStatus:(msg,error)=>{$('model-state').textContent=msg;if(error)status(msg,true);}});await viewer.ready;viewer.setSequence(sequence);viewer.setOpacity(Number($('muscle-opacity').value));viewer.setBarbell({mode:$('barbell-mode').value,plates:$('barbell-plates').checked,lockHands:$('lock-hands').checked,gripScale:Number($('grip-width').value)});}catch(e){viewer?.dispose();viewer=null;$('enable-anatomy').checked=false;document.querySelector('.workspace').classList.add('anatomy-off');status(`Anatomy unavailable: ${e.message}`,true);}}
  // Read the current switch after loading; it may have changed while awaiting.
  const visible=$('enable-anatomy').checked;viewer?.setVisible(visible);
  if(visible)viewer?.configure({joints:$('show-joints').checked});
  setLayout();lastFrameIndex=-1;renderFrame();
}
$('enable-anatomy').onchange=enableAnatomy;
for(const [id,label] of ANCHORS){const o=el('option',label);o.value=id;$('anchor-choice').append(o);}
for(const id of ['fit-limbs','rom-knee','rom-elbow'])$(id).onchange=()=>{calibration=calibrateLengths(rigFrames,romLimits());rebuildSequence();lastFrameIndex=-1;renderFrame();};
$('mark-anchor').onclick=()=>{if(!session)return;setPlaying(false);placingAnchor=true;poseCanvas.style.pointerEvents='auto';poseCanvas.style.cursor='crosshair';status('Click the selected reference point in the paused movement view.');};
poseCanvas.addEventListener('click',e=>{
  if(!placingAnchor||!session)return;const r=poseCanvas.getBoundingClientRect(),scale=Math.min(r.width/session.width,r.height/session.height),dw=session.width*scale,dh=session.height*scale;
  const x=(e.clientX-r.left-(r.width-dw)/2)/dw,y=(e.clientY-r.top-(r.height-dh)/2)/dh;
  if(x<0||x>1||y<0||y>1)return;
  const p=sequence?.sample(time);if(!p)return;
  const world=withAnchors(p),id=$('anchor-choice').value;if(!world.points[id])return;
  const corrected=[(x-.5)*p.aspect,.5-y,world.points[id][2]];
  const key=String(Number(time.toFixed(4)));anchorMarks[key]??={};anchorMarks[key][id]=corrected;
  placingAnchor=false;poseCanvas.style.pointerEvents='';poseCanvas.style.cursor='';lastFrameIndex=-1;renderFrame();status('Point corrected for this frame. Export the session to save it. Depth remains inferred.');
});
$('reset-anchors').onclick=()=>{for(const k of Object.keys(anchorMarks))if(Math.abs(Number(k)-time)<=.12)delete anchorMarks[k];lastFrameIndex=-1;renderFrame();};
function drawAnchorMarks(f,{dw,dh,ox,oy}){
  if(!$('enable-anatomy').checked||!$('show-joints').checked||!f)return;
  const p=sequence?.sample(time);if(!p)return;
  const world=withAnchors(p,nearestManual(anchorMarks,time));if(!world.anchorsAvailable)return;
  ctx.font=`${11*devicePixelRatio}px system-ui`;
  for(const [id,label] of ANCHORS){const q=world.points[id];
    const x=ox+(q[0]/p.aspect+.5)*dw,y=oy+(.5-q[1])*dh;ctx.fillStyle=world.provenance[id]==='manual'?'#70c7ff':'#f2bc70';ctx.beginPath();ctx.arc(x,y,4*devicePixelRatio,0,Math.PI*2);ctx.fill();ctx.fillText(label,x+7*devicePixelRatio,y-5*devicePixelRatio);
  }
}
function rebuildSequence(){
  if(!session)return;
  const entries=mediaPipeEntries(session).map((e,i)=>({...e,pose:$('fit-limbs').checked?fitPose(rigFrames[i],calibration,romLimits()):rigFrames[i]}));
  sequence=buildSequence(entries,{candidate:depthCandidate,stabilize:$('stabilize-motion').checked,footLock:$('lock-feet').checked,depthMode:$('display-depth').value});
  viewer?.setSequence(sequence);
}
let previousLayout=null;
function setLayout(){
  const layout=$('anatomy-layout').value,overlay=layout==='overlay',model=layout==='model',enabled=$('enable-anatomy').checked;
  $('comparison-stage').hidden=overlay;document.querySelector('.video-panel').hidden=model&&enabled;
  $('display-explanation').textContent=overlay?'The model is drawn directly over the video.':model?'Video hidden. The same timeline plays the model; drag it to rotate.':'Video and model side by side, on the same timeline.';
  const workspace=document.querySelector('.workspace');workspace.classList.toggle('overlay-mode',overlay);workspace.classList.toggle('model-only-mode',model&&enabled);
  document.querySelectorAll('[data-display]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.display===layout)));
  const host=$('anatomy-on-video');host.hidden=!overlay||!enabled;
  if(viewer){(overlay?host:$('comparison-stage')).append($('anatomy'),viewer.labels);viewer.resizeObserver.observe(overlay?host:$('comparison-stage'));viewer.setLayout(overlay);if(layout!==previousLayout)viewer.setView(model?'front':'camera');viewer.setVisible(enabled);previousLayout=layout;}
}
$('anatomy-layout').onchange=()=>{setLayout();renderFrame();};
for(const b of document.querySelectorAll('[data-display]'))b.onclick=async()=>{$('anatomy-layout').value=b.dataset.display;if(!$('enable-anatomy').checked){$('enable-anatomy').checked=true;await enableAnatomy();}else{setLayout();renderFrame();}};
$('match-camera').onclick=()=>{viewer?.setView('camera');renderFrame();};
$('video-file').onchange=e=>{openVideo(e.target.files[0]);e.target.value='';};
$('demo').onclick=loadDemo;$('analyse').onclick=runAnalysis;$('cancel').onclick=()=>controller?.abort();
$('camera-view').onchange=recalculate;$('tracking-side').onchange=recalculate;
$('import-button').onclick=()=>$('track-file').click();$('track-file').onchange=e=>{importTrack(e.target.files[0]);e.target.value='';};
$('play').onclick=()=>{if(time>=Number($('timeline').max)-.1)seek(0);setPlaying(!playing);};
$('step-back').onclick=()=>{setPlaying(false);seek(time-1/(session?.fps??20));};$('step-forward').onclick=()=>{setPlaying(false);seek(time+1/(session?.fps??20));};
$('timeline').oninput=e=>{setPlaying(false);seek(Number(e.target.value));};$('speed').onchange=()=>{video.playbackRate=Number($('speed').value);};
$('trace-wrap').onclick=e=>{const r=$('motion-trace').getBoundingClientRect();setPlaying(false);seek((e.clientX-r.left)/r.width*Number($('timeline').max));};
$('pose-overlay').onchange=()=>{lastFrameIndex=-1;renderFrame();};
for(const [id,flag] of [['show-bones','bones'],['show-muscles','muscles'],['show-activation','activation'],['show-joints','joints'],['articulate-spine','spine']])$(id).onchange=e=>{viewer?.configure({[flag]:e.target.checked});lastFrameIndex=-1;renderFrame();};
$('isolate').onchange=e=>focusMuscle(e.target.value);$('muscle-opacity').oninput=e=>viewer?.setOpacity(Number(e.target.value));
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{viewer?.setView(b.dataset.view);document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('active',x===b));});
$('feedback-open').onclick=openFeedback;$('feedback-unsure').onchange=e=>{if(e.target.checked)document.querySelectorAll('input[name=muscle]').forEach(x=>x.checked=false);};
$('feedback-form').onsubmit=e=>{e.preventDefault();feedback.set(feedbackRepId,{groups:[...document.querySelectorAll('input[name=muscle]:checked')].map(x=>x.value),outcome:document.querySelector('input[name=outcome]:checked').value,unsure:$('feedback-unsure').checked,notes:$('feedback-notes').value.trim()});$('feedback-dialog').close();renderReview();};
$('clear-feedback').onclick=()=>{feedback.delete(feedbackRepId);$('feedback-dialog').close();renderReview();};
$('method-open').onclick=()=>{setPlaying(false);$('method-dialog').showModal();};
document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('export').onclick=exportSession;
video.addEventListener('ended',()=>setPlaying(false));video.addEventListener('seeked',()=>{if(!busy){time=video.currentTime;lastFrameIndex=-1;renderFrame();}});
new ResizeObserver(resizePose).observe($('video-stage'));
window.addEventListener('beforeunload',()=>{controller?.abort();if(videoURL)URL.revokeObjectURL(videoURL);});
function tick(now){
  const dt=Math.min(.1,(now-lastTick)/1000);lastTick=now;
  if(playing&&!busy){
    time=hasVideo?video.currentTime:time+dt*Number($('speed').value);
    if(time>=Number($('timeline').max)){time=Number($('timeline').max);setPlaying(false);}
    const rep=analysis?.reps.find(r=>time>=r.startTime&&time<=r.endTime);
    if(rep&&rep.id!==selectedRepId){selectedRepId=rep.id;renderRepButtons();renderReview();}
    renderFrame();
  }
  requestAnimationFrame(tick);
}
function updateExerciseUI(){
  const squat=exercise==='squat';document.body.dataset.exercise=exercise;
  $('exercise-heading').textContent=squat?'Understand your squat.':'Understand your '+EXERCISES[exercise].toLowerCase()+'.';
  $('exercise-subtitle').textContent=squat?'Follow the rep. Explore the muscles. Put what you felt in context.':'Your original movement diagnostics, with optional anatomy directly on the video.';
  $('squat-review').hidden=!squat;$('original-diagnostics').hidden=squat;
  $('original-diagnostics-title').textContent=EXERCISES[exercise]+' · movement diagnostics';
  document.querySelector('.metrics').hidden=!squat;document.querySelector('.video-panel>.panel-note').hidden=!squat;
  $('trace-wrap').hidden=!squat;$('rep-buttons').hidden=!squat;$('rep-empty').hidden=!squat||!!analysis?.reps.length;
  document.querySelectorAll('.exercise-tabs [data-exercise]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.exercise===exercise)));
  $('feedback-open').disabled=!squat||!currentRep()||busy;
}
function setExercise(id){if(!EXERCISES[id])return;exercise=id;originalTools?.setPage(id);updateExerciseUI();renderFrame();}
for(const b of document.querySelectorAll('.exercise-tabs [data-exercise]'))b.onclick=()=>setExercise(b.dataset.exercise);
for(const id of ['stabilize-motion','lock-feet','display-depth'])$(id).onchange=()=>{rebuildSequence();renderFrame();};
for(const id of ['barbell-mode','barbell-plates','lock-hands','grip-width'])$(id).onchange=()=>{viewer?.setBarbell({mode:$('barbell-mode').value,plates:$('barbell-plates').checked,lockHands:$('lock-hands').checked,gripScale:Number($('grip-width').value),...(id==='barbell-mode'?{gripTime:null}:{})});renderFrame();};
$('calibrate-grip').onclick=()=>{setPlaying(false);viewer?.setBarbell({gripTime:time});renderFrame();};
const diagCanvas=document.createElement('canvas'),diagCtx=diagCanvas.getContext('2d');
originalTools=mountOriginalTools({videoClock:()=>({get currentTime(){return time;},set currentTime(t){setPlaying(false);seek(t);},get duration(){return session?.duration||video.duration||1;}}),redraw:renderFrame,getExercise:()=>exercise,onDepth:c=>{depthCandidate=c;rebuildSequence();renderFrame();}});
fetch('/api/examples').then(r=>r.json()).then(examples=>{for(const ex of examples){const o=el('option',ex.label);o.value=ex.id;$('lab-example').append(o);}}).catch(()=>{});
$('lab-example').onchange=async()=>{const id=$('lab-example').value;if(!id||busy)return;detachVideo();setBusy(true);originalTools.reset();viewer?.setPose(null);status('Loading example…');
 try{const r=await fetch('/api/examples/'+id+'/track');if(!r.ok)throw Error('Example track could not load.');const raw=await r.json();
  video.src='/api/examples/'+id+'/video';video.hidden=false;hasVideo=true;setExercise(id.includes('lateral-raise')?'lateral-raise':id.includes('athlete-a')?'snatch':exercise);
  setSession({...trackSession(raw),rawTrack:raw,label:id.split('/').at(-1),source:'cached-example'});$('source-badge').textContent='CACHED VITPOSE';status('Original cached track loaded. Play the clip or inspect the diagnostic charts.');
 }catch(e){status(e.message,true);setBusy(false);}};
// Diagnostics use their own source-sized canvas, then share the exact video's
// contain rectangle with the landmarks and anatomical overlay.
const baseDrawPose=drawPose;
drawPose=function(f){baseDrawPose(f);if(!session||exercise==='squat'||!originalTools)return;
 const w=poseCanvas.width,h=poseCanvas.height;diagCanvas.width=session.width;diagCanvas.height=session.height;originalTools.overlay(diagCtx,time);const ratio=Math.min(w/session.width,h/session.height),dw=session.width*ratio,dh=session.height*ratio;ctx.drawImage(diagCanvas,(w-dw)/2,(h-dh)/2,dw,dh);
};
window.CoachLab={setExercise,setSession,setTrack(data){setSession({...trackSession(data),rawTrack:data});},seek,getState:()=>({exercise,sourceTrack,session,sequence,depthCandidate,viewer,originalTools})};
loadDemo();setExercise(new URLSearchParams(location.search).get('exercise')||'squat');setLayout();resizePose();requestAnimationFrame(tick);
