import * as THREE from '../squat/vendor/three.module.js';
import {REST,ANCHORS,withAnchors,clamp} from './pose-rig.mjs';
import {barbellPose} from './barbell.mjs';
import {buildGripTrack,constrainGrip} from './grip.mjs';
import {muscleGroup,regionFor} from './regions.mjs';
export {muscleGroup} from './regions.mjs';
const V=p=>new THREE.Vector3(...p),up=new THREE.Vector3(0,1,0);
const palette=['#294856','#419f8e','#c0d86c','#ff9f57'].map(c=>new THREE.Color(c));
export function activationColour(value){const v=clamp(value)*3,i=Math.min(2,Math.floor(v));return palette[i].clone().lerp(palette[i+1],v-i);}
const SEGMENTS=[
 ['pelvis','pelvis','sacrum'],['lumbar','sacrum','lumbar'],['lowerThorax','lumbar','thoracolumbar'],
 ['midThorax','thoracolumbar','thoracic'],['upperThorax','thoracic','neck'],['head','neck','head'],
 ...['left','right'].flatMap(s=>[[s+'Thigh',s+'Hip',s+'Knee'],[s+'Shin',s+'Knee',s+'Ankle'],[s+'Foot',s+'Ankle',s+'Toe'],[s+'Arm',s+'Shoulder',s+'Elbow'],[s+'Forearm',s+'Elbow',s+'Wrist'],[s+'Hand',s+'Wrist',s+'Hand'],[s+'Girdle',s+'Shoulder','neck']]),
];
let assetPromise;
export function loadAssets(){
 if(!assetPromise)assetPromise=Promise.all([
  fetch(new URL('./models/body.json',import.meta.url)).then(r=>{if(!r.ok)throw Error('Anatomy manifest could not load.');return r.json();}),
  fetch(new URL('./models/body.bin',import.meta.url)).then(r=>{if(!r.ok)throw Error('Anatomy meshes could not load.');return r.arrayBuffer();}),
 ]).then(([meta,buffer])=>{if(buffer.byteLength!==meta.bytes)throw Error('Incomplete anatomy download. Extract the whole ZIP.');return {meta,buffer};}).catch(e=>{assetPromise=null;throw e;});
 return assetPromise;
}
const segmentIndex=id=>SEGMENTS.findIndex(s=>s[0]===id);
function segmentDistance(p,a,b){const d=b.clone().sub(a),t=clamp(p.clone().sub(a).dot(d)/d.lengthSq());return p.distanceTo(a.clone().addScaledVector(d,t));}
function frameBasis(direction,lateral){
 const y=direction.clone().normalize();let x=lateral.clone().addScaledVector(y,-lateral.dot(y));
 if(x.lengthSq()<1e-5){x=new THREE.Vector3(0,0,1);x.addScaledVector(y,-x.dot(y));}
 x.normalize();const z=x.clone().cross(y).normalize();return new THREE.Matrix4().makeBasis(x,y,z);
}
/** Real atlas surfaces with approximate regional skinning; no force simulation. */
export class AnatomyViewer{
 constructor(canvas,{onSelect=()=>{},onStatus=()=>{},overlay=false,cameraAligned=false,blend=false}={}){
  Object.assign(this,{canvas,onSelect,onStatus,overlay,cameraAligned,blend,items:[],opacity:.8,selected:'all',angle:0,pitch:0,zoom:1,frame:null,visible:true,initialized:false,bounds:null});
  this.barOptions={mode:'auto',plates:false,length:2.2,lockHands:true,gripTime:null};
  this.flags={bones:true,muscles:true,activation:true,joints:true,spine:true};
  this.renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
  this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio||1,2));this.renderer.setClearColor(0,0);
  this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.3;
  this.scene=new THREE.Scene();this.root=new THREE.Group();this.scene.add(this.root);
  this.camera=overlay?new THREE.OrthographicCamera(-1,1,.5,-.5,.01,30):new THREE.PerspectiveCamera(36,1,.01,30);
  this.buildBarbell();
  this.scene.add(new THREE.HemisphereLight(0xd9edff,0x344131,2.4));
  for(const [c,intensity,pos] of [[0xffedd7,3,[2,3,4]],[0x9cc5e2,1.7,[-2,2,-2]]]){const l=new THREE.DirectionalLight(c,intensity);l.position.set(...pos);this.scene.add(l);}
  this.rigBones=SEGMENTS.map(()=>new THREE.Bone());this.rigBones.forEach(b=>{b.matrixAutoUpdate=false;this.root.add(b);});this.skeleton=new THREE.Skeleton(this.rigBones);
  this.joints=new THREE.Group();this.root.add(this.joints);this.markers={};
  for(const [id] of [...ANCHORS,['leftHip'],['rightHip']]){const mesh=new THREE.Mesh(new THREE.SphereGeometry(.01,12,8),new THREE.MeshBasicMaterial({color:0xf2bc70,depthTest:false}));mesh.renderOrder=5;this.markers[id]=mesh;this.joints.add(mesh);}
  this.labels=document.createElement('div');this.labels.className='anatomy-anchor-labels';this.labels.style.cssText='position:absolute;inset:0;pointer-events:none;overflow:hidden';this.labelNodes={};
  for(const [id,label] of [...ANCHORS,['leftHip','L hip'],['rightHip','R hip']]){const n=document.createElement('span');n.textContent=label;n.style.cssText='position:absolute;font:10px/1.2 system-ui;padding:3px 5px;border-radius:3px;background:#101b25d9;color:#ffd39a;white-space:nowrap;transform:translate(10px,-50%)';this.labelNodes[id]=n;this.labels.append(n);}
  canvas.parentElement.append(this.labels);
  this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(canvas.parentElement);
  this.events=new AbortController();const event={signal:this.events.signal};let drag=null,moved=0;
  if(!overlay){
   canvas.addEventListener('pointerdown',e=>{if(this.overlay)return;drag=[e.clientX,e.clientY];moved=0;canvas.setPointerCapture(e.pointerId);},event);
   canvas.addEventListener('pointermove',e=>{if(!drag||this.overlay)return;const dx=e.clientX-drag[0],dy=e.clientY-drag[1];moved+=Math.abs(dx)+Math.abs(dy);if(moved>4){this.cameraAligned=false;this.useCamera();}this.angle-=dx*.008;this.pitch=clamp(this.pitch+dy*.003,-.6,.6);drag=[e.clientX,e.clientY];this.render();},event);
   canvas.addEventListener('pointerup',e=>{if(drag&&moved<5)this.pick(e);drag=null;},event);
   canvas.addEventListener('pointercancel',()=>{drag=null;},event);
   // Multiplicative rather than additive: a mouse wheel notch (deltaY ~100)
   // and a trackpad's many small scroll/pinch events (deltaY ~1-10 each) both
   // end up feeling like the same "amount" of zoom per gesture this way.
   canvas.addEventListener('wheel',e=>{if(this.overlay||this.cameraAligned)return;e.preventDefault();this.zoom=clamp(this.zoom*Math.pow(1.0015,e.deltaY),.35,3);this.render();},{...event,passive:false});
  }
  this.ready=loadAssets().then(data=>{this.build(data);this.initialized=true;this.setPose(this.frame);this.onStatus(`${data.meta.parts.length} BodyParts3D meshes loaded`);return this;});
  this.ready.catch(e=>this.onStatus(e.message,true));this.useCamera();this.resize();
 }
 build({meta,buffer}){
  const cache=new Map();
  for(const part of meta.parts){
   const bone=part.system==='skeletal',group=bone?'bones':muscleGroup(part.name),key=group;
   if(!cache.has(key))for(const estimated of [false,true]){
    const mat=new THREE.MeshStandardMaterial({color:bone?0xe6dfc7:0xa75956,roughness:.65,metalness:0,side:THREE.DoubleSide});mat.userData={group,bone,estimated};cache.set(key+(estimated?':estimated':''),mat);
   }
   const geo=new THREE.BufferGeometry(),pos=new Float32Array(buffer,part.positions,part.vertexCount*3);
   geo.setAttribute('position',new THREE.BufferAttribute(pos,3));geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer,part.indices,part.indexCount),1));geo.computeVertexNormals();
   let regions=regionFor(part).map(segmentIndex);
   if(bone&&regions.length>1){
    const centre=V(part.bounds[0]).add(V(part.bounds[1])).multiplyScalar(.5);
    regions=[regions.slice().sort((a,b)=>segmentDistance(centre,V(REST[SEGMENTS[a][1]]),V(REST[SEGMENTS[a][2]]))-segmentDistance(centre,V(REST[SEGMENTS[b][1]]),V(REST[SEGMENTS[b][2]])))[0]];
   }
   const skinIndex=new Uint16Array(part.vertexCount*4),skinWeight=new Float32Array(part.vertexCount*4);
   const point=new THREE.Vector3(),segs=regions.map(i=>({i,a:V(REST[SEGMENTS[i][1]]),b:V(REST[SEGMENTS[i][2]])}));
   for(let v=0;v<part.vertexCount;v++){
    point.fromArray(pos,v*3);const ranked=segs.map(s=>({i:s.i,d:segmentDistance(point,s.a,s.b)})).sort((a,b)=>a.d-b.d);
    const first=ranked[0],second=bone?null:ranked[1],w=second?1/(1+((first.d+.018)/(second.d+.018))**4):1;
    skinIndex[v*4]=first.i;skinWeight[v*4]=w;if(second){skinIndex[v*4+1]=second.i;skinWeight[v*4+1]=1-w;}
   }
   geo.setAttribute('skinIndex',new THREE.BufferAttribute(skinIndex,4));geo.setAttribute('skinWeight',new THREE.BufferAttribute(skinWeight,4));
   const mesh=new THREE.SkinnedMesh(geo,cache.get(key));mesh.frustumCulled=false;mesh.bind(this.skeleton,new THREE.Matrix4());mesh.name=part.name;mesh.userData={part,group,bone,regions};
   this.root.add(mesh);this.items.push(mesh);
  }
  this.materials=cache;this.meta=meta;
 }
 setPose(frame){
  this.frame=frame;if(!this.initialized)return;
  let pose=frame?.points?(frame.provenance?frame:withAnchors(frame,{},this.flags.spine)):null;
  pose=constrainGrip(pose,this.gripTrack?.sample(frame?.time??0));this.pose=pose;this.root.visible=!!pose?.anchorsAvailable;
  if(!pose?.anchorsAvailable){this.barbell.visible=false;this.barSource=null;this.render();return;}
  const p={...pose.points},scale=pose.scale||1;
  for(const [k,v] of Object.entries(REST))if(!p[k])p[k]=v.map((x,i)=>p.pelvis[i]+(x-REST.pelvis[i])*scale);
  const lateral=pose.axes?.lateral?V(pose.axes.lateral):p.leftShoulder&&p.rightShoulder?V(p.leftShoulder).sub(V(p.rightShoulder)).normalize():new THREE.Vector3(1,0,0);
  if(lateral.lengthSq()<.1)lateral.set(1,0,0);
  const torsoRotation=frameBasis(V(p.neck).sub(V(p.thoracic)),lateral).multiply(frameBasis(V(REST.neck).sub(V(REST.thoracic)),new THREE.Vector3(1,0,0)).invert());
  for(let i=0;i<SEGMENTS.length;i++){
   const [id,a,b]=SEGMENTS[i];
   const start=V(p[a]),end=V(p[b]),restStart=V(REST[a]),rd=V(REST[b]).sub(restStart),d=end.clone().sub(start);if(d.length()<1e-5)d.copy(rd).multiplyScalar(scale);
   // Preserve torso-relative axial orientation for limbs. Projecting the lateral
   // axis onto an elevated arm becomes singular at shoulder height.
   const lockedHand=id.endsWith('Hand')&&pose.grip?.lockedSides.includes(id.startsWith('left')?'left':'right');
   const R=lockedHand?frameBasis(d,V(pose.displayBar.axis)).multiply(frameBasis(rd,new THREE.Vector3(1,0,0)).invert()):/Thigh|Shin|Foot|Arm|Forearm|Hand|Girdle/.test(id)?new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(rd.clone().transformDirection(torsoRotation),d.clone().normalize())).multiply(torsoRotation):frameBasis(d,lateral).multiply(frameBasis(rd,new THREE.Vector3(1,0,0)).invert());
   const axial=new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(up,rd.clone().normalize()));
   const S=axial.clone().multiply(new THREE.Matrix4().makeScale(scale,d.length()/rd.length(),scale)).multiply(axial.clone().invert());
   const m=new THREE.Matrix4().makeTranslation(...p[a]).multiply(R).multiply(S).multiply(new THREE.Matrix4().makeTranslation(-restStart.x,-restStart.y,-restStart.z));
   this.rigBones[i].matrix.copy(m);this.rigBones[i].matrixWorldNeedsUpdate=true;
  }
  for(const mesh of this.items){const {bone,group,regions}=mesh.userData;mesh.visible=(bone?this.flags.bones:this.flags.muscles)&&(bone||this.selected==='all'||group===this.selected);
   const estimated=regions.some(i=>SEGMENTS[i].slice(1).some(k=>pose.jointSources?.[k]==='estimated'));mesh.userData.estimated=estimated;mesh.material=this.materials.get(group+(estimated?':estimated':''));
  }
  for(const mat of this.materials.values()){const {bone,group,estimated}=mat.userData,value=frame.activation?.[group];mat.color.copy(bone?new THREE.Color(0xe6dfc7):this.flags.activation&&Number.isFinite(value)?activationColour(value):new THREE.Color(0xa75956));
   if(estimated)mat.color.lerp(new THREE.Color(0x729aad),.65);mat.opacity=1;mat.transparent=false;mat.depthWrite=true;
  }
  for(const [id,mesh] of Object.entries(this.markers)){mesh.visible=!!p[id]&&this.flags.joints;if(p[id])mesh.position.copy(V(p[id]));mesh.scale.setScalar(scale);const source=pose.provenance[id];mesh.material.color.set(source==='manual'?0x70c7ff:source==='tracked'?0x8bd7bb:0xf2bc70);this.labelNodes[id].dataset.source=source;}
  this.updateBarbell(pose);this.render();
 }
 buildBarbell(){
  this.barbell=new THREE.Group();this.barbell.visible=false;this.scene.add(this.barbell);
  const steel=new THREE.MeshStandardMaterial({color:0xbcc9cf,metalness:.65,roughness:.35});
  this.barShaft=new THREE.Mesh(new THREE.CylinderGeometry(.014,.014,1,12),steel);this.barbell.add(this.barShaft);
  this.barPlates=[-1,1].map(()=>{const m=new THREE.Mesh(new THREE.CylinderGeometry(.225,.225,.07,24),new THREE.MeshStandardMaterial({color:0x526677,metalness:.15,roughness:.8}));this.barbell.add(m);return m;});
 }
 setBarbell(options){Object.assign(this.barOptions,options);this.gripTrack=buildGripTrack(this.sequence,this.barOptions);this.setPose(this.frame);}
 updateBarbell(pose){
  const b=barbellPose(pose,this.barOptions);this.barbell.visible=!!b&&this.root.visible;this.barSource=b?.source??null;if(!b)return;
  const a=V(b.a),end=V(b.b),d=end.clone().sub(a),scale=b.scale;
  this.barShaft.position.copy(a).add(end).multiplyScalar(.5);this.barShaft.quaternion.setFromUnitVectors(up,d.clone().normalize());this.barShaft.scale.set(scale,d.length(),scale);
  for(let i=0;i<2;i++){const mesh=this.barPlates[i];mesh.visible=b.plates;mesh.position.copy(a).lerp(end,i?.9:.1);mesh.quaternion.copy(this.barShaft.quaternion);mesh.scale.setScalar(scale);}
 }
 configure(flags){Object.assign(this.flags,flags);this.setPose(this.frame);}
 // `overlay` couples "translucent" with "camera locked to the video, no drag" —
 // right for compositing pixel-for-pixel onto a video element. `blend` is the
 // translucent half of that alone, for a caller (src/anatomy/integration.mjs)
 // that wants the opacity slider without giving up orbit rotation, because
 // it's compositing onto another 3D pane rather than a flat video frame.
 setOpacity(v){this.opacity=clamp(v,.15,1);this.canvas.style.opacity=String(this.overlay||this.blend?this.opacity:1);this.render();}
 isolate(id){this.selected=id;this.setPose(this.frame);}
 setVisible(value){this.visible=value;this.canvas.hidden=!value;this.labels.hidden=!value;if(value){this.resize();this.render();}}
 useCamera(){const ortho=this.overlay||this.cameraAligned;if(ortho!==!!this.camera.isOrthographicCamera)this.camera=ortho?new THREE.OrthographicCamera(-1,1,.5,-.5,.01,30):new THREE.PerspectiveCamera(36,1,.01,30);}
 setLayout(overlay){this.overlay=overlay;this.canvas.style.opacity=String(this.overlay||this.blend?this.opacity:1);this.useCamera();this.resize();this.setPose(this.frame);}
 setSequence(sequence){
  this.sequence=sequence;this.gripTrack=buildGripTrack(sequence,this.barOptions);
  const frames=sequence?.frames??[];
  // The largest joint-to-joint distance seen anywhere in the clip (e.g. an
  // extended arm to the opposite foot), fixed once per clip rather than
  // per-frame so the view doesn't "breathe" as the pose changes. This is what
  // orbit-mode framing scales to, in place of the old scale/pixel-derived
  // radius — see the comment in render().
  let spread=0;
  for(const f of frames){
   const pts=Object.values(f.points);
   for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){
    const dx=pts[i][0]-pts[j][0],dy=pts[i][1]-pts[j][1],dz=pts[i][2]-pts[j][2],d=Math.sqrt(dx*dx+dy*dy+dz*dz);
    if(d>spread)spread=d;
   }
  }
  this.spread=spread||1.7;
  const points=frames.flatMap(f=>Object.values(f.points).map(V));
  this.bounds=points.length?new THREE.Box3().setFromPoints(points).expandByScalar(.15*(sequence.bodyScale||1)):null;
 }
 setView(view){this.cameraAligned=view==='camera';this.angle={front:0,side:Math.PI/2,back:Math.PI,'three-quarter':.65}[view]??0;this.pitch=0;this.zoom=1;this.useCamera();this.resize();}
 resize(){const r=this.canvas.getBoundingClientRect(),w=r.width||640,h=r.height||440;this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.render();}
 render(){
  if(!this.visible)return;const pose=this.pose;
  if(this.overlay||this.cameraAligned){const sourceAspect=pose?.aspect||1,viewport=this.camera.aspect||1,halfY=Math.max(.5,sourceAspect/(2*viewport));this.camera.left=-halfY*viewport;this.camera.right=halfY*viewport;this.camera.top=halfY;this.camera.bottom=-halfY;this.camera.position.set(0,0,5);this.camera.lookAt(0,0,0);this.camera.updateProjectionMatrix();}
  else{
   const scale=pose?.scale||1,points=pose?Object.values(pose.points).map(V):[V([0,0,0]),V([0,1.7,0])];
   if(pose?.points.head)points.push(V(pose.points.head).add(V([0,.14*scale,0])));
   if(!this.bounds&&pose)this.bounds=new THREE.Box3().setFromPoints(points).expandByScalar(.1*scale);
   const box=this.bounds??new THREE.Box3().setFromPoints(points),target=box.getCenter(new THREE.Vector3());
   // Frame on the pose's own largest joint-to-joint distance (this.spread,
   // fixed per clip — see setSequence), not on `scale`/pixel-derived size: the
   // same body fills the same fraction of the panel however big or small it
   // was in the source video. Fit that span to 3/4 of the panel's height,
   // then let `zoom` move the camera in/out from there.
   const vfov=this.camera.fov*Math.PI/180,span=this.spread||box.getSize(new THREE.Vector3()).length()||1.7;
   const radius=Math.max(.3,span/(1.5*Math.tan(vfov/2)))*this.zoom;
   this.camera.position.copy(target).add(new THREE.Vector3(Math.sin(this.angle)*radius,Math.sin(this.pitch)*radius,Math.cos(this.angle)*radius));this.camera.lookAt(target);
  }
  this.scene.updateMatrixWorld(true);this.camera.updateMatrixWorld(true);this.renderer.render(this.scene,this.camera);
  const w=this.canvas.clientWidth||640,h=this.canvas.clientHeight||440;
  for(const [id,node] of Object.entries(this.labelNodes)){const marker=this.markers[id];node.hidden=!this.flags.joints||!pose?.anchorsAvailable||!marker.visible;if(!node.hidden){const p=marker.getWorldPosition(new THREE.Vector3()).project(this.camera);node.style.left=`${(p.x+1)*w/2}px`;node.style.top=`${(1-p.y)*h/2}px`;}}
 }
 pick(e){if(!this.pose)return;const r=this.canvas.getBoundingClientRect(),ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),this.camera);const hit=ray.intersectObjects(this.items.filter(m=>m.visible&&!m.userData.bone))[0];if(hit)this.onSelect(hit.object.userData.group,hit.object.name);}
 dispose(){this.events.abort();this.resizeObserver.disconnect();this.labels.remove();this.items.forEach(m=>m.geometry.dispose());this.materials?.forEach(m=>m.dispose());this.barbell.traverse(m=>{m.geometry?.dispose();m.material?.dispose();});Object.values(this.markers).forEach(m=>{m.geometry.dispose();m.material.dispose();});this.renderer.dispose();}
}
