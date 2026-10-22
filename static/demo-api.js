// DormDash demo service.
//
// The original service is gone, so this file answers the pages' /api/*
// requests inside the browser with the same response shapes. The page code
// itself is the original code, unchanged in how it calls the API.
//
// Nothing leaves the browser: demo orders (including any name or phone number
// typed into the form) live only in this browser's localStorage. Place search,
// reverse geocoding and routing go through static/geo.js.
//
// The driver pages share the same order store: a demo driver account, a few
// sample orders to claim, and any order the visitor placed as a customer.
// Once a driver claims an order it is marked driver_controlled and the
// automatic customer timeline below leaves it alone.
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
     Uses the real status strings from the live service.
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

  // Same formula the live service used when a bill was confirmed
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
    // A driver (the visitor, in the driver demo) runs this order by hand
    if (o.driver_controlled || o._seed) return driverSideAdvance(o, now);
    // While the visitor is signed in as a driver, their new customer orders
    // wait in the driver dashboard instead of being claimed automatically.
    if (!o.claimed_at && currentDriverId()) return false;
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

  // Encoded polyline (precision 5), the format the ride page decodes.
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
    const seconds = Math.round((miles / 30) * 3600); // 30 mph estimate
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
    // the order token is required on customer actions
    return o && (!body.order_token || body.order_token === o.order_token);
  }

  async function handle(method, path, query, body) {
    // --- Driver accounts, dashboard and payouts ------------------------
    if (path.startsWith('/api/driver/')) return handleDriver(method, path, query, body);

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

    // --- Security checks ----------------------------------------------
    if (path === '/api/security/validate-check') {
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
        service_type: 'food',
        // Restaurant -> campus, for the live map on the tracking page
        pickup_lat: parseFloat(body.restaurant_lat) || null, pickup_lng: parseFloat(body.restaurant_lng) || null,
        dropoff_lat: CAMPUS.lat, dropoff_lng: CAMPUS.lng
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
      // Same pricing the live service used for rides
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
        driver_payout: round2(payout),
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

      // Order by id is the driver view (customers use their token)
      if (!action && method === 'GET') {
        if (!currentDriver()) return json({ error: 'Error code: 1647', authenticated: false }, 401);
        return json(publicOrder(o));
      }

      const driverRes = await driverOrderAction(db, o, action, method, body);
      if (driverRes) return driverRes;

      if (action === 'create-payment' && method === 'POST') {
        if (!tokenOk(o, body)) return json({ error: 'Error code: 5041' }, 403);
        // No payments in the demo: mark the order paid and send the customer
        // back to the tracking page as a completed checkout would.
        if (!o.payment_confirmed) {
          markPaid(o, Date.now());
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
     Driver side
     Accounts and the signed-in session live in this browser's
     localStorage. The demo driver is created on first use.
  ------------------------------------------------------------------ */
  const DRIVERS_KEY = 'dormdash_demo_drivers_v1';
  const SESSION_KEY = 'dormdash_demo_driver_session_v1';
  const DEMO_USER = 'demo.driver';
  const DEMO_PASSWORD = 'DormDash#Demo2026';
  const SEED_PAY_DELAY = 6000;     // sample customers pay a few seconds after the bill
  const DAY = 86400000;
  const PLATFORM_CUT = 0.1732;

  let memDrivers = null, memSession = null;
  function loadDrivers() {
    try {
      const raw = localStorage.getItem(DRIVERS_KEY);
      return raw ? JSON.parse(raw) : { nextId: 1, drivers: {} };
    } catch (e) {
      return memDrivers || (memDrivers = { nextId: 1, drivers: {} });
    }
  }
  function saveDrivers(d) {
    try { localStorage.setItem(DRIVERS_KEY, JSON.stringify(d)); }
    catch (e) { memDrivers = d; }
  }
  function currentDriverId() {
    try { return localStorage.getItem(SESSION_KEY); }
    catch (e) { return memSession; }
  }
  function setSession(id) {
    try {
      if (id == null) localStorage.removeItem(SESSION_KEY);
      else localStorage.setItem(SESSION_KEY, String(id));
    } catch (e) { memSession = id == null ? null : String(id); }
  }
  function currentDriver() {
    const id = currentDriverId();
    if (!id) return null;
    const d = ensureDemoDriver().drivers[id];
    return d || null;
  }
  function publicDriver(d) {
    const out = Object.assign({}, d);
    delete out.password_hash;
    delete out.demo;
    return out;
  }

  async function hashPassword(username, password) {
    const data = new TextEncoder().encode('dormdash-demo:' + username.toLowerCase() + ':' + password);
    try {
      if (window.crypto && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) {}
    let h = 2166136261;
    for (const b of data) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
    return 'f' + h.toString(16);
  }

  function ensureDemoDriver() {
    const d = loadDrivers();
    if (!Object.values(d.drivers).some(x => x.demo)) {
      const id = d.nextId++;
      d.drivers[id] = {
        id, username: DEMO_USER, name: 'Demo Driver', phone_number: '', demo: true,
        is_admin: false, created_at: iso(Date.now() - 64 * DAY), updated_at: iso(Date.now() - 2 * DAY),
        contract_signed: true, contract_signed_at: iso(Date.now() - 63 * DAY),
        payout_account_id: 'acct_demo_' + id, payout_onboarding_complete: true, payout_payouts_enabled: true
      };
      saveDrivers(d);
    }
    return d;
  }
  function updateDriver(id, fields) {
    const d = loadDrivers();
    if (!d.drivers[id]) return null;
    Object.assign(d.drivers[id], fields, { updated_at: iso(Date.now()) });
    saveDrivers(d);
    return d.drivers[id];
  }

  // The customer charge, and what lands in the driver's payout account.
  function chargeTotal(o) {
    const cb = o.cost_breakdown || {};
    const tip = parseFloat(o.tip_amount) || 0;
    if (o.service_type === 'rideshare') return (parseFloat(cb.total_fare) || 0) + (parseFloat(cb.platform_fee_flat) || 0.49) + tip;
    return (parseFloat(cb.est_total) || 0) + tip;
  }
  function settle(o) {
    const cb = o.cost_breakdown || {};
    const tip = parseFloat(o.tip_amount) || 0;
    const fee = round2(chargeTotal(o) * 0.029 + 0.30);
    let payout;
    if (o.service_type === 'rideshare') {
      payout = (parseFloat(cb.total_fare) || 0) * (1 - PLATFORM_CUT) + tip - fee;
      o.platform_fee = round2((parseFloat(cb.total_fare) || 0) * PLATFORM_CUT + (parseFloat(cb.platform_fee_flat) || 0.49));
    } else {
      // The driver bought the food, so food and tax come back to them
      payout = (parseFloat(cb.food_subtotal) || 0) + (parseFloat(cb.sales_tax) || 0) + (parseFloat(cb.fees_pool) || 0) * (1 - PLATFORM_CUT) + tip - fee;
      o.platform_fee = round2((parseFloat(cb.fees_pool) || 0) * PLATFORM_CUT);
    }
    o.processing_fee = fee;
    o.payout_amount = round2(Math.max(0, payout));
  }
  function markPaid(o, ms) {
    o.payment_confirmed = true;
    o.payment_confirmed_at = iso(ms);
    o._paid_ms = ms;
    o.status = 'Payment Successful';
    o.updated_at = iso(ms);
    settle(o);
  }

  // Orders a driver runs by hand only move on their own for one thing:
  // a sample customer paying the bill.
  function driverSideAdvance(o, now) {
    if (o._seed && o.status === 'Awaiting Payment' && !o.payment_confirmed && o.awaiting_payment_at) {
      const at = Date.parse(o.awaiting_payment_at) + SEED_PAY_DELAY;
      if (now >= at) { markPaid(o, Math.min(now, at)); o.updated_at = iso(now); return true; }
    }
    return false;
  }

  /* ---- Sample orders ------------------------------------------------ */
  // Real places around campus. Customers are made up.
  const SEED_ORDERS = [
    {
      restaurant_name: 'In-N-Out Burger', restaurant_address: '30780 Russell Ranch Rd, Westlake Village, CA 91362',
      lat: 34.1475317, lng: -118.7974812, customer_name: 'Maya R.', delivery_address: 'Seaside', contact_method: 'hand off',
      menu_items: [{ name: 'Double-Double', quantity: 2 }, { name: 'Animal Style Fries', quantity: 1 }, { name: 'Chocolate Shake', quantity: 1 }],
      order_details: 'No onions on one of the Double-Doubles please. Meet me in the Seaside lobby.', tip: 4, ago: 3
    },
    {
      restaurant_name: "McDonald's", restaurant_address: '22725 Pacific Coast Hwy, Malibu, CA 90265',
      lat: 34.0396839, lng: -118.6701192, customer_name: 'Jordan K.', delivery_address: 'Rockwell Towers Residence Hall', contact_method: 'drop off',
      menu_items: [{ name: 'Big Mac', quantity: 1 }, { name: '10 pc Chicken McNuggets', quantity: 1 }, { name: 'Large Fries', quantity: 2 }],
      order_details: 'Sweet and sour sauce with the nuggets. Leave it at the front desk.', tip: 3, ago: 6
    },
    {
      restaurant_name: 'Chick-fil-A', restaurant_address: '6400 Fallbrook Ave, Woodland Hills, CA 91367',
      lat: 34.1867783, lng: -118.6230031, customer_name: 'Priya S.', delivery_address: 'Banowsky House', contact_method: 'drop off',
      menu_items: [{ name: 'Chick-fil-A Chicken Sandwich', quantity: 2 }, { name: 'Waffle Potato Fries (M)', quantity: 2 }, { name: 'Lemonade (M)', quantity: 1 }],
      order_details: 'Extra Chick-fil-A sauce.', tip: 5, ago: 9
    },
    {
      ride: true, pickup_name: 'Seaside Residence Hall, Pepperdine', pickup: { lat: 34.0386, lng: -118.7097 },
      dropoff_name: 'Santa Monica Place, 395 Santa Monica Pl, Santa Monica', dropoff: { lat: 34.0136758, lng: -118.494598 },
      customer_name: 'Ethan W.', order_details: 'Two of us, one small bag.', tip: 4, ago: 2
    },
    {
      ride: true, pickup_name: 'Malibu Country Mart, 3835 Cross Creek Rd, Malibu', pickup: { lat: 34.036078, lng: -118.6865034 },
      dropoff_name: 'Rockwell Towers Residence Hall, Pepperdine', dropoff: { lat: 34.0418, lng: -118.7124 },
      customer_name: 'Sofia L.', order_details: 'Pickup outside Malibu Kitchen.', tip: 2, ago: 12, scheduledIn: 95
    }
  ];

  function roadMiles(a, b) { return window.DD.haversineMiles(a, b) * 1.35; }

  function seedOrder(db, s, now) {
    const created = now - s.ago * 60000;
    if (s.ride) {
      const miles = roadMiles(s.pickup, s.dropoff);
      const minutes = Math.max(4, Math.round(miles / 32 * 60));
      const BASE_FARE = 4.99, PER_MILE = 0.89, PER_MINUTE = 0.39, FLAT = 0.49;
      const total = BASE_FARE + miles * PER_MILE + minutes * PER_MINUTE;
      const payout = total * (1 - PLATFORM_CUT) + s.tip;
      return blankOrder({
        id: newId(db), restaurant_id: 'rideshare-ride',
        restaurant_name: `Rideshare: ${s.pickup_name} → ${s.dropoff_name}`,
        customer_name: s.customer_name, delivery_address: s.dropoff_name, restaurant_address: s.pickup_name,
        order_details: s.order_details, service_type: 'rideshare', tip_amount: s.tip,
        cost_breakdown: {
          base_fare: BASE_FARE, mileage_cost: round2(miles * PER_MILE), time_cost: round2(minutes * PER_MINUTE),
          distance_miles: round2(miles), duration_minutes: minutes, per_mile_rate: PER_MILE, per_minute_rate: PER_MINUTE,
          hourly_rate: round2(payout / (minutes * 2) * 60), total_fare: round2(total),
          platform_fee: round2(total * PLATFORM_CUT + FLAT), platform_fee_flat: FLAT, driver_payout: round2(payout)
        },
        payout_amount: round2(payout), driver_payout: round2(payout), platform_fee: round2(total * PLATFORM_CUT + FLAT),
        pickup_lat: s.pickup.lat, pickup_lng: s.pickup.lng, dropoff_lat: s.dropoff.lat, dropoff_lng: s.dropoff.lng,
        scheduled_for: s.scheduledIn ? iso(now + s.scheduledIn * 60000) : null,
        created_at: iso(created), updated_at: iso(created), _created_ms: created, _seed: true
      });
    }
    const miles = roadMiles({ lat: s.lat, lng: s.lng }, CAMPUS);
    const seconds = Math.round(miles / 32 * 3600);
    const o = blankOrder({
      id: newId(db), restaurant_id: 'demo', restaurant_name: s.restaurant_name, restaurant_address: s.restaurant_address,
      customer_name: s.customer_name, delivery_address: s.delivery_address, order_details: s.order_details,
      contact_method: s.contact_method, tip_amount: s.tip, service_type: 'food',
      menu_items: s.menu_items.map(i => ({ name: i.name, quantity: i.quantity, price: '' })),
      route_summary: { miles: round2(miles), seconds, eta_text: durationText(seconds / 60), est_delivery_text: durationText(seconds / 60 + 15) },
      cost_breakdown: { sales_tax_rate: 0.0975, miles: round2(miles) },
      pickup_lat: s.lat, pickup_lng: s.lng, dropoff_lat: CAMPUS.lat, dropoff_lng: CAMPUS.lng,
      created_at: iso(created), updated_at: iso(created), _created_ms: created, _seed: true
    });
    recomputeFoodBreakdown(o);
    return o;
  }

  // Past jobs for the demo driver, so the earnings screens have something in
  // them. Sample numbers only.
  const SEED_HISTORY = [
    { kind: 'food', name: 'Chipotle', addr: '29169 Heathercliff Rd, Malibu, CA 90265', lat: 34.0255, lng: -118.7804, dorm: 'Lovernich Apartments',
      items: [['Burrito Bowl', 2, 11.45], ['Chips & Guacamole', 1, 5.25]], tip: 4, days: 19, cust: 'Noah B.' },
    { kind: 'ride', from: 'Pepperdine (Seaver Main Lot)', to: 'Malibu Country Mart, 3835 Cross Creek Rd, Malibu', miles: 3.6, minutes: 9, tip: 3, days: 15, cust: 'Ava T.' },
    { kind: 'food', name: 'In-N-Out Burger', addr: '30780 Russell Ranch Rd, Westlake Village, CA 91362', lat: 34.1475317, lng: -118.7974812, dorm: 'Seaside',
      items: [['Double-Double', 3, 5.95], ['Fries', 3, 2.65], ['Neapolitan Shake', 1, 3.95]], tip: 6, days: 11, cust: 'Liam P.' },
    { kind: 'food', name: "McDonald's", addr: '22725 Pacific Coast Hwy, Malibu, CA 90265', lat: 34.0396839, lng: -118.6701192, dorm: 'Banowsky House',
      items: [['Quarter Pounder with Cheese', 1, 8.29], ['McFlurry with OREO', 2, 5.19]], tip: 2, days: 6, cust: 'Grace H.' },
    { kind: 'ride', from: 'Rockwell Towers, Pepperdine', to: 'Westfield Topanga, Woodland Hills', miles: 15.8, minutes: 24, tip: 5, days: 3, cust: 'Mason D.' },
    { kind: 'food', name: 'Chick-fil-A', addr: '6400 Fallbrook Ave, Woodland Hills, CA 91367', lat: 34.1867783, lng: -118.6230031, dorm: 'Rockwell Towers Residence Hall',
      items: [['Spicy Chicken Sandwich', 2, 6.09], ['Nuggets (12 ct)', 1, 7.25], ['Waffle Potato Fries (L)', 2, 3.25]], tip: 5, days: 1, cust: 'Chloe M.' }
  ];

  function seedHistory(db, driver, now) {
    SEED_HISTORY.forEach(h => {
      const done = now - h.days * DAY - 3 * 3600000;
      const created = done - 55 * 60000;
      const at = m => iso(created + m * 60000);
      let o;
      if (h.kind === 'ride') {
        const BASE_FARE = 4.99, PER_MILE = 0.89, PER_MINUTE = 0.39, FLAT = 0.49;
        const total = BASE_FARE + h.miles * PER_MILE + h.minutes * PER_MINUTE;
        const payout = total * (1 - PLATFORM_CUT) + h.tip;
        o = blankOrder({
          id: newId(db), restaurant_id: 'rideshare-ride', restaurant_name: `Rideshare: ${h.from} → ${h.to}`,
          customer_name: h.cust, delivery_address: h.to, restaurant_address: h.from, service_type: 'rideshare', tip_amount: h.tip,
          cost_breakdown: {
            base_fare: BASE_FARE, mileage_cost: round2(h.miles * PER_MILE), time_cost: round2(h.minutes * PER_MINUTE),
            distance_miles: h.miles, duration_minutes: h.minutes, per_mile_rate: PER_MILE, per_minute_rate: PER_MINUTE,
            hourly_rate: round2(payout / (h.minutes * 2) * 60), total_fare: round2(total),
            platform_fee: round2(total * PLATFORM_CUT + FLAT), platform_fee_flat: FLAT, driver_payout: round2(payout)
          },
          driver_payout: round2(payout), status: 'Completed',
          claimed_at: at(4), awaiting_payment_at: at(9), heading_to_pickup_at: at(16), in_progress_at: at(28), delivered_at: iso(done)
        });
      } else {
        const miles = round2(roadMiles({ lat: h.lat, lng: h.lng }, CAMPUS));
        o = blankOrder({
          id: newId(db), restaurant_id: 'demo', restaurant_name: h.name, restaurant_address: h.addr, customer_name: h.cust,
          delivery_address: h.dorm, tip_amount: h.tip, service_type: 'food', contact_method: 'drop off',
          menu_items: h.items.map(([name, quantity, price]) => ({ name, quantity, price: price.toFixed(2) })),
          route_summary: { miles, seconds: Math.round(miles / 32 * 3600) }, cost_breakdown: { sales_tax_rate: 0.0975, miles },
          pickup_lat: h.lat, pickup_lng: h.lng, dropoff_lat: CAMPUS.lat, dropoff_lng: CAMPUS.lng, status: 'Delivered',
          claimed_at: at(3), awaiting_payment_at: at(10), heading_to_restaurant_at: at(14), picked_up_at: at(30),
          in_progress_at: at(31), delivered_at: iso(done), delivery_photo_url: '/static/demo-delivery-photo.svg'
        });
        recomputeFoodBreakdown(o);
      }
      Object.assign(o, {
        claimed_by: driver.username, driver_name: driver.name, driver_id: driver.id, driver_controlled: true,
        payment_confirmed: true, created_at: iso(created), updated_at: iso(done), _created_ms: created,
        rating: h.days % 2 ? 5 : null, delivery_confirmed: true, delivery_confirmed_at: iso(done + 600000), _seed_history: true
      });
      markPaid(o, created + 13 * 60000);
      o.status = h.kind === 'ride' ? 'Completed' : 'Delivered';
      o.updated_at = iso(done);
      db.orders[o.id] = o;
    });
  }

  // Keep a few sample orders available to claim, and give the demo driver a
  // job history the first time the driver side is opened.
  function ensureSeed() {
    const db = advanceAll();
    const now = Date.now();
    let changed = false;
    const open = Object.values(db.orders).filter(o => o._seed && o.status === 'Pending' && !o.claimed_by);
    if (!open.length) {
      SEED_ORDERS.forEach(s => { const o = seedOrder(db, s, now); db.orders[o.id] = o; });
      changed = true;
    }
    const demo = Object.values(ensureDemoDriver().drivers).find(x => x.demo);
    if (!db.seededHistory) {
      seedHistory(db, demo, now);
      db.seededHistory = true;
      changed = true;
    }
    if (changed) saveAll(db);
    return db;
  }

  function resetDriverDemo() {
    const db = loadAll();
    Object.keys(db.orders).forEach(id => { if (db.orders[id]._seed || db.orders[id]._seed_history) delete db.orders[id]; });
    db.seededHistory = false;
    saveAll(db);
    const d = loadDrivers();
    Object.values(d.drivers).forEach(x => {
      if (x.demo) Object.assign(x, { contract_signed: true, payout_account_id: 'acct_demo_' + x.id, payout_onboarding_complete: true, payout_payouts_enabled: true });
    });
    saveDrivers(d);
    ensureSeed();
  }

  function mine(o, driver) {
    return o.driver_id === driver.id || o.claimed_by === driver.username;
  }

  /* ---- Payout account summary -------------------------------------- */
  function payoutSummary(db, driver, now) {
    const paid = Object.values(db.orders)
      .filter(o => mine(o, driver) && o.payment_confirmed && o.status !== 'Cancelled')
      .map(o => {
        const paidAt = o._paid_ms || Date.parse(o.payment_confirmed_at) || now;
        const net = parseFloat(o.payout_amount) || 0, fee = parseFloat(o.processing_fee) || 0;
        const label = o.service_type === 'rideshare' ? `Ride #${o.id}` : `Order #${o.id} - ${o.restaurant_name}`;
        return { o, net, fee, gross: round2(net + fee), availableAt: paidAt + 2 * DAY, label };
      });
    const pending = paid.filter(p => p.availableAt > now);
    const cleared = paid.filter(p => p.availableAt <= now);
    // One automatic payout per day of cleared earnings; it reaches the bank a day later
    const byDay = {};
    cleared.forEach(p => {
      const d = new Date(p.availableAt); d.setHours(0, 0, 0, 0);
      const k = d.getTime();
      (byDay[k] = byDay[k] || []).push(p);
    });
    const payouts = Object.keys(byDay).map(Number).sort((a, b) => b - a).slice(0, 10).map(k => {
      const created = k + 9 * 3600000, arrival = created + DAY;
      return {
        id: 'po_demo_' + k.toString(36), amount: round2(byDay[k].reduce((s, p) => s + p.net, 0)),
        status: arrival <= now ? 'paid' : 'in_transit', arrival_date: Math.floor(arrival / 1000),
        created: Math.floor(created / 1000), description: 'Automatic payout'
      };
    });
    const sum = (arr, f) => round2(arr.reduce((s, x) => s + f(x), 0));
    const pendingAmt = sum(pending, p => p.net);
    const inTransit = sum(payouts.filter(p => p.status === 'in_transit'), p => p.amount);
    const nextAvail = pending.length ? Math.min(...pending.map(p => p.availableAt)) : null;
    return {
      has_payout_account: !!driver.payout_account_id,
      balance: {
        total: pendingAmt, available: 0, pending: pendingAmt, in_transit: inTransit, disputed: 0, disputed_count: 0,
        next_payout_date: nextAvail ? Math.floor(nextAvail / 1000) : null,
        next_automatic_payout_date: nextAvail ? Math.floor((nextAvail + DAY) / 1000) : null,
        next_automatic_payout_amount: pendingAmt
      },
      payout_schedule: {
        interval: 'daily', delay_days: 2, weekly_anchor: null, monthly_anchor: null,
        description: 'Automatic daily payouts (arrives 2 business days after available)'
      },
      totals: {
        total_earned: sum(paid, p => p.net), total_paid_out: sum(payouts.filter(p => p.status === 'paid'), p => p.amount),
        lifetime_volume: sum(paid, p => p.gross), total_fees: sum(paid, p => p.fee), total_disputed: 0
      },
      pending_charges: pending.sort((a, b) => a.availableAt - b.availableAt).map(p => ({
        amount: p.gross, fee: p.fee, net: p.net, available_on: Math.floor(p.availableAt / 1000),
        available_date: iso(p.availableAt), description: p.label
      })),
      payouts
    };
  }

  /* ---- /api/driver/* ----------------------------------------------- */
  const needLogin = () => json({ error: 'Error code: 1647', authenticated: false }, 401);

  async function handleDriver(method, path, query, body) {
    ensureDemoDriver();

    if (path === '/api/driver/login' && method === 'POST') {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return json({ error: 'Please enter both username and password' }, 400);
      const d = loadDrivers();
      const driver = Object.values(d.drivers).find(x => x.username.toLowerCase() === username.toLowerCase());
      if (!driver) return json({ error: 'No driver account with that username in this browser' }, 401);
      const ok = driver.demo ? password === DEMO_PASSWORD : (await hashPassword(driver.username, password)) === driver.password_hash;
      if (!ok) return json({ error: 'Incorrect password' }, 401);
      setSession(driver.id);
      ensureSeed();
      return json({ success: true, message: 'Login successful', driver: publicDriver(driver) });
    }

    if (path === '/api/driver/signup' && method === 'POST') {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const phone = String(body.phone_number || '').trim();
      if (!username || !password) return json({ error: 'Username and password are required' }, 400);
      if (username.length < 2 || username.length > 32) return json({ error: 'Username must be 2-32 characters' }, 400);
      if (password.length < 12) return json({ error: 'Password must be at least 12 characters' }, 400);
      if (!(/[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password) && /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(password))) {
        return json({ error: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character (!@#$%^&*...)' }, 400);
      }
      const lower = password.toLowerCase();
      for (let i = 0; i < lower.length - 2; i++) {
        if ('0123456789abcdefghijklmnopqrstuvwxyz'.includes(lower.slice(i, i + 3))) return json({ error: 'Password cannot contain sequential characters (abc, 123)' }, 400);
      }
      if (['password', '12345678', 'qwerty', 'admin', 'letmein', 'welcome', 'monkey', 'dragon', 'iloveyou', 'princess', 'abc123', 'superman'].some(w => lower.includes(w))) {
        return json({ error: 'That password is too common' }, 400);
      }
      if (lower.includes(username.toLowerCase())) return json({ error: 'Password cannot contain your username' }, 400);
      const d = loadDrivers();
      if (username.toLowerCase() === 'demo driver' || Object.values(d.drivers).some(x => x.username.toLowerCase() === username.toLowerCase())) {
        return json({ error: 'That username is already taken' }, 400);
      }
      const id = d.nextId++;
      const now = Date.now();
      d.drivers[id] = {
        id, username, name: username, phone_number: phone, is_admin: false,
        password_hash: await hashPassword(username, password), created_at: iso(now), updated_at: iso(now),
        contract_signed: false, contract_signed_at: null,
        payout_account_id: null, payout_onboarding_complete: false, payout_payouts_enabled: false
      };
      saveDrivers(d);
      setSession(id);
      ensureSeed();
      return json({ success: true, message: 'Account created successfully', driver: publicDriver(d.drivers[id]) }, 201);
    }

    const driver = currentDriver();

    if (path === '/api/driver/logout' && method === 'POST') {
      if (!driver) return json({ error: 'Error code: 1519' }, 400);
      setSession(null);
      return json({ success: true, message: 'Logged out successfully' });
    }

    if (!driver) return needLogin();

    if (path === '/api/driver/profile' && method === 'GET') return json(publicDriver(driver));

    if (path === '/api/driver/contract-status' && method === 'GET') {
      return json({ contract_signed: !!driver.contract_signed, contract_signed_at: driver.contract_signed_at || null });
    }
    if (path === '/api/driver/submit-contract' && method === 'POST') {
      if (!body.pdf) return json({ error: 'Error code: 2352' }, 400);
      // The signed copy stays with the visitor; only the "signed" flag is kept.
      updateDriver(driver.id, { contract_signed: true, contract_signed_at: iso(Date.now()), name: body.name || driver.name });
      return json({ success: true, message: 'Contract submitted successfully' });
    }

    if (path === '/api/driver/orders' && method === 'GET') {
      const db = ensureSeed();
      const list = Object.values(db.orders).filter(o => mine(o, driver)).sort((a, b) => b._created_ms - a._created_ms).map(publicOrder);
      return json(list);
    }

    if (path === '/api/driver/available-orders' && method === 'GET') {
      const db = ensureSeed();
      const list = Object.values(db.orders)
        .filter(o => o.status === 'Pending' && !o.claimed_by)
        // the visitor's own customer orders first, then the samples, newest first
        .sort((a, b) => (!!a._seed - !!b._seed) || b._created_ms - a._created_ms)
        .map(o => Object.assign(publicOrder(o), { from_customer_demo: !o._seed }));
      return json(list);
    }

    if (path === '/api/driver/stats' && method === 'GET') {
      const db = ensureSeed();
      const list = Object.values(db.orders).filter(o => mine(o, driver));
      const done = list.filter(o => o.status === 'Delivered' || o.status === 'Completed');
      return json({
        total_deliveries: list.length,
        total_earnings: round2(list.filter(o => o.status !== 'Cancelled').reduce((s, o) => s + (parseFloat(o.driver_payout) || 0), 0)),
        completed_earnings: round2(done.reduce((s, o) => s + (parseFloat(o.driver_payout) || 0), 0)),
        completed_deliveries: done.length,
        active_deliveries: list.filter(o => ['Claimed', 'Awaiting Payment', 'Payment Successful', 'Heading to Restaurant', 'Heading to Pickup', 'Picked Up', 'In Progress'].includes(o.status)).length,
        reversed_count: 0, total_reversed: 0
      });
    }

    if (path === '/api/driver/payouts' && method === 'GET') {
      return json({
        summary: { total_paid: 0, total_scheduled: 0, total_pending: 0, total_on_hold: 0, scheduled_count: 0, pending_count: 0, on_hold_count: 0 },
        scheduled: [], pending: [], completed: [], on_hold: [], waiting: []
      });
    }

    if (path === '/api/driver/payout-summary' && method === 'GET') {
      if (!driver.payout_account_id) {
        return json({
          has_payout_account: false,
          balance: { total: 0, available: 0, pending: 0, in_transit: 0 },
          totals: { total_earned: 0, total_paid_out: 0, lifetime_volume: 0, total_fees: 0 },
          pending_charges: [], payouts: []
        });
      }
      return json(payoutSummary(ensureSeed(), driver, Date.now()));
    }

    // Payout account. The real one was set up on the payment processor's
    // hosted pages; here "connecting" succeeds locally.
    if (path === '/api/driver/payout-account/status' && method === 'GET') {
      if (!driver.payout_account_id) return json({ has_account: false, onboarding_complete: false, payouts_enabled: false });
      return json({ has_account: true, onboarding_complete: !!driver.payout_onboarding_complete, payouts_enabled: !!driver.payout_payouts_enabled, account_id: driver.payout_account_id });
    }
    if (path === '/api/driver/payout-account/create' && method === 'POST') {
      if (driver.payout_account_id) return json({ error: 'Error code: 2309' }, 400);
      const id = 'acct_demo_' + driver.id + '_' + Date.now().toString(36);
      updateDriver(driver.id, { payout_account_id: id });
      return json({ success: true, account_id: id });
    }
    if (path === '/api/driver/payout-account/link' && method === 'POST') {
      if (!driver.payout_account_id) return json({ error: 'Error code: 6268' }, 400);
      updateDriver(driver.id, { payout_onboarding_complete: true, payout_payouts_enabled: true });
      return json({ success: true, onboarding_url: '/driver.html?payout_onboarding=success' });
    }

    return notFound();
  }

  /* ---- Driver actions on an order ---------------------------------- */
  const PROTECTED = ['Payment Successful', 'Heading to Restaurant', 'Picked Up', 'In Progress', 'Delivered', 'Completed'];
  const STAMP = {
    'Claimed': 'claimed_at', 'Heading to Restaurant': 'heading_to_restaurant_at', 'Heading to Pickup': 'heading_to_pickup_at',
    'Picked Up': 'picked_up_at', 'In Progress': 'in_progress_at', 'Delivered': 'delivered_at', 'Completed': 'delivered_at',
    'Awaiting Payment': 'awaiting_payment_at'
  };

  async function driverOrderAction(db, o, action, method, body) {
    const driverActions = ['status', 'menu-items', 'confirm-menu', 'send-bill', 'update-fare', 'upload-delivery-photo'];
    if (!driverActions.includes(action)) return null;
    const driver = currentDriver();
    if (!driver) return needLogin();
    const now = Date.now();
    const isMine = mine(o, driver);

    if (action === 'status' && method === 'PATCH') {
      const status = body.status;
      if (!status) return json({ error: 'Error code: 8006' }, 400);
      if (status === 'Cancelled' && !body.cancellation_reason) return json({ error: 'Error code: 4695' }, 400);
      if (status === 'Claimed') {
        if (o.claimed_by && !isMine) return json({ error: 'Another driver already claimed this order' }, 409);
        Object.assign(o, { claimed_by: driver.username, driver_name: driver.name, driver_id: driver.id, driver_controlled: true });
      } else if (!isMine) {
        return json({ error: 'Claim this order before updating it' }, 409);
      }
      if (PROTECTED.includes(status) && !o.payment_confirmed) {
        return json({ error: 'Payment must be confirmed before progressing to this status', requires_payment: true }, 403);
      }
      o.status = status;
      o.updated_at = iso(now);
      if (STAMP[status]) o[STAMP[status]] = iso(now);
      if (status === 'Cancelled') {
        o.cancellation_reason = body.cancellation_reason;
        o.cancelled_at = iso(now);
        if (o.payment_confirmed) {
          Object.assign(o, { payout_on_hold: true, hold_reason: 'driver_cancelled', hold_notes: 'Driver cancelled after payment: ' + body.cancellation_reason, reversal_status: 'pending_admin_review' });
        }
      }
      if ((status === 'Delivered' || status === 'Completed') && body.photo_override) {
        Object.assign(o, { photo_override: true, photo_override_reason: body.photo_override_reason || '', photo_override_at: iso(now) });
      }
      saveAll(db);
      return json(publicOrder(o));
    }

    if (!isMine) return json({ error: 'Claim this order before updating it' }, 403);

    if (action === 'menu-items' && method === 'PATCH') {
      if (!Array.isArray(body.menu_items) || !body.menu_items.length) return json({ error: 'Error code: 6230' }, 400);
      o.menu_items = body.menu_items.map(i => ({ name: String(i.name || '').trim(), quantity: parseInt(i.quantity) || 1, price: i.price === '' || i.price == null ? '' : String(i.price) }));
      recomputeFoodBreakdown(o);
      o.updated_at = iso(now);
      saveAll(db);
      return json(publicOrder(o));
    }

    if (action === 'confirm-menu' && method === 'POST') {
      if (!o.menu_items || !o.menu_items.length) return json({ error: 'Error code: 5682' }, 400);
      if (!(o.cost_breakdown && parseFloat(o.cost_breakdown.food_subtotal) > 0)) return json({ error: 'Error code: 7510' }, 400);
      return json({ success: true, message: 'Menu items confirmed' });
    }

    if (action === 'send-bill' && method === 'POST') {
      if (!(o.cost_breakdown && parseFloat(o.cost_breakdown.total_fare) > 0)) return json({ error: 'Error code: 1595' }, 400);
      o.status = 'Awaiting Payment';
      o.awaiting_payment_at = iso(now);
      o.updated_at = iso(now);
      saveAll(db);
      return json({ success: true, message: 'Bill sent to customer' });
    }

    if (action === 'update-fare' && method === 'PATCH') {
      if (o.service_type !== 'rideshare') return json({ error: 'Error code: 7863' }, 400);
      if (o.payment_confirmed) return json({ error: 'Error code: 7327' }, 400);
      const cb = body.cost_breakdown;
      const req = ['base_fare', 'distance_miles', 'mileage_cost', 'duration_minutes', 'time_cost', 'total_fare', 'platform_fee', 'driver_payout'];
      if (!cb || req.some(k => !(k in cb) || parseFloat(cb[k]) < 0)) return json({ error: 'Error code: 9431' }, 400);
      const tip = parseFloat(o.tip_amount) || 0;
      const total = parseFloat(cb.total_fare);
      if (Math.abs(total - (parseFloat(cb.base_fare) + parseFloat(cb.mileage_cost) + parseFloat(cb.time_cost))) > 0.02) return json({ error: 'Error code: 1290' }, 400);
      if (Math.abs(parseFloat(cb.driver_payout) - (total * (1 - PLATFORM_CUT) + tip)) > 0.02) return json({ error: 'Error code: 9570' }, 400);
      o.cost_breakdown = Object.assign({}, o.cost_breakdown, cb, { per_mile_rate: 0.89, per_minute_rate: 0.39 });
      o.driver_payout = o.payout_amount = round2(parseFloat(cb.driver_payout));
      o.platform_fee = round2(parseFloat(cb.platform_fee));
      o.updated_at = iso(now);
      saveAll(db);
      return json({ success: true, message: 'Fare updated successfully', new_total: total });
    }

    if (action === 'upload-delivery-photo' && method === 'POST') {
      const photo = body.photo;
      if (!photo) return json({ error: 'Error code: 7372' }, 400);
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(photo)) return json({ error: 'Error code: 3896' }, 400);
      if (!o.payment_confirmed) return json({ error: 'Payment must be confirmed before delivery photo can be uploaded', payment_required: true }, 403);
      // The photo stays in this browser. If it will not fit in storage, the
      // order keeps a stand-in image instead.
      o.delivery_photo_url = photo;
      o.updated_at = iso(now);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); }
      catch (e) { o.delivery_photo_url = '/static/demo-delivery-photo.svg'; saveAll(db); }
      return json({ success: true, message: 'Photo uploaded successfully' });
    }

    return null;
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
     Live-updates stand-in: emits 'order_update' when a demo order moves on.
  ------------------------------------------------------------------ */
  const channels = new Set();
  function makeChannel() {
    const handlers = {};
    const chan = {
      connected: true,
      id: 'demo-' + Math.random().toString(36).slice(2),
      on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return chan; },
      off(evt, fn) { if (handlers[evt]) handlers[evt] = fn ? handlers[evt].filter(f => f !== fn) : []; return chan; },
      emit() { return chan; },
      connect() { chan.connected = true; channels.add(chan); return chan; },
      disconnect() { chan.connected = false; channels.delete(chan); return chan; },
      close() { return chan.disconnect(); },
      _fire(evt, data) { (handlers[evt] || []).slice().forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }
    };
    channels.add(chan);
    setTimeout(() => { if (chan.connected) chan._fire('connect'); }, 0);
    return chan;
  }
  window.liveChannel = function () { return makeChannel(); };

  const lastStatus = {};
  setInterval(() => {
    if (!channels.size) return;
    const db = advanceAll();
    Object.values(db.orders).forEach(o => {
      const key = o.id + ':' + o.status;
      if (lastStatus[o.id] !== undefined && lastStatus[o.id] !== key) {
        const data = { id: o.id, order_id: o.id, status: o.status };
        channels.forEach(s => s._fire('order_update', data));
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

  // Read-only view for the live map: the order plus its private timing fields
  function byToken(token) {
    const db = advanceAll();
    const o = Object.values(db.orders).find(x => x.order_token === token);
    return o ? JSON.parse(JSON.stringify(o)) : null;
  }

  window.DD_DEMO = { encodePolyline, loadAll, advanceAll, byToken, POST_PAY, PRE_PAY, resetDriverDemo, DEMO_USER, DEMO_PASSWORD };
})();
