// SPDX-License-Identifier: AGPL-3.0-or-later
/** A visual barbell estimate, never input to movement diagnostics or load. */
import {add,sub,mul,mix,dist,unit} from './pose-rig.mjs';
export function barbellPose(pose,{mode='auto',length=2.2,plates=false}={}){
 if(!pose?.points||mode==='off')return null;
 if(pose.displayBar?.mode===mode)return pose.displayBar;
 const p=pose.points,scale=pose.bodyScale||pose.scale||1,eq=pose.equipment,box=eq?.bar?.box;
 if(mode==='auto'){
  if(!Array.isArray(box)||box.length!==4||!box.every(Number.isFinite)||(eq.bar.score??1)<.35)return null;
  const w=pose.videoWidth,h=pose.videoHeight;if(!(w>0&&h>0))return null;
  const centre=[((box[0]+box[2])/2-w/2)/h,.5-(box[1]+box[3])/2/h,0];
  let direction=[1,0,0];if(p.leftWrist&&p.rightWrist){const d=sub(p.leftWrist,p.rightWrist);if(Math.hypot(d[0],d[1])>.03)direction=unit([d[0],d[1],0]);centre[2]=(p.leftWrist[2]+p.rightWrist[2])/2;}
  const span=Math.max(box[2]-box[0],box[3]-box[1])/h;
  return {a:add(centre,mul(direction,-span/2)),b:add(centre,mul(direction,span/2)),source:'detected equipment · approximate bar axis',plates:!!eq.plates?.length,scale};
 }
 const a=mode==='back'?p.leftShoulder:p.leftWrist,b=mode==='back'?p.rightShoulder:p.rightWrist;if(!a||!b)return null;
 const centre=mix(a,b,.5),axis=mode==='back'?(pose.axes?.lateral??unit(sub(a,b))):dist(a,b)>.025*scale?unit(sub(a,b)):(pose.axes?.lateral??[1,0,0]);
 if(mode==='back'){const offset=add(mul(pose.axes?.up??[0,1,0],.025*scale),mul(pose.axes?.forward??[0,0,1],-.04*scale));for(let k=0;k<3;k++)centre[k]+=offset[k];}
 const half=Math.max(length*scale,dist(a,b)+.25*scale)/2;
 return {a:add(centre,mul(axis,-half)),b:add(centre,mul(axis,half)),source:'user-placed '+(mode==='back'?'back-rack':'hand-held')+' bar',plates,scale};
}
