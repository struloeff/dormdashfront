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

// Phones: drag the sheet down by its handle to see the map, back up to
// continue. Snaps open or to a short peek; a tap on the handle toggles.
(function () {
  const PEEK = 148;               // px of sheet left showing when folded
  function init() {
    const sheet = document.getElementById('bottomSheet');
    if (!sheet) return;
    const zones = [sheet.querySelector('.sheet-handle'), sheet.querySelector('.step-indicator')].filter(Boolean);
    if (!zones.length) return;
    const small = () => window.innerWidth < 900;
    let folded = false, startY = 0, startOff = 0, lastY = 0, lastT = 0, vel = 0, dragging = false, moved = false;

    const maxOff = () => Math.max(0, sheet.getBoundingClientRect().height - PEEK);
    const setOff = (px, animate) => {
      sheet.style.transition = animate ? 'translate .34s cubic-bezier(.2,.8,.2,1)' : 'none';
      sheet.style.translate = px ? `0 ${px}px` : '';
    };
    const refit = () => {
      if (window.DDMap && window.ddMap) DDMap.refit(window.ddMap, () => window.ddLastBounds, 360);
    };
    const fold = (on) => {
      folded = on && small();
      sheet.classList.toggle('is-folded', folded);
      setOff(folded ? maxOff() : 0, true);
      refit();
    };
    window.DDSheet = { fold, isFolded: () => folded };

    const down = (e) => {
      if (!small()) return;
      if (e.target.closest('button, a, input, select, textarea')) return;
      dragging = true; moved = false;
      startY = lastY = e.clientY; lastT = performance.now(); vel = 0;
      startOff = folded ? maxOff() : 0;
      sheet.style.transition = 'none';
      e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
    };
    const move = (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      const now = performance.now();
      vel = (e.clientY - lastY) / Math.max(1, now - lastT);
      lastY = e.clientY; lastT = now;
      const m = maxOff();
      let off = startOff + dy;
      if (off < 0) off = off / 4;                       // resist past fully open
      if (off > m) off = m + (off - m) / 4;             // and past the peek
      setOff(off, false);
    };
    const up = (e) => {
      if (!dragging) return;
      dragging = false;
      if (!moved) { fold(!folded); return; }            // tap toggles
      const off = startOff + (e.clientY - startY);
      if (vel > 0.45) fold(true);
      else if (vel < -0.45) fold(false);
      else fold(off > maxOff() / 2);
    };
    zones.forEach(z => {
      z.classList.add('fx-drag');
      z.addEventListener('pointerdown', down);
      z.addEventListener('pointermove', move);
      z.addEventListener('pointerup', up);
      z.addEventListener('pointercancel', up);
    });

    // Opening a new step, or typing, brings the sheet back up
    let lastStep = sheet.querySelector('.step.active');
    new MutationObserver(() => {
      const cur = sheet.querySelector('.step.active');
      if (cur !== lastStep) { lastStep = cur; if (folded) fold(false); }
      if (folded && !dragging) setOff(maxOff(), false);   // keep the peek right as content changes
    }).observe(sheet, { subtree: true, attributes: true, attributeFilter: ['class'] });
    sheet.addEventListener('focusin', () => { if (folded) fold(false); });
    window.addEventListener('resize', () => { if (!small() && folded) fold(false); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
