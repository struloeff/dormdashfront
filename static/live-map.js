// Live map on the tracking pages: the real route, with the driver moving
// along it in step with the demo order's status timeline.
(function () {
  const token = new URLSearchParams(location.search).get('token');
  if (!token || !window.DD_DEMO || !window.L || !window.DD) return;

  const C = DD.CAMPUS;
  let map, car, legs = null, kind = 'food', built = false, building = false, order = null;

  function pin(color, size, label) {
    return L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<div class="dd-live-pin" style="width:${size}px;height:${size}px;background:${color};box-shadow:0 0 0 5px ${color}40,0 4px 12px rgba(0,0,0,.6)" title="${label || ''}"></div>` });
  }

  function prepare(coords) {
    const cum = [0];
    for (let i = 1; i < coords.length; i++) {
      cum.push(cum[i - 1] + DD.haversineMiles({ lat: coords[i - 1][0], lng: coords[i - 1][1] }, { lat: coords[i][0], lng: coords[i][1] }));
    }
    return { coords, cum, len: cum[cum.length - 1] || 1 };
  }
  function pointAt(p, f) {
    const d = Math.max(0, Math.min(1, f)) * p.len;
    let i = p.cum.findIndex(c => c >= d);
    if (i <= 0) return p.coords[Math.max(0, i)];
    const seg = p.cum[i] - p.cum[i - 1] || 1, t = (d - p.cum[i - 1]) / seg;
    const a = p.coords[i - 1], b = p.coords[i];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  const ease = f => f < .5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;

  // A driver running the order by hand (the driver demo): follow their status
  // changes, easing along each leg from the moment they reported it.
  const LEG_MS = 25000;
  function manualPhase(o, now) {
    const since = f => Math.min(.92, Math.max(0, (now - (Date.parse(o[f]) || now)) / LEG_MS));
    const waitLabel = o.status === 'Pending' ? 'Finding a driver' : o.status === 'Claimed' ? 'Driver assigned'
      : o.status === 'Payment Successful' ? 'Driver getting ready' : 'Waiting for payment';
    if (o.status === 'Cancelled') return { at: 'start', label: 'Order cancelled' };
    if (kind === 'food') {
      if (o.status === 'Heading to Restaurant') return { leg: 0, f: since('heading_to_restaurant_at'), label: 'Heading to the restaurant' };
      if (o.status === 'Picked Up') return { at: 'mid', label: 'Picking up your order' };
      if (o.status === 'In Progress') return { leg: 1, f: since('in_progress_at'), label: 'On the way to you' };
      if (o.status === 'Delivered') return { at: 'end', label: 'Delivered', done: true };
      return { at: 'start', label: waitLabel };
    }
    if (o.status === 'Heading to Pickup') return { leg: 0, f: since('heading_to_pickup_at'), label: 'Driver on the way' };
    if (o.status === 'In Progress') return { leg: 1, f: since('in_progress_at'), label: 'On your trip' };
    if (o.status === 'Completed') return { at: 'end', label: 'Arrived', done: true };
    return { at: 'start', label: waitLabel };
  }

  // Where the driver is, from the order's own timestamps
  function phase(o, now) {
    if (o.driver_controlled) return manualPhase(o, now);
    const post = DD_DEMO.POST_PAY[kind];
    const off = name => (post.find(p => p[0] === name) || [0, 0])[1];
    let base = o._paid_ms;
    if (kind === 'rideshare' && base && o.scheduled_for) {
      const sched = new Date(o.scheduled_for).getTime();
      if (!isNaN(sched)) base = Math.max(base, sched - 5000);
    }
    const waitLabel = o.status === 'Pending' ? 'Finding a driver' : o.status === 'Claimed' ? 'Driver assigned' : 'Waiting for payment';
    if (o.status === 'Cancelled') return { at: 'start', label: 'Order cancelled' };
    if (kind === 'food') {
      if (!base || now < base + off('Heading to Restaurant')) return { at: 'start', label: waitLabel };
      const a0 = base + off('Heading to Restaurant'), a1 = base + off('Picked Up'), b0 = base + off('In Progress'), b1 = base + off('Delivered');
      if (now < a1) return { leg: 0, f: (now - a0) / (a1 - a0), label: 'Heading to the restaurant' };
      if (now < b0) return { at: 'mid', label: 'Picking up your order' };
      if (now < b1) return { leg: 1, f: (now - b0) / (b1 - b0), label: 'On the way to you' };
      return { at: 'end', label: 'Delivered', done: true };
    }
    if (!base || now < base + off('Heading to Pickup')) return { at: 'start', label: waitLabel };
    const a0 = base + off('Heading to Pickup'), a1 = base + off('In Progress'), b1 = base + off('Completed');
    if (now < a1) return { leg: 0, f: (now - a0) / (a1 - a0), label: 'Driver on the way' };
    if (now < b1) return { leg: 1, f: (now - a1) / (b1 - a1), label: 'On your trip' };
    return { at: 'end', label: 'Arrived', done: true };
  }

  function etaMinutes(ph) {
    if (!legs || ph.done) return 0;
    if (ph.leg === 0) return legs[0].minutes * (1 - ph.f) + legs[1].minutes + (kind === 'food' ? 4 : 1);
    if (ph.leg === 1) return legs[1].minutes * (1 - ph.f);
    if (ph.at === 'mid') return legs[1].minutes + 2;
    return legs[0].minutes + legs[1].minutes + (kind === 'food' ? 6 : 2);
  }

  async function build(o) {
    building = true;
    kind = o.service_type === 'rideshare' ? 'rideshare' : 'food';
    const host = document.getElementById('orderContent');
    const card = document.createElement('div');
    card.className = 'dd-live' + (kind === 'rideshare' ? ' is-ride' : '');
    card.innerHTML = '<div class="dd-live-map" id="ddLiveMap"></div>' +
      '<div class="dd-live-chip"><span class="dd-live-dot"></span><b id="ddLiveLabel">Loading map…</b><span id="ddLiveEta"></span></div>';
    host.insertBefore(card, host.firstChild);

    map = L.map('ddLiveMap', { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
    DD.baseLayer().addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    map.setView([C.lat, C.lng], 12);

    let a, b, c;
    if (kind === 'food') {
      const rest = { lat: o.pickup_lat, lng: o.pickup_lng };
      if (!rest.lat) { card.remove(); return; }
      a = C; b = rest; c = C;
    } else {
      const p = { lat: o.pickup_lat, lng: o.pickup_lng }, d = { lat: o.dropoff_lat, lng: o.dropoff_lng };
      if (!p.lat || !d.lat) { card.remove(); return; }
      a = { lat: p.lat + 0.012, lng: p.lng - 0.018 }; b = p; c = d;
    }
    const [l0, l1] = await Promise.all([DD.route(a, b), DD.route(b, c)]);
    legs = [l0, l1].map(l => ({ ...l, path: prepare(l.coords) }));
    const accent = kind === 'rideshare' ? '#7c6cf6' : '#FD2D00';
    L.polyline(l0.coords, { color: '#ffffff', weight: 3, opacity: .35, dashArray: '6 8' }).addTo(map);
    const main = L.polyline(l1.coords, { color: accent, weight: 5, opacity: .95 }).addTo(map);
    if (kind === 'food') {
      L.marker([b.lat, b.lng], { icon: pin('#FD2D00', 16, 'Restaurant'), interactive: false }).addTo(map);
      L.marker([c.lat, c.lng], { icon: pin('#10b981', 16, 'Your dorm'), interactive: false }).addTo(map);
    } else {
      L.marker([b.lat, b.lng], { icon: pin('#10b981', 16, 'Pickup'), interactive: false }).addTo(map);
      L.marker([c.lat, c.lng], { icon: pin(accent, 16, 'Drop-off'), interactive: false }).addTo(map);
    }
    car = L.marker([a.lat, a.lng], { zIndexOffset: 1000, interactive: false, icon: L.divIcon({ className: '', iconSize: [36, 36], iconAnchor: [18, 18],
      html: `<div class="dd-live-car"><svg class="ic" aria-hidden="true"><use href="/static/icons.svg#i-${kind === 'rideshare' ? 'car' : 'bike'}"/></svg></div>` }) }).addTo(map);
    map.fitBounds(L.latLngBounds([...l0.coords, ...l1.coords]), { paddingTopLeft: [40, 64], paddingBottomRight: [64, 40], maxZoom: 14 });
    built = true; building = false;
    requestAnimationFrame(frame);
  }

  let lastRead = 0;
  function frame(now) {
    if (!built) return;
    if (now - lastRead > 700 || !order) { order = DD_DEMO.byToken(token) || order; lastRead = now; }
    if (!order) return requestAnimationFrame(frame);
    const ph = phase(order, Date.now());
    let pos;
    if (ph.leg != null) pos = pointAt(legs[ph.leg].path, ease(Math.max(0, Math.min(1, ph.f))));
    else if (ph.at === 'start') pos = legs[0].path.coords[0];
    else if (ph.at === 'mid') pos = legs[1].path.coords[0];
    else pos = legs[1].path.coords[legs[1].path.coords.length - 1];
    car.setLatLng(pos);
    const label = document.getElementById('ddLiveLabel'), eta = document.getElementById('ddLiveEta');
    if (label && label.textContent !== ph.label) label.textContent = ph.label;
    if (eta) {
      const m = Math.ceil(etaMinutes(ph));
      const t = ph.done ? '' : `${m} min`;
      if (eta.textContent !== t) eta.textContent = t;
    }
    document.querySelector('.dd-live')?.classList.toggle('is-done', !!ph.done);
    requestAnimationFrame(frame);
  }

  // Build once the page has loaded the order and shown it
  const watch = setInterval(() => {
    const host = document.getElementById('orderContent');
    if (!host || host.offsetHeight === 0 || built || building) return;
    const o = DD_DEMO.byToken(token);
    if (!o) return;
    clearInterval(watch);
    order = o;
    build(o).catch(() => { building = false; });
  }, 400);
})();
