import {AnatomyViewer} from './viewer.mjs';
import {fromCoco,withAnchors,ANCHORS,cleanAnchorTrack,nearestManual} from './pose-rig.mjs';
import {buildSequence,trackEntries} from './sequence.mjs';

const $=id=>document.getElementById(id),settings=$('videoPanel')?.querySelector('.settings');
if(settings){
 const style=document.createElement('link');style.rel='stylesheet';style.href='/anatomy/shared.css';document.head.append(style);
 const toolbar=document.createElement('div');toolbar.id='anatomy-toolbar';toolbar.className='anatomy-toolbar';
 toolbar.innerHTML=`<label><input id="anatomy-enabled" type="checkbox"> Show anatomy</label><select id="anatomy-layout" hidden aria-label="Display mode"><option value="overlay">Video + model</option><option value="model">Model only</option><option value="comparison">Side by side</option></select><div class="view-modes" role="group" aria-label="Display mode"><button type="button" data-anatomy-display="overlay" aria-pressed="true">Video + model</button><button type="button" data-anatomy-display="model" aria-pressed="false">Model only</button><button type="button" data-anatomy-display="comparison" aria-pressed="false">Side by side</button></div><span class="anatomy-mode-note">One video with the model on top</span><button id="anatomy-camera" type="button">Match video camera</button>`;
 $('videoView').prepend(toolbar);
 const row=document.createElement('div');row.id='anatomy-comparison';$('videoWrap').before(row);row.append($('videoWrap'));
 const controls=document.createElement('details');controls.className='control-group';controls.id='anatomy-controls';
 controls.innerHTML=`<summary>Anatomy settings</summary><div id="anatomy-options" hidden>
 <label><input id="anatomy-bones" type="checkbox" checked> Bones</label>
 <label><input id="anatomy-muscles" type="checkbox" checked> Muscles</label>
 <label><input id="anatomy-anchors" type="checkbox"> Hip &amp; spine points</label>
 <label><input id="anatomy-stabilize" type="checkbox" checked> Stabilize motion</label>
 <label><input id="anatomy-foot-lock" type="checkbox" checked> Hold stationary feet</label>
 <label>Depth <select id="anatomy-depth"><option value="stable">Stable video alignment</option><option value="reconstruction">Reconstructed depth</option></select></label>
 <label>Barbell <select id="anatomy-barbell"><option value="auto">Detected equipment only</option><option value="off">Off</option><option value="hands">Present · held in hands</option><option value="back">Present · across upper back</option></select></label>
 <label><input id="anatomy-bar-plates" type="checkbox"> Show plates on placed bar</label>
 <label><input id="anatomy-lock-hands" type="checkbox" checked> Keep hands on bar</label><label>Grip width <input id="anatomy-grip-width" type="range" min="0.65" max="1.8" step="0.05" value="1" aria-label="Adjust estimated grip width"></label><button id="anatomy-calibrate-grip" type="button">Set grip from this frame</button><p id="anatomy-grip-status" class="control-help" role="status">Grip locking applies when a bar is present.</p>
 <p id="anatomy-bar-status" class="control-help">Automatic bars require equipment detection; manually placed bars are estimates.</p>
 <label>Overlay opacity <input id="anatomy-opacity" type="range" min=".15" max="1" step=".01" value=".65"></label>
 <p class="control-help">Blue-grey limbs are estimated while occluded. They stay attached; their hidden movement is uncertain.</p>
 <label>Correct a point <select id="anatomy-anchor"><option value="">Choose anchor…</option></select></label>
 <button id="anatomy-place" type="button">Mark on paused video</button><button id="anatomy-clear" type="button">Clear this frame</button>
 <p class="control-help">Amber = inferred spine point, blue = manually marked. A click corrects image position, not measured depth.</p>
 <div class="row"><button id="anatomy-export" type="button">Export points</button><button id="anatomy-import" type="button">Import points</button><input id="anatomy-file" type="file" accept="application/json,.json" hidden></div>
 <a href="/anatomy/models/ATTRIBUTION.md" target="_blank" rel="noopener">Anatomy credits</a> · <a href="/anatomy/ROM.md" target="_blank" rel="noopener">Joint-range notes</a>
 </div><p id="anatomy-status" class="control-help" role="status">Optional anatomy · uses the same video clock and 3D reconstruction.</p></details>`;
 settings.append(controls);
 for(const [id,label] of ANCHORS){const o=document.createElement('option');o.value=id;o.textContent=label;$('anatomy-anchor').append(o);}
 const panel=document.createElement('section');panel.hidden=true;panel.id='anatomy-panel';panel.className='anatomy-comparison-panel';
 panel.innerHTML='<div class="anatomy-panel-heading"><strong>Anatomy</strong><span>BodyParts3D</span></div><div id="anatomy-stage"><canvas id="anatomy-canvas" aria-label="Anatomical pose, synchronized with the video"></canvas></div><p class="control-help">Drag to inspect 3D. “Match video camera” restores the recorded viewpoint.</p>';
 row.append(panel);
 const transport=document.createElement('div');transport.id='anatomy-transport';transport.hidden=true;
 transport.innerHTML='<button id="anatomy-play" type="button">Play</button><input id="anatomy-timeline" type="range" min="0" max="1" step=".01" value="0" aria-label="Model playback time"><span id="anatomy-time">0.0 s</span><label>Speed <select id="anatomy-speed"><option value=".25">0.25×</option><option value=".5">0.5×</option><option value="1" selected>1×</option></select></label>';
 row.after(transport);
 function syncTransport(){const v=$('vout');$('anatomy-play').textContent=v.paused?'Play':'Pause';$('anatomy-play').disabled=!trackData;$('anatomy-timeline').max=Number.isFinite(v.duration)?v.duration:(sequence?.frames.at(-1)?.time||1);$('anatomy-timeline').value=v.currentTime;$('anatomy-time').textContent=v.currentTime.toFixed(1)+' s';}
 $('anatomy-play').onclick=()=>{const v=$('vout');if(v.paused)v.play().catch(e=>status(e.message,true));else v.pause();};
 $('anatomy-timeline').oninput=e=>{const v=$('vout');v.pause();v.currentTime=Number(e.target.value);};
 $('anatomy-speed').onchange=e=>$('vout').playbackRate=Number(e.target.value);
 for(const event of ['play','pause','ended','timeupdate','seeked','loadedmetadata'])$('vout').addEventListener(event,syncTransport);
 const overlay=document.createElement('div');overlay.id='anatomy-video-layer';overlay.hidden=true;$('videoWrap').append(overlay);
 const markerCanvas=document.createElement('canvas');markerCanvas.id='anatomy-marks';markerCanvas.hidden=true;$('videoWrap').append(markerCanvas);
 let viewer=null,current=null,manual={},pending=false,enabled=false,trackIdentity='',sequence=null,trackData=null,candidate=null,previousLayout=null;
 const status=(s,error=false)=>{$('anatomy-status').textContent=s;$('anatomy-status').style.color=error?'#ef9e88':'';};
 function identity(data){const text=JSON.stringify([data.meta?.width,data.meta?.height,data.keypoints]);let h=2166136261;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619);return 'track-'+(h>>>0).toString(16);}
 function rebuild(){if(!trackData)return;sequence=buildSequence(trackEntries(trackData),{candidate,stabilize:$('anatomy-stabilize').checked,footLock:$('anatomy-foot-lock').checked,depthMode:$('anatomy-depth').value});viewer?.setSequence(sequence);render();}
 function flatPose(){return current?fromCoco(current.points,current.meta,current.time):null;}
 function pose(){const f=flatPose(),p=sequence?.sample(current?.time??0,f);return p?withAnchors(p,nearestManual(manual,current?.time??0)):null;}
 function alignLayers(){
  const video=$('vout');if(isModelOnly()){$('anatomy-stage').style.height='560px';viewer?.resize();return;}if(!video.clientWidth||!video.clientHeight)return;
  for(const layer of [overlay,markerCanvas]){layer.style.left=video.offsetLeft+'px';layer.style.top=video.offsetTop+'px';layer.style.width=video.clientWidth+'px';layer.style.height=video.clientHeight+'px';}
  $('anatomy-stage').style.height=video.clientHeight+'px';viewer?.resize();
 }
 new ResizeObserver(alignLayers).observe($('vout'));
 function drawMarks(p){
  markerCanvas.hidden=!enabled||isModelOnly()||(!$('anatomy-anchors').checked&&!pending);if(markerCanvas.hidden)return;
  const sourceW=current?.meta?.width||1,sourceH=current?.meta?.height||1,dpr=globalThis.devicePixelRatio||1;
  const w=Math.max(1,$('vout').clientWidth*dpr),h=Math.max(1,$('vout').clientHeight*dpr);markerCanvas.width=w;markerCanvas.height=h;
  const scale=Math.min(w/sourceW,h/sourceH),dw=sourceW*scale,dh=sourceH*scale,ox=(w-dw)/2,oy=(h-dh)/2;
  const ctx=markerCanvas.getContext('2d');ctx.clearRect(0,0,w,h);if(!p?.anchorsAvailable||!$('anatomy-anchors').checked)return;
  ctx.font=`${11*dpr}px system-ui`;
  for(const [id,label] of ANCHORS){const q=p.points[id],x=ox+(q[0]/p.aspect+.5)*dw,y=oy+(.5-q[1])*dh;ctx.fillStyle=p.provenance[id]==='manual'?'#70c7ff':'#f2bc70';ctx.beginPath();ctx.arc(x,y,4*dpr,0,Math.PI*2);ctx.fill();ctx.fillText(label,x+7*dpr,y-5*dpr);}
 }
 function render(){
  if(!enabled)return;const p=pose();if(p)p.activation=window.CoachReview?.activationAt(current?.time??0)??null;
  viewer?.setPose(p);drawMarks(p);
  if(!p?.anchorsAvailable){status('Load a tracked clip to show anatomy.');return;}
  $('anatomy-bar-status').textContent=viewer?.barSource??'No bar detected. Choose a placement if this clip contains a barbell.';
  const grip=viewer?.pose?.grip;$('anatomy-grip-status').textContent=!$('anatomy-lock-hands').checked?'Hands follow the pose track.':grip?.lockedSides.length?`${grip.lockedSides.length} hand(s) held on the bar · estimated grip${grip.releasedSides.length?' · unreachable side released':''}`:viewer?.barSource?'Grip could not be fitted at this frame.':'Grip locking needs a bar. Choose its placement above.';
  const count=p.estimatedJoints?.length??0;status(p.held?'Tracking lost · complete pose held; analysis uses no inferred measurements':`${p.depthSource} · ${count?count+' joint(s) estimated during occlusion':'tracked limb positions'} · ${Object.values(p.contacts??{}).filter(Boolean).length} feet held · spine inferred`);
 }
 async function ensureViewer(){
  if(viewer)return viewer.ready;
  try{status('Loading local anatomical meshes…');viewer=new AnatomyViewer($('anatomy-canvas'),{cameraAligned:true,onStatus:status});await viewer.ready;viewer.setSequence(sequence);viewer.configure({joints:$('anatomy-anchors').checked});viewer.setBarbell({mode:$('anatomy-barbell').value,plates:$('anatomy-bar-plates').checked,lockHands:$('anatomy-lock-hands').checked,gripScale:Number($('anatomy-grip-width').value)});viewer.setOpacity(Number($('anatomy-opacity').value));}
  catch(e){status(e.message,true);viewer?.dispose();viewer=null;}
 }
 function isModelOnly(){return enabled&&$('anatomy-layout').value==='model';}
 function mode(){
  const layout=$('anatomy-layout').value,onVideo=layout==='overlay',model=isModelOnly();
  document.querySelector('.anatomy-mode-note').textContent=onVideo?'One video with the model on top':model?'Video hidden · model uses the same playback clock':'Two synchronized views';
  panel.hidden=!enabled||onVideo;overlay.hidden=!enabled||!onVideo;$('videoWrap').hidden=model;transport.hidden=!model;
  row.classList.toggle('is-comparison',enabled&&layout==='comparison');row.classList.toggle('is-model-only',model);
  document.querySelectorAll('[data-anatomy-display]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.anatomyDisplay===layout)));
  if(viewer){const canvas=$('anatomy-canvas'),host=onVideo?overlay:$('anatomy-stage');host.append(canvas,viewer.labels);viewer.resizeObserver.observe(host);viewer.setLayout(onVideo);if(layout!==previousLayout)viewer.setView(model?'front':'camera');viewer.setVisible(enabled);previousLayout=layout;}
  markerCanvas.hidden=!enabled||model;alignLayers();render();syncTransport();window.dispatchEvent(new Event('coach:displaychange'));
 }
 $('anatomy-enabled').onchange=async e=>{enabled=e.target.checked;$('anatomy-options').hidden=!enabled;if(enabled){await ensureViewer();if(!viewer){enabled=false;e.target.checked=false;$('anatomy-options').hidden=true;}}else{pending=false;markerCanvas.style.pointerEvents='none';}mode();};
 $('anatomy-layout').onchange=mode;$('anatomy-camera').onclick=()=>{viewer?.setView('camera');render();};
 for(const b of document.querySelectorAll('[data-anatomy-display]'))b.onclick=async()=>{$('anatomy-layout').value=b.dataset.anatomyDisplay;if(!enabled){$('anatomy-enabled').checked=true;await $('anatomy-enabled').onchange({target:$('anatomy-enabled')});}else mode();};
 for(const [id,flag] of [['anatomy-bones','bones'],['anatomy-muscles','muscles'],['anatomy-anchors','joints']])$(id).onchange=e=>{viewer?.configure({[flag]:e.target.checked});render();};
 for(const id of ['anatomy-stabilize','anatomy-foot-lock','anatomy-depth'])$(id).onchange=rebuild;
 for(const id of ['anatomy-barbell','anatomy-bar-plates','anatomy-lock-hands','anatomy-grip-width'])$(id).onchange=()=>{viewer?.setBarbell({mode:$('anatomy-barbell').value,plates:$('anatomy-bar-plates').checked,lockHands:$('anatomy-lock-hands').checked,gripScale:Number($('anatomy-grip-width').value),...(id==='anatomy-barbell'?{gripTime:null}:{})});render();};
 $('anatomy-calibrate-grip').onclick=()=>{$('vout').pause();viewer?.setBarbell({gripTime:current?.time??0});render();};
 $('anatomy-opacity').oninput=e=>viewer?.setOpacity(Number(e.target.value));
 $('anatomy-place').onclick=()=>{if(!current||!$('anatomy-anchor').value){status('Load a tracked clip and choose a point first.');return;}$('vout').pause();if(isModelOnly()){$('anatomy-layout').value='overlay';mode();}pending=true;markerCanvas.hidden=false;markerCanvas.style.pointerEvents='auto';markerCanvas.style.cursor='crosshair';status('Click the selected anatomical point on the paused video.');};
 markerCanvas.onclick=e=>{if(!pending||!current)return;const rect=markerCanvas.getBoundingClientRect(),p=pose();if(!p?.anchorsAvailable)return;const id=$('anatomy-anchor').value;
  const scale=Math.min(rect.width/current.meta.width,rect.height/current.meta.height),dw=current.meta.width*scale,dh=current.meta.height*scale;
  const x=(e.clientX-rect.left-(rect.width-dw)/2)/dw,y=(e.clientY-rect.top-(rect.height-dh)/2)/dh;if(x<0||x>1||y<0||y>1)return;
  const key=String(Number(current.time.toFixed(4)));manual[key]??={};manual[key][id]=[(x-.5)*p.aspect,.5-y,p.points[id][2]];
  pending=false;markerCanvas.style.pointerEvents='none';render();status('Manual point saved for this frame. Export points to keep corrections.');};
 $('anatomy-clear').onclick=()=>{if(!current)return;for(const t of Object.keys(manual))if(Math.abs(Number(t)-current.time)<=.12)delete manual[t];render();};
 $('anatomy-export').onclick=()=>{const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify({format:'coach-anatomy-anchors',version:1,trackIdentity,manual})],{type:'application/json'}));a.href=url;a.download='coach-anatomy-points.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 $('anatomy-import').onclick=()=>$('anatomy-file').click();
 $('anatomy-file').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;if(f.size>2e6)throw Error('Point file is too large.');const d=JSON.parse(await f.text());if(d.format!=='coach-anatomy-anchors'||d.trackIdentity!==trackIdentity)throw Error('Load the matching clip/track before importing these points.');manual=cleanAnchorTrack(d.manual);render();}catch(err){status(err.message,true);}e.target.value='';};
 window.CoachAnatomy={
  loadTrack(data){const id=identity(data);if(id!==trackIdentity){manual={};candidate=null;viewer?.setBarbell({gripTime:null});}trackIdentity=id;trackData=data;rebuild();window.dispatchEvent(new CustomEvent('coach:track',{detail:data}));},
  updateTrack(data){trackData={...trackData,...data};rebuild();},
  loadDepth(c){candidate=c;rebuild();},
  frame(data){current=data;render();syncTransport();window.CoachReview?.frame(data.time,data.exercise);},
  reset(){current=null;manual={};trackData=null;candidate=null;sequence=null;trackIdentity='';pending=false;markerCanvas.style.pointerEvents='none';viewer?.setSequence(null);viewer?.setPose(null);drawMarks(null);window.CoachReview?.reset();},
  refresh:render,isModelOnly,
  getState:()=>({current,trackData,candidate,sequence,manual,enabled,viewer}),
 };
 window.dispatchEvent(new Event('coach:anatomy-ready'));
}
