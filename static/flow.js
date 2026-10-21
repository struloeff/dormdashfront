// One back button in the step-dot row. It presses the active step's own Back
// button, so the page's original navigation logic still runs.
(function () {
  function init() {
    const row = document.querySelector('.bottom-sheet .step-indicator');
    if (!row) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fx-back';
    btn.setAttribute('aria-label', 'Back');
    row.appendChild(btn);
    const activeBack = () => document.querySelector('.bottom-sheet .step.active .back-btn');
    const sync = () => {
      const b = activeBack();
      // Shown when the active step has a Back the page has not hidden itself
      btn.classList.toggle('is-on', !!b && b.style.display !== 'none' && !b.hidden);
    };
    btn.addEventListener('click', () => { const b = activeBack(); if (b) b.click(); });
    new MutationObserver(sync).observe(document.querySelector('.bottom-sheet'), { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
