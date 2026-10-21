// DormDash demo: client-side place search + routing. Stores nothing.
(function () {
  const CAMPUS = {
    name: 'Pepperdine University',
    address: '24255 Pacific Coast Hwy, Malibu, CA 90263',
    lat: 34.0407,
    lng: -118.7108
  };

  const GEOCODER = 'https://nominatim.openstreetmap.org';
  const ROUTER = 'https://router.project-osrm.org/route/v1/driving';

  // The geocoder allows ~1 request per second per client.
  let lastCall = 0;
  async function throttle() {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
  }

  const cache = new Map();

  function splitName(r) {
    const parts = (r.display_name || '').split(',').map(s => s.trim());
    const name = r.name || parts[0] || 'Unnamed place';
    let rest = parts[0] === name ? parts.slice(1) : parts;
    // "6400, Fallbrook Avenue" -> "6400 Fallbrook Avenue"
    if (rest.length > 1 && /^\d+[A-Za-z-]*$/.test(rest[0])) rest = [rest[0] + ' ' + rest[1], ...rest.slice(2)];
    // Drop country, county, ZIP and LA neighborhood-council noise
    const address = rest.filter(p => p !== 'United States' && p !== 'California' && !/County$|District$|Neighborhood Council|^\d{5}(-\d{4})?$/.test(p)).slice(0, 3).join(', ');
    return { name, address };
  }

  async function search(query, { near = CAMPUS, limit = 6 } = {}) {
    const q = query.trim();
    if (!q) return [];
    const key = 's:' + q.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    await throttle();
    const box = [near.lng - 0.6, near.lat + 0.6, near.lng + 0.6, near.lat - 0.6].join(',');
    const url = `${GEOCODER}/search?format=jsonv2&limit=${limit}&countrycodes=us&viewbox=${box}&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Place search is unavailable right now (' + res.status + ')');
    const data = await res.json();
    const out = data.map(r => {
      const { name, address } = splitName(r);
      const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
      return { name, address, lat, lng, miles: haversineMiles(near, { lat, lng }) };
    }).sort((a, b) => a.miles - b.miles);
    cache.set(key, out);
    return out;
  }

  async function reverse(lat, lng) {
    await throttle();
    const res = await fetch(`${GEOCODER}/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Could not look up that location');
    const r = await res.json();
    return splitName(r).address || r.display_name || 'Your location';
  }

  function haversineMiles(a, b) {
    const R = 3958.8, rad = x => x * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Returns { miles, minutes, coords: [[lat, lng], ...], estimated }
  async function route(from, to) {
    const key = `r:${from.lat.toFixed(5)},${from.lng.toFixed(5)};${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
    if (cache.has(key)) return cache.get(key);
    let out;
    try {
      const res = await fetch(`${ROUTER}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`);
      const data = await res.json();
      if (!res.ok || data.code !== 'Ok' || !data.routes.length) throw new Error(data.message || 'no route');
      const r = data.routes[0];
      out = {
        miles: r.distance / 1609.344,
        minutes: Math.max(1, Math.round(r.duration / 60)),
        coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        estimated: false
      };
    } catch (e) {
      // Public routing is best-effort; fall back to a road-factor estimate.
      const miles = haversineMiles(from, to) * 1.35;
      out = {
        miles,
        minutes: Math.max(1, Math.round(miles / 32 * 60)),
        coords: [[from.lat, from.lng], [to.lat, to.lng]],
        estimated: true
      };
    }
    cache.set(key, out);
    return out;
  }

  function money(n) { return '$' + (Math.round(n * 100) / 100).toFixed(2); }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Real DormDash rate cards
  const RATES = {
    food: { base: 5.99, service: 0.15, perMile: 0.39, farAway: 7.99, farLimit: 10, platform: 0.49, tax: 0.0975 },
    ride: { base: 4.99, perMile: 0.89, perMinute: 0.39 }
  };

  window.DD = { CAMPUS, RATES, search, reverse, route, haversineMiles, money, esc };
})();
