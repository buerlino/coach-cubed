import {GROUPS,analyseSession,explainRep} from '../squat/analysis.mjs';
import {trackSession} from './track-session.mjs';
const $=id=>document.getElementById(id);
const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
const name=id=>GROUPS.find(g=>g[0]===id)?.[1]??id;
const panel=el('section');panel.id='coach-review';panel.className='coach-review';panel.hidden=true;
panel.innerHTML=`<h2>Squat · rep review</h2><div class="review-row"><label>Camera view <select id="cr-view"><option value="side">Side</option><option value="oblique">Oblique</option><option value="front">Front / rear</option></select></label><label>Rep <select id="cr-rep" aria-label="Squat repetition"></select></label><button id="cr-feedback" type="button">What did you feel?</button><button id="cr-export" type="button">Export review</button></div><p id="cr-status" role="status"></p><div class="review-columns"><div><h3>Motion evidence</h3><div id="cr-observations"></div><p id="cr-summary"></p><div id="cr-hypotheses"></div><p id="cr-report"></p></div><div><h3>Estimated activation · this frame</h3><div class="activity-scale" aria-hidden="true"></div><p class="control-help">Low → high relative estimate. Not EMG, force, or weakness. Blue-grey anatomy marks inferred limbs.</p><div id="cr-activity"></div></div></div><p class="control-help">Video drives the hypotheses. Feedback can only add bounded support to existing motion evidence. <a href="/squat/METHOD.md" target="_blank" rel="noopener">Methods</a> · <a href="/squat/">Open dedicated squat lab</a></p>`;
$('videoView').append(panel);
const dialog=el('dialog');dialog.id='coach-feedback';dialog.className='coach-feedback';dialog.setAttribute('aria-labelledby','cr-title');
dialog.innerHTML=`<form id="cr-form"><h2 id="cr-title">What limited this rep?</h2><p id="cr-feedback-rep"></p><fieldset><legend>What happened?</legend><label><input type="radio" name="cr-outcome" value="complete"> Completed</label><label><input type="radio" name="cr-outcome" value="failed"> Failed rep</label><label><input type="radio" name="cr-outcome" value="stopped"> Stopped intentionally</label><label><input type="radio" name="cr-outcome" value="unsure" checked> Unsure / cut clip</label></fieldset><fieldset id="cr-groups"><legend>Where did you feel limited? (Up to three)</legend></fieldset><label><input id="cr-unsure" type="checkbox"> Whole-body fatigue / unsure</label><label>Notes <textarea id="cr-notes" rows="3" maxlength="1000"></textarea></label><p>Feeling effort does not establish which muscle caused failure. Your selection never changes the activation colours.</p><button type="submit">Save for this rep</button><button id="cr-close" type="button">Cancel</button><button id="cr-clear" type="button">Clear feedback</button></form>`;
document.body.append(dialog);
let raw=null,analysis=null,selected=0,dialogRep=0,page=document.body.dataset.page,feedback=new Map();
for(const [id,label] of GROUPS){
 const choice=el('label'),input=el('input');input.type='checkbox';input.name='cr-muscle';input.value=id;choice.append(input,document.createTextNode(' '+label));$('cr-groups').append(choice);
 input.onchange=()=>{if(document.querySelectorAll('[name=cr-muscle]:checked').length>3)input.checked=false;if(input.checked)$('cr-unsure').checked=false;};
 const row=el('p'),text=el('span',label+' '),bar=el('span');bar.className='activity-value';bar.append(el('i'));const level=el('span',' —');level.id='cr-level-'+id;bar.id='cr-bar-'+id;row.append(text,bar,level);$('cr-activity').append(row);
}
function rep(){return analysis?.reps.find(r=>r.id===selected);}
function load(data){raw=data;feedback.clear();recalculate();}
function recalculate(){
 analysis=null;selected=0;
 if(raw&&page==='squat')try{analysis=analyseSession(trackSession(raw),{view:$('cr-view').value});selected=analysis.reps[0]?.id??0;}catch(e){$('cr-status').textContent=e.message;}
 $('cr-rep').replaceChildren();for(const r of analysis?.reps??[]){const o=el('option',`Rep ${r.id} · ${r.status}`);o.value=r.id;$('cr-rep').append(o);}
 render();window.CoachAnatomy?.refresh();
}
function render(){
 panel.hidden=page!=='squat';$('cr-feedback').disabled=!rep();$('cr-export').disabled=!analysis;$('cr-rep').disabled=!analysis?.reps.length;
 for(const id of ['cr-observations','cr-hypotheses'])$(id).replaceChildren();
 $('cr-summary').textContent='';$('cr-report').textContent='';
 if(!analysis){$('cr-status').textContent='Load and track a side-view squat clip to begin.';return;}
 $('cr-status').textContent=[`${Math.round(100*analysis.coverage)}% usable frames.`,...analysis.warnings,!rep()?'No clear repetition detected.':''].filter(Boolean).join(' ');
 if(!rep())return;
 $('cr-rep').value=selected;const result=explainRep(analysis,rep(),feedback.get(selected)??{});$('cr-summary').textContent=result.summary;
 for(const o of result.observations){const p=el('p'),b=el('button',o.time.toFixed(1)+'s');b.type='button';b.onclick=()=>window.CoachBridge.seek(o.time);p.append(b,document.createTextNode(' '+o.text));$('cr-observations').append(p);}
 for(const h of result.hypotheses){const box=el('div');box.append(el('h4',h.label),el('p',h.evidence),el('p',h.alternatives));if(h.reportSupport)box.append(el('p','Also reported by lifter · supporting context'));const d=el('details');d.append(el('summary','What to check / possible accessory work'),el('p',h.next));box.append(d);$('cr-hypotheses').append(box);}
 if(result.unmatched?.length)$('cr-hypotheses').append(el('p',`Reported ${result.unmatched.map(name).join(', ')}: the video rules do not independently support these as the limiter.`));
 const f=feedback.get(selected);$('cr-report').textContent=f?`Lifter report: ${f.outcome}; ${f.unsure?'whole-body / unsure':f.groups?.map(name).join(', ')||'no muscle selected'}.`:'No lifter feedback for this rep yet.';
}
function activationAt(time){
 if(page!=='squat'||!analysis||analysis.view==='front')return null;
 const frames=analysis.frames;let lo=0,hi=frames.length-1;
 while(lo<hi){const m=Math.floor((lo+hi)/2);if(frames[m].t<time)lo=m+1;else hi=m;}
 if(lo>0&&Math.abs(frames[lo-1].t-time)<Math.abs(frames[lo].t-time))lo--;
 const f=frames[lo];return f?.valid&&Math.abs(f.t-time)<=.25?f.activation:null;
}
function frame(time){
 if(page!=='squat')return;
 const r=analysis?.reps.find(r=>time>=r.startTime&&time<=r.endTime);if(r&&r.id!==selected){selected=r.id;render();}
 const a=activationAt(time);for(const [id] of GROUPS){const v=a?.[id];$('cr-bar-'+id).firstChild.style.width=Number.isFinite(v)?`${v*100}%`:'0%';$('cr-level-'+id).textContent=!Number.isFinite(v)?' —':v<.3?' Low':v<.62?' Moderate':' High';}
}
$('cr-view').onchange=()=>{feedback.clear();recalculate();};
$('cr-rep').onchange=()=>{selected=Number($('cr-rep').value);window.CoachBridge.seek(rep().bottomTime);render();};
$('cr-feedback').onclick=()=>{if(!rep())return;$('vout').pause();dialogRep=selected;const f=feedback.get(dialogRep)??{};$('cr-feedback-rep').textContent=`Rep ${dialogRep}`;document.querySelectorAll('[name=cr-outcome]').forEach(x=>x.checked=x.value===(f.outcome??'unsure'));document.querySelectorAll('[name=cr-muscle]').forEach(x=>x.checked=f.groups?.includes(x.value)??false);$('cr-unsure').checked=!!f.unsure;$('cr-notes').value=f.notes??'';dialog.showModal();};
$('cr-unsure').onchange=()=>{if($('cr-unsure').checked)document.querySelectorAll('[name=cr-muscle]').forEach(x=>x.checked=false);};
$('cr-form').onsubmit=e=>{e.preventDefault();feedback.set(dialogRep,{outcome:document.querySelector('[name=cr-outcome]:checked').value,groups:[...document.querySelectorAll('[name=cr-muscle]:checked')].map(x=>x.value).slice(0,3),unsure:$('cr-unsure').checked,notes:$('cr-notes').value.trim()});dialog.close();render();};
$('cr-close').onclick=()=>dialog.close();$('cr-clear').onclick=()=>{feedback.delete(dialogRep);dialog.close();render();};
$('cr-export').onclick=()=>{if(!raw||!analysis)return;const url=URL.createObjectURL(new Blob([JSON.stringify({format:'coach-squat-session',version:1,track:trackSession(raw),settings:{view:$('cr-view').value},feedback:Object.fromEntries(feedback),analysis:{method:'provisional-squat-rules-v1',reps:analysis.reps},notes:'Detector landmarks only. Estimated muscle activation is not measured EMG; feedback is supporting context.'})],{type:'application/json'}));const a=el('a');a.href=url;a.download='coach-squat-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
window.CoachReview={activationAt,frame,setPage(id){if(page===id)return;page=id;recalculate();},reset(){raw=null;analysis=null;feedback.clear();render();frame(0);},getState:()=>({analysis,feedback,page,selected})};
window.addEventListener('coach:track',e=>load(e.detail));
const existing=window.CoachBridge?.getTrack();if(existing)load(existing);else render();
