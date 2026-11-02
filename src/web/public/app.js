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
