// Map framing that accounts for where the sheet actually is: a side panel on
// wide screens, a bottom sheet on phones.
(function () {
  function barH() {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dd-bar-h')) || 0;
  }

  // Visible map area not covered by the sheet or the top bar
  function freeArea() {
    const W = window.innerWidth, H = window.innerHeight;
    const top = barH() + 64;
    const s = document.getElementById('bottomSheet');
    const r = s ? s.getBoundingClientRect() : null;
    // (offsetParent is always null for a fixed element, so measure instead)
    if (!r || !r.width || !r.height) return { side: false, top, left: 0, right: W, bottom: H, W, H };
    if (r.left > W * 0.35) return { side: true, top, left: 0, right: r.left, bottom: H, W, H };
    return { side: false, top, left: 0, right: W, bottom: Math.max(top + 80, r.top), W, H };
  }

  function padding() {
    const a = freeArea();
    return {
      paddingTopLeft: [a.side ? 48 : 28, a.top + 16],
      paddingBottomRight: [a.W - a.right + (a.side ? 48 : 28), a.H - a.bottom + 28]
    };
  }

  // Fit bounds into the uncovered part of the map
  function fit(map, bounds, opts) {
    if (!map || !bounds || !bounds.isValid || !bounds.isValid()) return;
    map.invalidateSize();
    map.fitBounds(bounds, Object.assign({ maxZoom: 15, animate: true }, padding(), opts || {}));
  }

  // Centre a point in the uncovered part of the map
  function center(map, latlng, zoom, opts) {
    if (!map) return;
    map.invalidateSize();
    const a = freeArea();
    const z = zoom == null ? map.getZoom() : zoom;
    const target = map.project(L.latLng(latlng), z);
    const dx = (a.W / 2) - (a.left + a.right) / 2;
    const dy = (a.H / 2) - (a.top + a.bottom) / 2;
    map.setView(map.unproject(target.add([dx, dy]), z), z, Object.assign({ animate: true }, opts || {}));
  }

  // Refit after the sheet finishes its transition
  function refit(map, getBounds, delay) {
    setTimeout(() => {
      const b = getBounds && getBounds();
      if (b) fit(map, b); else if (map) map.invalidateSize();
    }, delay == null ? 380 : delay);
  }

  window.DDMap = { fit, center, refit, padding, freeArea };
  window.addEventListener('resize', () => {
    if (window.ddMap && window.ddLastBounds) refit(window.ddMap, () => window.ddLastBounds, 150);
  });
})();
