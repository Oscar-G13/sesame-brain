document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied ✓';
      button.setAttribute('aria-label', 'MCP address copied');
      setTimeout(() => { button.textContent = 'Copy ↗'; }, 2200);
    } catch {
      const text = button.closest('.copy-row').querySelector('code');
      const range = document.createRange(); range.selectNodeContents(text);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      button.textContent = 'Select & copy';
    }
  });
});

const brainSelector=document.querySelector('#brain-selector');
if(brainSelector)brainSelector.addEventListener('change',()=>brainSelector.form.requestSubmit());
document.querySelectorAll('[data-pending-label]').forEach(form=>form.addEventListener('submit',()=>{if(!form.checkValidity())return;const button=form.querySelector('button[type="submit"]');if(button){button.disabled=true;button.textContent=form.dataset.pendingLabel;}}));

const jobView=document.querySelector('[data-job-state-url]');
if(jobView&&['queued','running'].includes(jobView.dataset.jobState)){
 let stopped=false;
 const poll=async()=>{
  if(stopped)return;
  if(document.visibilityState!=='visible'){setTimeout(poll,5000);return;}
  try{const response=await fetch(jobView.dataset.jobStateUrl,{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store'});if(response.status===401||response.redirected){stopped=true;return;}if(response.ok){const current=await response.json();if(current.state!==jobView.dataset.jobState){window.location.reload();return;}}}catch{}
  setTimeout(poll,5000);
 };
 setTimeout(poll,5000);window.addEventListener('pagehide',()=>{stopped=true;},{once:true});
}

function drawProjectLinks(){
 document.querySelectorAll('[data-project-links]').forEach(board=>{
  const plane=board.querySelector('.project-board-plane'),svg=plane?.querySelector('svg'),group=svg?.querySelector('g');if(!plane||!svg||!group)return;
  const bounds=plane.getBoundingClientRect();svg.setAttribute('viewBox',`0 0 ${bounds.width} ${bounds.height}`);svg.setAttribute('width',String(bounds.width));svg.setAttribute('height',String(bounds.height));group.replaceChildren();
  let links=[];try{links=JSON.parse(board.dataset.projectLinks);}catch{}
  for(const link of links){const prerequisite=board.querySelector(`[data-project-item="${CSS.escape(link.to_item_id)}"]`),dependent=board.querySelector(`[data-project-item="${CSS.escape(link.from_item_id)}"]`);if(!prerequisite||!dependent||!prerequisite.getClientRects().length||!dependent.getClientRects().length)continue;const a=prerequisite.getBoundingClientRect(),b=dependent.getBoundingClientRect(),horizontal=b.left>=a.right||a.left>=b.right;let d;if(horizontal){const forward=b.left>a.left,x1=(forward?a.right:a.left)-bounds.left,y1=a.top+a.height/2-bounds.top,x2=(forward?b.left:b.right)-bounds.left,y2=b.top+b.height/2-bounds.top,middle=(x1+x2)/2;d=`M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`;}else{const downward=b.top+b.height/2>=a.top+a.height/2,x1=a.left+a.width/2-bounds.left,y1=(downward?a.bottom:a.top)-bounds.top,x2=b.left+b.width/2-bounds.left,y2=(downward?b.top:b.bottom)-bounds.top,curve=Math.max(16,Math.abs(y2-y1)/2),direction=downward?1:-1;d=`M ${x1} ${y1} C ${x1} ${y1+direction*curve}, ${x2} ${y2-direction*curve}, ${x2} ${y2}`;}const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',d);path.dataset.fromItem=link.to_item_id;path.dataset.toItem=link.from_item_id;path.setAttribute('marker-end','url(#dependency-arrow)');group.append(path);}
 });
}
let projectResize;function observeProjectBoard(){projectResize?.disconnect();const board=document.querySelector('.project-board-plane');if(board){projectResize=new ResizeObserver(()=>requestAnimationFrame(drawProjectLinks));projectResize.observe(board);}drawProjectLinks();}
observeProjectBoard();
document.addEventListener('input',event=>{const form=event.target.closest('[data-project-draft]');if(form)form.dataset.dirty='true';});
document.addEventListener('change',event=>{const form=event.target.closest('[data-project-draft]');if(form)form.dataset.dirty='true';});
document.addEventListener('click',event=>{const button=event.target.closest('[data-discard-project-draft]');if(button){const form=button.closest('form');form.reset();form.dataset.dirty='false';const version=document.querySelector('[data-project-version]')?.dataset.projectVersion;const expected=form.querySelector('[name="expected_version"]');if(version&&expected)expected.value=version;const restored=form.querySelector('[data-restored-project-draft]');if(restored){restored.remove();form.querySelector('input:not([type=hidden]),textarea,select')?.focus();}}});
const liveProject=document.querySelector('[data-project-state-url]');
if(liveProject){
 let pending,stopped=false,failures=0,lastProjectFocus;
 document.addEventListener('focusin',event=>{const form=event.target.closest('[data-project-draft]');if(form)lastProjectFocus=event.target.closest('[data-project-canvas]')?event.target:undefined;});
 const prompt=liveProject.querySelector('.project-update-prompt');
 const acknowledge=()=>fetch(liveProject.dataset.projectAckUrl,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:liveProject.dataset.csrf})}).catch(()=>{});
 function draftControls(form){return [...form.elements].filter(field=>field instanceof HTMLInputElement||field instanceof HTMLTextAreaElement||field instanceof HTMLSelectElement);}
 function captureDrafts(canvas){return [...canvas.querySelectorAll('[data-project-draft][data-dirty="true"]')].map(form=>{const controls=draftControls(form);return{action:form.getAttribute('action'),fields:controls.map((field,index)=>({name:field.name,tag:field.tagName,type:field.type,index:controls.slice(0,index).filter(other=>other.name===field.name&&other.tagName===field.tagName&&other.type===field.type).length,value:field.value,checked:field.checked,selected:field instanceof HTMLSelectElement?[...field.selectedOptions].map(option=>option.value):undefined})),focus:form.contains(lastProjectFocus)?{index:controls.indexOf(lastProjectFocus),start:lastProjectFocus.selectionStart,end:lastProjectFocus.selectionEnd}:undefined};});}
 function restoreDrafts(canvas,drafts){let focus;for(const draft of drafts){const form=[...canvas.querySelectorAll('[data-project-draft]')].find(candidate=>candidate.getAttribute('action')===draft.action);if(!form)continue;const controls=draftControls(form);for(const saved of draft.fields){const field=controls.filter(candidate=>candidate.name===saved.name&&candidate.tagName===saved.tag&&candidate.type===saved.type)[saved.index];if(!field||saved.name==='_csrf')continue;field.value=saved.value;if(field instanceof HTMLInputElement&&(field.type==='checkbox'||field.type==='radio'))field.checked=saved.checked;if(field instanceof HTMLSelectElement&&saved.selected)for(const option of field.options)option.selected=saved.selected.includes(option.value);}
  form.dataset.dirty='true';const disclosure=form.closest('details');if(disclosure)disclosure.open=true;const notice=document.createElement('div');notice.dataset.restoredProjectDraft='true';const explanation=document.createElement('p');explanation.className='compose-hint';explanation.setAttribute('role','status');explanation.textContent='Your draft is kept. Saving will ask you to review the newer version before it can be applied.';const discard=document.createElement('button');discard.type='button';discard.className='dash-button outline';discard.dataset.discardProjectDraft='';discard.textContent='Discard this draft';notice.append(explanation,discard);form.prepend(notice);if(draft.focus&&controls[draft.focus.index])focus={field:controls[draft.focus.index],...draft.focus};
 }return focus;}
 function apply(){if(!pending)return;const update=pending,canvas=liveProject.querySelector('[data-project-canvas]'),drafts=captureDrafts(canvas);pending=undefined;canvas.innerHTML=update.html;const focus=restoreDrafts(canvas,drafts);liveProject.dataset.projectVersion=String(update.version);document.querySelectorAll('[name="expected_version"]').forEach(input=>{if(input.closest('form')?.dataset.dirty!=='true')input.value=String(update.version);});document.querySelector('[data-live-project-title]').textContent=update.project.title;document.querySelector('[data-live-project-goal]').textContent=update.project.goal||'';prompt.hidden=true;applyProjectFilters();observeProjectBoard();if(focus){focus.field.focus({preventScroll:true});if(typeof focus.start==='number'&&typeof focus.end==='number')focus.field.setSelectionRange?.(focus.start,focus.end);}acknowledge();}
 prompt.querySelector('[data-apply-project-update]')?.addEventListener('click',apply);
 async function poll(){
  if(stopped)return;if(document.visibilityState!=='visible'){setTimeout(poll,5000);return;}
  try{const url=new URL(liveProject.dataset.projectStateUrl,location.origin);url.searchParams.set('version',String(pending?.version??liveProject.dataset.projectVersion));const response=await fetch(url,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});if(response.status===404||response.status===401||response.redirected){stopped=true;return;}if(!response.ok)throw new Error('Unavailable');const update=await response.json();failures=0;if(update.receiptsHtml){const receipts=liveProject.querySelector('[data-project-receipts]');if(receipts&&receipts.innerHTML!==update.receiptsHtml)receipts.innerHTML=update.receiptsHtml;}if(update.changed){pending=update;const dirty=document.querySelector('[data-project-draft][data-dirty="true"]'),focused=document.activeElement?.closest('[data-project-canvas]');if(dirty||focused)prompt.hidden=false;else apply();}}
  catch{failures++;if(failures>=3){prompt.hidden=false;prompt.querySelector('span').textContent='Live updates are paused. Reload this project to reconnect.';}}
  setTimeout(poll,failures?15000:5000);
 }
 setTimeout(poll,5000);window.addEventListener('pagehide',()=>{stopped=true;projectResize?.disconnect();},{once:true});
}

function applyProjectFilters(){
 const type=document.querySelector('[data-project-type-filter]')?.value||'all',review=document.querySelector('[data-project-review-filter]')?.checked;
 document.querySelectorAll('[data-project-type]').forEach(lane=>{lane.hidden=type!=='all'&&lane.dataset.projectType!==type;lane.querySelectorAll('[data-project-item]').forEach(item=>{item.hidden=Boolean(review&&item.dataset.reviewNeeded!=='true');});});
 requestAnimationFrame(drawProjectLinks);
}
document.querySelector('[data-project-type-filter]')?.addEventListener('change',applyProjectFilters);
document.querySelector('[data-project-review-filter]')?.addEventListener('change',applyProjectFilters);
document.addEventListener('click',event=>{const link=event.target.closest('a[href^="#project-item-"]');if(link){const type=document.querySelector('[data-project-type-filter]'),review=document.querySelector('[data-project-review-filter]');if(type)type.value='all';if(review)review.checked=false;applyProjectFilters();}});

function highlightProjectEdges(id){document.querySelectorAll('.project-dependency-lines g path').forEach(path=>{path.classList.toggle('edge-active',Boolean(id&&(path.dataset.fromItem===id||path.dataset.toItem===id)));path.classList.toggle('edge-muted',Boolean(id&&path.dataset.fromItem!==id&&path.dataset.toItem!==id));});}
document.addEventListener('pointerover',event=>{const item=event.target.closest('[data-project-item]');if(item)highlightProjectEdges(item.dataset.projectItem);});
document.addEventListener('pointerout',event=>{const item=event.target.closest('[data-project-item]');if(item&&!item.contains(event.relatedTarget))highlightProjectEdges(undefined);});
document.addEventListener('focusin',event=>{const item=event.target.closest('[data-project-item]');if(item)highlightProjectEdges(item.dataset.projectItem);});
document.addEventListener('focusout',event=>{const item=event.target.closest('[data-project-item]');if(item&&!item.contains(event.relatedTarget))highlightProjectEdges(undefined);});
