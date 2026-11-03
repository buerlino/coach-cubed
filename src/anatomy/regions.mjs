// SPDX-License-Identifier: AGPL-3.0-or-later
/** Atlas attachment rules. Names are anatomical names from the source OBJ.
 * Word boundaries matter: tibialis is not tibia; subscapularis is not scapula.
 */
export function muscleGroup(name){
 const n=name.toLowerCase();
 for(const [re,g] of [[/rectus femoris|vastus/,'quads'],[/gluteus/,'glutes'],[/adductor|gracilis/,'adductors'],[/biceps femoris|semitend|semimembr/,'hamstrings'],[/gastrocnemius|soleus/,'calves'],[/iliocostalis|longissimus|spinalis|multifid/,'erectors'],[/abdominis|oblique/,'abdominals'],[/deltoid/,'deltoids'],[/biceps brachii|brachialis|brachioradialis/,'elbow-flexors'],[/triceps/,'triceps'],[/pectoralis/,'pectorals'],[/trapezius/,'trapezius']])if(re.test(n))return g;
 return 'context';
}
export function regionFor(part){
 const n=part.name.toLowerCase(),b=part.bounds,mid=(b[0][1]+b[1][1])/2;
 const side=/\bleft\b/.test(n)?'left':/\bright\b/.test(n)?'right':(b[0][0]+b[1][0]>0?'left':'right');
 if(part.system==='skeletal'){
  if(/hip bone|\bsacrum\b|coccyx|pubis|ischium|ilium/.test(n))return ['pelvis'];
  if(/\bfemur\b|\bpatella\b/.test(n))return [side+'Thigh'];
  if(/\btibia\b|\bfibula\b/.test(n))return [side+'Shin'];
  if(/\bhumerus\b/.test(n))return [side+'Arm'];
  if(/\bradius\b|\bulna\b/.test(n))return [side+'Forearm'];
  if(/\bscapula\b|\bclavicle\b/.test(n))return [side+'Girdle'];
  // Cuneiform cartilage is in the larynx; cuneiform bones are in the foot.
  if(mid<.13)return [side+'Foot'];
  if(/hand|finger|carpal|pollex|thumb|capitate|hamate|lunate|pisiform|scaphoid|trapezium|trapezoid|triquetral/.test(n))return [side+'Hand'];
  if(/cervical|\batlas\b|\baxis\b/.test(n)||mid>1.47)return ['head'];
  if(/vertebra/.test(n))return [mid<1.06?'lumbar':mid<1.17?'lowerThorax':mid<1.31?'midThorax':'upperThorax'];
  if(/rib|stern|manubrium|xiphoid/.test(n))return [mid<1.27?'midThorax':'upperThorax'];
  return ['upperThorax'];
 }
 const group=muscleGroup(n);
 if(['quads','hamstrings','adductors'].includes(group)||/sartorius|iliotibial/.test(n))return [side+'Thigh','pelvis',side+'Shin'];
 if(group==='glutes'||/iliacus|psoas/.test(n))return ['pelvis',side+'Thigh','lumbar'];
 if(group==='calves'||/tibialis|fibularis/.test(n))return [side+'Shin',side+'Foot',side+'Thigh'];
 if(group==='deltoids'||/coracobrachialis|subscapularis|infraspinatus|supraspinatus|teres major/.test(n))return [side+'Arm',side+'Girdle'];
 if(['elbow-flexors','triceps'].includes(group))return [side+'Arm',side+'Forearm',side+'Girdle'];
 if(group==='pectorals')return [side+'Arm',side+'Girdle','midThorax','upperThorax'];
 if(group==='trapezius'||/levator scapulae/.test(n))return [side+'Girdle','midThorax','upperThorax','head'];
 if(group==='erectors')return ['pelvis','lumbar','lowerThorax','midThorax','upperThorax',...(/capitis|cervicis/.test(n)?['head']:[])];
 return ['pelvis','lumbar','lowerThorax','midThorax','upperThorax'];
}
