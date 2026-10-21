// DormDash demo backend.
//
// The original customer pages talked to a Flask API (main.py) plus Socket.IO.
// The server is gone, so this file answers those same /api/* requests inside
// the browser with responses shaped like the ones main.py returned. The page
// code itself is the original code, unchanged in how it calls the API.
//
// Nothing leaves the browser: demo orders (including any name or phone number
// typed into the form) live only in this browser's localStorage. Place search,
// reverse geocoding and routing go to OpenStreetMap services via static/geo.js.
//
// Load order: geo.js, then this file, then the page's own scripts.
(function () {
  'use strict';

  const realFetch = window.fetch.bind(window);
  const STORE_KEY = 'dormdash_demo_orders_v1';
  const CAMPUS = (window.DD && window.DD.CAMPUS) || { lat: 34.0407, lng: -118.7108 };

  /* ------------------------------------------------------------------
     Storage (localStorage, with an in-memory fallback)
  ------------------------------------------------------------------ */
  let memStore = null;
  function loadAll() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : { nextId: null, orders: {} };
    } catch (e) {
      return memStore || (memStore = { nextId: null, orders: {} });
    }
  }
  function saveAll(db) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
    catch (e) { memStore = db; }
  }
  function newId(db) {
    if (!db.nextId) db.nextId = 1000 + Math.floor(Math.random() * 900);
    return db.nextId++;
  }
  function newToken() {
    const bytes = new Uint8Array(32);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    let s = '';
    bytes.forEach(b => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const iso = ms => new Date(ms).toISOString();
  const round2 = n => Math.round(n * 100) / 100;

  /* ------------------------------------------------------------------
     Status timeline (compressed: the whole lifecycle takes about a minute)
     Uses the real status strings from main.py / the driver dashboard.
  ------------------------------------------------------------------ */
  const DRIVER = 'Demo Driver';
  // Before payment: offsets from when the order was placed.
  const PRE_PAY = {
    food: [['Claimed', 8000, 'claimed_at'], ['Awaiting Payment', 18000, 'awaiting_payment_at']],
    rideshare: [['Claimed', 8000, 'claimed_at'], ['Awaiting Payment', 16000, 'awaiting_payment_at']]
  };
  // After payment: offsets from when the customer paid.
  const POST_PAY = {
    food: [
      ['Heading to Restaurant', 5000, 'heading_to_restaurant_at'],
      ['Picked Up', 15000, 'picked_up_at'],
      ['In Progress', 22000, 'in_progress_at'],
      ['Delivered', 34000, 'delivered_at']
    ],
    rideshare: [
      ['Heading to Pickup', 5000, 'heading_to_pickup_at'],
      ['In Progress', 15000, 'in_progress_at'],
      ['Completed', 30000, 'delivered_at']
    ]
  };

  // A driver used to confirm the menu and fill in real prices before sending
  // the bill. In the demo, items without a price get a plausible one.
  function demoPrice(name) {
    let h = 0;
    for (const c of String(name || 'item')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return (4.99 + (h % 9)).toFixed(2);
  }

  // Same formula as PATCH /api/orders/<id>/menu-items in main.py
  function recomputeFoodBreakdown(order) {
    const old = order.cost_breakdown || {};
    const rate = parseFloat(old.sales_tax_rate || 0.0975);
    const miles = (order.route_summary && order.route_summary.miles) || old.miles || 0;
    const DELIVERY_FEE = 5.99, PER_MILE = 0.39, FAR_AWAY_FEE = 7.99, FAR = 10;
    const SERVICE = 0.15, CUT = 0.1732, FLAT = 0.49;
    const innout = (order.restaurant_name || '').includes('In-N-Out') ? 4.99 : 0;
    const food = (order.menu_items || []).reduce((s, i) => s + (parseFloat(i.price) || 0) * (parseInt(i.quantity) || 1), 0);
    const tax = food * rate, service = food * SERVICE;
    const mileage = miles * PER_MILE, far = miles > FAR ? FAR_AWAY_FEE : 0;
    const pool = DELIVERY_FEE + mileage + far + service + innout;
    const cut = pool * CUT;
    order.cost_breakdown = {
      delivery_fee: round2(DELIVERY_FEE), per_mile_rate: PER_MILE, mileage_cost: round2(mileage),
      far_away_fee: round2(far), innout_fee: round2(innout), service_charge: round2(service),
      fees_pool: round2(pool), fees_subtotal: round2(pool), platform_cut: round2(cut),
      platform_fee_flat: FLAT, driver_payout: round2(pool - cut), food_subtotal: round2(food),
      sales_tax: round2(tax), sales_tax_rate: rate, est_total: round2(pool + food + tax + FLAT), miles
    };
    order.driver_payout = round2(pool - cut + (parseFloat(order.tip_amount) || 0));
  }

  // Advance a stored order to wherever the clock says it should be.
  // Returns true if anything changed.
  function advance(o, now) {
    if (o.status === 'Cancelled') return false;
    const before = o.status;
    const kind = o.service_type === 'rideshare' ? 'rideshare' : 'food';
    for (const [status, offset, field] of PRE_PAY[kind]) {
      const at = o._created_ms + offset;
      if (now >= at && !o[field]) {
        o[field] = iso(at);
        if (!o.payment_confirmed) o.status = status;
        if (status === 'Claimed') { o.claimed_by = DRIVER; o.driver_name = DRIVER; }
        if (status === 'Awaiting Payment' && kind === 'food') {
          (o.menu_items || []).forEach(i => { if (!(parseFloat(i.price) > 0)) i.price = demoPrice(i.name); });
          recomputeFoodBreakdown(o);
        }
      }
    }
    if (o.payment_confirmed && o._paid_ms) {
      // A scheduled ride waits for its pickup time before the driver heads out.
      let base = o._paid_ms;
      if (kind === 'rideshare' && o.scheduled_for) {
        const sched = new Date(o.scheduled_for).getTime();
        if (!isNaN(sched)) base = Math.max(base, sched - 5000);
      }
      for (const [status, offset, field] of POST_PAY[kind]) {
        const at = base + offset;
        if (now >= at && !o[field]) {
          o[field] = iso(at);
          o.status = status;
          if (status === 'Delivered') o.delivery_photo_url = '/static/demo-delivery-photo.svg';
        }
      }
    }
    if (o.status !== before) { o.updated_at = iso(now); return true; }
    return false;
  }

  function advanceAll() {
    const db = loadAll();
    const now = Date.now();
    let changed = false;
    Object.values(db.orders).forEach(o => { if (advance(o, now)) changed = true; });
    if (changed) saveAll(db);
    return db;
  }

  function publicOrder(o) {
    const out = {};
    Object.keys(o).forEach(k => { if (k[0] !== '_') out[k] = o[k]; });
    return JSON.parse(JSON.stringify(out));
  }

  function blankOrder(fields) {
    const now = Date.now();
    return Object.assign({
      id: null, restaurant_id: null, restaurant_name: '', customer_name: '', delivery_address: '',
      order_details: '', phone_number: '', contact_method: 'drop off', status: 'Pending',
      claimed_by: null, driver_name: null, created_at: iso(now), updated_at: iso(now),
      restaurant_address: '', menu_items: null, cost_breakdown: null, route_summary: null,
      driver_payout: 0, claimed_at: null, picked_up_at: null, in_progress_at: null, delivered_at: null,
      awaiting_payment_at: null, payment_confirmed: false, payment_confirmed_at: null,
      heading_to_restaurant_at: null, heading_to_pickup_at: null, delivery_photo_url: null,
      cancellation_reason: null, cancelled_at: null, order_token: newToken(), tip_amount: 0,
      service_type: 'food', pickup_lat: null, pickup_lng: null, dropoff_lat: null, dropoff_lng: null,
      scheduled_for: null, customer_feedback: null, rating: null, feedback_submitted_at: null,
      delivery_confirmed: false, delivery_confirmed_at: null, payout_on_hold: false, hold_reason: null,
      reversal_status: null, _created_ms: now, _paid_ms: null
    }, fields);
  }

  /* ------------------------------------------------------------------
     Helpers for place search / routing (via static/geo.js)
  ------------------------------------------------------------------ */
  function durationText(minutes) {
    minutes = Math.max(0, Math.floor(minutes));
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
  }

  // Google polyline encoding (precision 5), what the `polyline` lib produced.
  function encodePolyline(coords) {
    let out = '', pLat = 0, pLng = 0;
    const enc = v => {
      v = v < 0 ? ~(v << 1) : (v << 1);
      let s = '';
      while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      return s + String.fromCharCode(v + 63);
    };
    for (const [lat, lng] of coords) {
      const la = Math.round(lat * 1e5), ln = Math.round(lng * 1e5);
      out += enc(la - pLat) + enc(ln - pLng);
      pLat = la; pLng = ln;
    }
    return out;
  }

  function placeResult(r, near) {
    const miles = window.DD.haversineMiles(near, { lat: r.lat, lng: r.lng });
    const seconds = Math.round((miles / 30) * 3600); // main.py: 30 mph estimate
    const text = durationText(seconds / 60);
    return {
      place_id: `osm_${r.lat.toFixed(6)}_${r.lng.toFixed(6)}`,
      name: r.name,
      address: r.address || 'Address unavailable',
      lat: r.lat,
      lng: r.lng,
      rating: null,
      distance_text: `${miles.toFixed(1)} mi`,
      duration_text: text,
      duration_seconds: seconds,
      return_duration_text: text,
      return_duration_seconds: seconds,
      distance_value: miles * 1609.34
    };
  }

  /* ------------------------------------------------------------------
     Route table
  ------------------------------------------------------------------ */
  const json = (body, status = 200) => ({ body, status });
  const notFound = () => json({ error: 'Not available in the demo' }, 404);

  function findByToken(db, token) {
    return Object.values(db.orders).find(o => o.order_token === token);
  }
  function findById(db, id) {
    return db.orders[String(id)];
  }
  function tokenOk(o, body) {
    // main.py required the order token on customer actions
    return o && (!body.order_token || body.order_token === o.order_token);
  }

  async function handle(method, path, query, body) {
    // --- Search / maps ---------------------------------------------------
    if (path === '/api/restaurants/search' && method === 'POST') {
      const q = (body.query || '').trim();
      if (!q) return json({ error: 'Error code: 4811' }, 400);
      const near = { lat: +body.lat || CAMPUS.lat, lng: +body.lng || CAMPUS.lng };
      const found = await window.DD.search(q, { near, limit: 8 });
      const results = found.map(r => placeResult(r, near));
      if (!results.length) {
        return json({ no_results: true, message: `No results found matching "${q}". Enter an address manually.`, allow_manual_entry: true });
      }
      return json(results);
    }
    if (path === '/api/geocode' && method === 'POST') {
      const address = (body.address || '').trim();
      if (!address) return json({ error: 'Error code: 9843' }, 400);
      const found = await window.DD.search(address, { near: CAMPUS, limit: 1 });
      if (!found.length) return json({ error: 'Error code: 5365' }, 404);
      const r = found[0];
      return json({ lat: r.lat, lng: r.lng, formatted_address: [r.name, r.address].filter(Boolean).join(', '), place_name: r.name });
    }
    if (path === '/api/reverse-geocode' && method === 'POST') {
      if (body.lat == null || body.lng == null) return json({ error: 'Error code: 7538' }, 400);
      const address = await window.DD.reverse(body.lat, body.lng);
      return json({ address, lat: body.lat, lng: body.lng });
    }
    if (path === '/api/directions' && method === 'POST') {
      const from = { lat: +body.origin_lat, lng: +body.origin_lng };
      const to = { lat: +body.dest_lat, lng: +body.dest_lng };
      if ([from.lat, from.lng, to.lat, to.lng].some(isNaN)) return json({ error: 'Error code: 9381' }, 404);
      const r = await window.DD.route(from, to);
      const seconds = r.minutes * 60;
      return json({
        distance_meters: Math.round(r.miles * 1609.344),
        distance_text: `${r.miles.toFixed(1)} mi`,
        duration_seconds: seconds,
        duration_text: durationText(r.minutes),
        duration_in_traffic_seconds: seconds,
        duration_in_traffic_text: durationText(r.minutes),
        polyline: encodePolyline(r.coords)
      });
    }
    if (path === '/api/sales-tax/calculate' && method === 'POST') {
      return json({ success: true, address: body.address || '', tax_rate: 0.0975, tax_percentage: 9.75 });
    }

    // --- Security (Turnstile, form tokens) -------------------------------
    if (path === '/api/security/validate-turnstile') {
      return json({ success: true, message: 'Token validated and cached' });
    }
    if (path === '/api/security/form-token') {
      return json({ token: newToken(), min_submit_time: 5, expires_in: 1800 });
    }

    // --- Orders ----------------------------------------------------------
    if (path === '/api/orders' && method === 'POST') {
      if (!body.restaurant_name || !body.customer_name || !body.delivery_address) return json({ error: 'Error code: 3700' }, 400);
      const db = loadAll();
      const tip = parseFloat(body.tip_amount) || 0;
      const o = blankOrder({
        id: newId(db),
        restaurant_id: body.restaurant_id || 'demo',
        restaurant_name: body.restaurant_name,
        customer_name: body.customer_name,
        delivery_address: body.delivery_address,
        order_details: body.order_details || '',
        phone_number: body.phone_number || '',
        contact_method: body.contact_method || 'call',
        restaurant_address: body.restaurant_address || '',
        menu_items: body.menu_items || null,
        cost_breakdown: body.cost_breakdown || null,
        route_summary: body.route_summary || null,
        driver_payout: round2((parseFloat(body.driver_payout) || 0) + tip),
        tip_amount: round2(tip),
        service_type: 'food'
      });
      db.orders[o.id] = o;
      saveAll(db);
      return json({ order_id: o.id, order_token: o.order_token, status: 'success', message: 'Order created successfully' }, 201);
    }

    if (path === '/api/rideshare/create' && method === 'POST') {
      const p = { lat: +body.pickup_lat, lng: +body.pickup_lng };
      const d = { lat: +body.dropoff_lat, lng: +body.dropoff_lng };
      if (!body.customer_name || [p.lat, p.lng, d.lat, d.lng].some(isNaN)) return json({ error: 'Error code: 4026' }, 400);
      const r = await window.DD.route(p, d);
      // Same pricing as create_rideshare_ride() in main.py
      const BASE_FARE = 4.99, PER_MILE = 0.89, PER_MINUTE = 0.39, CUT = 0.1732, FLAT = 0.49;
      const minutes = r.minutes;
      const tip = parseFloat(body.tip_amount) || 0;
      const mileage = r.miles * PER_MILE, time = minutes * PER_MINUTE;
      const total = BASE_FARE + mileage + time;
      const platformFee = total * CUT + FLAT;
      const payout = total * (1 - CUT) + tip;
      const hourly = minutes > 0 ? (payout / (minutes * 2)) * 60 : 0;
      const db = loadAll();
      const o = blankOrder({
        id: newId(db),
        restaurant_id: 'rideshare-ride',
        restaurant_name: `Rideshare: ${body.pickup_address || ''} → ${body.dropoff_address || ''}`,
        customer_name: body.customer_name,
        delivery_address: body.dropoff_address || '',
        order_details: body.notes || '',
        phone_number: body.phone_number || '',
        restaurant_address: body.pickup_address || '',
        service_type: 'rideshare',
        cost_breakdown: {
          base_fare: BASE_FARE, mileage_cost: round2(mileage), time_cost: round2(time),
          distance_miles: round2(r.miles), duration_minutes: minutes, per_mile_rate: PER_MILE,
          per_minute_rate: PER_MINUTE, hourly_rate: round2(hourly), total_fare: round2(total),
          platform_fee: round2(platformFee), platform_fee_flat: FLAT, driver_payout: round2(payout)
        },
        payout_amount: round2(payout),
        platform_fee: round2(platformFee),
        pickup_lat: p.lat, pickup_lng: p.lng, dropoff_lat: d.lat, dropoff_lng: d.lng,
        tip_amount: round2(tip),
        scheduled_for: body.scheduled_for || null
      });
      db.orders[o.id] = o;
      saveAll(db);
      return json({ order_id: o.id, order_token: o.order_token, total_fare: round2(total), driver_payout: round2(payout), status: 'success', message: 'Ride requested successfully' }, 201);
    }

    let m;
    if ((m = path.match(/^\/api\/orders\/by-token\/([^/]+)$/)) && method === 'GET') {
      const db = advanceAll();
      const o = findByToken(db, decodeURIComponent(m[1]));
      return o ? json(publicOrder(o)) : json({ error: 'Error code: 6042' }, 404);
    }

    if (path === '/api/orders/search' && method === 'GET') {
      const digits = (query.get('value') || '').replace(/\D/g, '');
      if (digits.length < 4) return json({ error: 'Error code: 9308' }, 400);
      const db = advanceAll();
      const list = Object.values(db.orders)
        .filter(o => (o.phone_number || '').replace(/\D/g, '').endsWith(digits) || (o.phone_number || '').replace(/\D/g, '') === digits)
        .sort((a, b) => b._created_ms - a._created_ms)
        .map(publicOrder);
      return json({ orders: list, pagination: { page: 1, per_page: 50, total: list.length, total_pages: list.length ? 1 : 0 } });
    }

    if ((m = path.match(/^\/api\/orders\/(\d+)(?:\/([a-z-]+))?$/))) {
      const id = m[1], action = m[2];
      const db = advanceAll();
      const o = findById(db, id);
      if (!o) return json({ error: 'Error code: 5940' }, 404);

      if (!action && method === 'GET') return json(publicOrder(o));

      if (action === 'create-payment' && method === 'POST') {
        if (!tokenOk(o, body)) return json({ error: 'Error code: 5041' }, 403);
        // No Stripe in the demo: mark the order paid and send the customer to
        // the page Stripe's success_url pointed at.
        if (!o.payment_confirmed) {
          const now = Date.now();
          o.payment_confirmed = true;
          o.payment_confirmed_at = iso(now);
          o._paid_ms = now;
          o.status = 'Payment Successful';
          o.updated_at = iso(now);
          saveAll(db);
        }
        const page = o.service_type === 'rideshare' ? '/ride-tracking.html' : '/track.html';
        return json({ checkout_url: `${page}?token=${encodeURIComponent(o.order_token)}&payment=success`, session_id: 'demo_' + o.id });
      }

      if (action === 'confirm-delivery' && method === 'POST') {
        if (!tokenOk(o, body)) return json({ error: 'Error code: 6993' }, 403);
        o.delivery_confirmed = !!body.was_delivered;
        o.delivery_confirmed_at = iso(Date.now());
        saveAll(db);
        return json({ success: true, message: 'Delivery confirmation recorded', was_delivered: !!body.was_delivered });
      }

      if (action === 'feedback' && method === 'POST') {
        if (!tokenOk(o, body)) return json({ error: 'Error code: 9693' }, 403);
        if (o.customer_feedback || o.rating) return json({ error: 'Feedback already submitted for this order' }, 400);
        const rating = parseInt(body.rating);
        if (!(rating >= 1 && rating <= 5)) return json({ error: 'Error code: 8477' }, 400);
        o.rating = rating;
        o.customer_feedback = body.feedback || '';
        o.feedback_submitted_at = iso(Date.now());
        saveAll(db);
        return json({ success: true, message: 'Feedback submitted successfully' });
      }

      if (action === 'dispute' && method === 'POST') {
        if (!tokenOk(o, body)) return json({ error: 'Error code: 6702' }, 403);
        if (o.payout_on_hold) return json({ error: 'Dispute already reported for this order', already_disputed: true }, 400);
        o.payout_on_hold = true;
        o.hold_reason = 'customer_dispute';
        o.reversal_status = 'pending_admin_review';
        o.updated_at = iso(Date.now());
        saveAll(db);
        return json({ success: true, message: 'Dispute reported - Admin will review and manually reverse transfer if needed', flagged_for_review: true, order: publicOrder(o) });
      }
    }

    return notFound();
  }

  /* ------------------------------------------------------------------
     fetch() wrapper
  ------------------------------------------------------------------ */
  window.fetch = async function (input, init) {
    let url;
    try { url = new URL(typeof input === 'string' ? input : input.url, location.href); }
    catch (e) { return realFetch(input, init); }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);

    const method = ((init && init.method) || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    let body = {};
    try { if (init && typeof init.body === 'string') body = JSON.parse(init.body); } catch (e) {}

    // A little latency so loading states look like they used to.
    await new Promise(r => setTimeout(r, 120 + Math.random() * 180));
    let res;
    try {
      res = await handle(method, url.pathname, url.searchParams, body);
    } catch (e) {
      console.warn('[demo] ' + url.pathname + ' failed:', e && e.message);
      res = json({ error: 'The demo could not reach the map service. Try again in a moment.' }, 503);
    }
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  };

  /* ------------------------------------------------------------------
     Socket.IO stand-in: emits 'order_update' when a demo order moves on.
  ------------------------------------------------------------------ */
  const sockets = new Set();
  function makeSocket() {
    const handlers = {};
    const sock = {
      connected: true,
      id: 'demo-' + Math.random().toString(36).slice(2),
      on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return sock; },
      off(evt, fn) { if (handlers[evt]) handlers[evt] = fn ? handlers[evt].filter(f => f !== fn) : []; return sock; },
      emit() { return sock; },
      connect() { sock.connected = true; sockets.add(sock); return sock; },
      disconnect() { sock.connected = false; sockets.delete(sock); return sock; },
      close() { return sock.disconnect(); },
      _fire(evt, data) { (handlers[evt] || []).slice().forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
    };
    sockets.add(sock);
    setTimeout(() => { if (sock.connected) sock._fire('connect'); }, 0);
    return sock;
  }
  window.io = function () { return makeSocket(); };

  const lastStatus = {};
  setInterval(() => {
    if (!sockets.size) return;
    const db = advanceAll();
    Object.values(db.orders).forEach(o => {
      const key = o.id + ':' + o.status;
      if (lastStatus[o.id] !== undefined && lastStatus[o.id] !== key) {
        const data = { id: o.id, order_id: o.id, status: o.status };
        sockets.forEach(s => s._fire('order_update', data));
      }
      lastStatus[o.id] = key;
    });
  }, 1000);

  /* ------------------------------------------------------------------
     The demo is anchored on campus: "your location" is Pepperdine, so the
     pages never ask for the visitor's real location.
  ------------------------------------------------------------------ */
  try {
    const fakePos = () => ({
      coords: { latitude: CAMPUS.lat, longitude: CAMPUS.lng, accuracy: 30, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now()
    });
    const geo = {
      getCurrentPosition(ok) { setTimeout(() => ok && ok(fakePos()), 250); },
      watchPosition(ok) { setTimeout(() => ok && ok(fakePos()), 250); return 1; },
      clearWatch() {}
    };
    Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => geo });
  } catch (e) {}

  /* ------------------------------------------------------------------
     Keep fixed headers below the archive notice.
  ------------------------------------------------------------------ */
  function syncBarHeight() {
    const bar = document.querySelector('.dd-archive-bar');
    document.documentElement.style.setProperty('--dd-bar-h', (bar ? bar.offsetHeight : 0) + 'px');
  }
  document.addEventListener('DOMContentLoaded', syncBarHeight);
  window.addEventListener('resize', syncBarHeight);
  window.addEventListener('load', syncBarHeight);

  window.DD_DEMO = { encodePolyline, loadAll, advanceAll };
})();
