/** Real original diagnostic engine + geometric backend in the anatomy UI. */
export function mountOriginalTools({videoClock,redraw,onDepth,getExercise}){
 const $=id=>document.getElementById(id),D=window.Diagnostics;
 if(!D)throw Error('Original diagnostics failed to load. Extract the complete package.');
 D.mount({sections:$('lab-diag-sections'),select:$('lab-diag-person'),toggles:$('lab-diag-toggles'),wrap:$('lab-diag-wrap'),video:videoClock,redraw,smoothMotion:()=>true});
 let track=null,methods=null,limbs=null,signs='auto',run=0,busy=false;
 const profiles={limbs:[],signs:[]};
 const notice=message=>$('lab-depth-status').textContent=message;
 async function json(path,init){const r=await fetch(path,init),d=await r.json();if(!r.ok||d.error&&!d.candidate)throw Error(d.error||`HTTP ${r.status}`);return d;}
 const post=(path,body)=>json(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 function payload(){
  const m=track.meta,ids=m.frame_indices??Object.keys(track.keypoints).map(Number),sequence={};
  for(const id of ids){const frame=track.keypoints[String(id)];sequence[id]={keypoints:frame?.[String(m.tracks?.kept)]??Object.values(frame??{})[0]??[],equipment:m.equipment?.[String(id)]??null};}
  const first=ids[0];return {width:m.width,height:m.height,keypoints:sequence[first].keypoints,equipment:sequence[first].equipment,sequence,current_frame:first,start_frame:first,lift:getExercise(),depth_signs:signs,bone_ratios:limbs};
 }
 async function reconstruct(){if(!track||busy)return;const request=++run;notice('Reconstructing this clip…');
  try{const d=await post('/api/depth/generate',{...payload(),method:$('lab-depth-method').value});if(request!==run)return;onDepth(d.candidate);notice(`${d.candidate.method} · ${Object.keys(d.candidate.frames??{}).length} frames · profile changes update anatomy`);}
  catch(e){if(request===run)notice(e.message);}
 }
 function limbFields(){const box=$('lab-limb-fields');box.replaceChildren();for(const s of methods?.limb_segments??[]){const label=document.createElement('label'),input=document.createElement('input');label.textContent=s.label+' ';input.type='number';input.min=s.min;input.max=s.max;input.step='.005';input.value=limbs?.[s.key]??s.default;input.onchange=()=>{const v=Number(input.value);if(!Number.isFinite(v)||v<s.min||v>s.max)return;limbs[s.key]=v;reconstruct();};label.append(input);box.append(label);}}
 async function populateProfiles(){for(const kind of ['limbs','signs']){const d=await json('/api/profiles/'+kind);profiles[kind]=d.profiles;const sel=$('lab-'+kind+'-profile');sel.replaceChildren();if(kind==='signs'){const o=document.createElement('option');o.value='auto';o.textContent='Infer depth directions';sel.append(o);}for(const p of d.profiles){const o=document.createElement('option');o.value=p.name;o.textContent=p.name;sel.append(o);}}}
 const ready=(async()=>{try{methods=await json('/api/depth/methods');for(const m of methods.methods){const o=document.createElement('option');o.value=m.name;o.textContent=m.label+(m.available?'':' · unavailable');o.disabled=!m.available;$('lab-depth-method').append(o);}await populateProfiles();limbs={...methods.default_limbs};limbFields();for(const obj of methods.objectives??[]){const o=document.createElement('option');o.value=obj.name??obj.id;o.textContent=obj.label??obj.name??obj.id;$('lab-objective').append(o);}$('lab-objective').value=methods.default_objective;notice('Geometric 3D ready. Uses the original backend.');}catch(e){notice(e.message);}})();
 $('lab-depth-method').onchange=reconstruct;$('lab-depth-run').onclick=reconstruct;
 $('lab-limbs-profile').onchange=()=>{limbs={...profiles.limbs.find(p=>p.name===$('lab-limbs-profile').value)?.ratios};limbFields();reconstruct();};
 $('lab-signs-profile').onchange=()=>{signs=profiles.signs.find(p=>p.name===$('lab-signs-profile').value)?.signs??'auto';reconstruct();};
 $('lab-optimize').onclick=async()=>{if(!track||busy)return;busy=true;$('lab-optimize').disabled=true;const request=++run;notice('Optimizing limb profile…');try{const d=await post('/api/depth/optimize_limbs',{...payload(),iters:20,objective:$('lab-objective').value,perspective:$('lab-perspective').checked});if(request!==run)return;limbs={...d.ratios};limbFields();$('lab-optimizer-result').textContent=`${d.iterations} steps · penalty ${Number(d.start_total).toFixed(3)} → ${Number(d.total).toFixed(3)}. Lower penalty does not establish correct limb lengths.`;}catch(e){if(request===run)notice(e.message);}finally{busy=false;$('lab-optimize').disabled=false;if(track)await reconstruct();}};
 $('lab-save-profile').onclick=async()=>{const name=window.prompt('Save this athlete profile locally under a new name (lowercase letters, digits, hyphens):');if(!name)return;try{await json('/api/profiles/limbs/'+encodeURIComponent(name),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({ratios:limbs,notes:'Saved from anatomy workspace'})});await populateProfiles();$('lab-limbs-profile').value=name;notice('Profile saved locally.');}catch(e){notice(e.message);}};
 return {setPage(exercise){D.setPage(exercise);if(track&&methods)reconstruct();},async setTrack(data){track=data;D.setTrack(data?.keypoints??null,data?.meta??null,{smoothingMs:0});++run;if(data){await ready;return reconstruct();}},draw(t){D.draw(t);},overlay(ctx,t){D.overlay(ctx,t);},compute(){return track?D.computeResults(track.keypoints,track.meta,String(track.meta.tracks?.kept??Object.keys(Object.values(track.keypoints)[0]??{})[0])):null;},reset(){++run;track=null;D.setTrack(null,null);},getTrack:()=>track};
}
