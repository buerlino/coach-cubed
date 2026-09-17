document.body.dataset.workspace='original';
// Each interface is a real page. The anatomy workspace is the user's original
// movement-lab UI extended with the original diagnostic engine, not a reskin.
const label=document.createElement('span');label.className='ui-switch';label.textContent='Original UI · Version 5';
const link=document.createElement('a');link.href='/squat/';link.textContent='Open anatomy workspace';link.style.cssText='margin-left:14px;color:var(--accent);font-size:13px';
document.querySelector('.app-header').append(label,link);
