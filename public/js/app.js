// ═══════════════════════════════════════
//  QUOTE machine — Wizard + Map (Phase 1+2)
// ═══════════════════════════════════════

// ── Geometry math (replaces turf.js)
function haversineMeters(a, b) {
  const R = 6371008.8, toR = d => d * Math.PI / 180;
  const dLat = toR(b[1] - a[1]), dLng = toR(b[0] - a[0]);
  const x = Math.sin(dLat/2)**2 + Math.cos(toR(a[1])) * Math.cos(toR(b[1])) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function polygonAreaSqm(ring) {
  const R = 6371008.8, toR = d => d * Math.PI / 180;
  const pts = ring.map(p => [R * toR(p[0]) * Math.cos(toR(p[1])), R * toR(p[1])]);
  let a = 0;
  for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}
function perimeterMeters(ring) {
  let t = 0;
  for (let i = 1; i < ring.length; i++) t += haversineMeters(ring[i-1], ring[i]);
  return t;
}

// ── Constants
const JOB_TYPES = [
  { id:'pressure-washing', label:'Pressure Washing', icon:'💦', unit:'sqft', range:'$0.08–$0.35/sf' },
  { id:'parking-lot-striping', label:'Lot Striping', icon:'🅿️', unit:'linft', range:'$0.15–$0.50/lf' },
  { id:'sealcoating', label:'Sealcoating', icon:'🛣️', unit:'sqft', range:'$0.10–$0.25/sf' },
  { id:'painting', label:'Painting / Coating', icon:'🎨', unit:'sqft', range:'$1.50–$4.00/sf' },
  { id:'roofing', label:'Roofing', icon:'🏠', unit:'sqft', range:'$3.50–$8.00/sf' },
  { id:'concrete', label:'Concrete', icon:'🧱', unit:'sqft', range:'$4.00–$12.00/sf' },
  { id:'landscaping', label:'Landscaping', icon:'🌿', unit:'sqft', range:'$2.00–$6.00/sf' },
  { id:'custom', label:'Other / Custom', icon:'📋', unit:'sqft', range:'Your rate' }
];
const UL = { sqft:'sq ft', linft:'lin ft', sqyd:'sq yd', acre:'acres' };
const US = { sqft:'sf', linft:'lf', sqyd:'sy', acre:'ac' };
const QP = {
  'pressure-washing':[.08,.12,.18,.25,.35],'parking-lot-striping':[.15,.25,.35,.50],
  'sealcoating':[.10,.15,.20,.25],'painting':[1.5,2,3,4],'roofing':[3.5,5,6.5,8],
  'concrete':[4,6,8,12],'landscaping':[2,3,4,6],'custom':[1,5,10,25]
};

// ── State
let authToken = sessionStorage.getItem('qmach_token') || '';
let mapboxToken = '', map = null;
let step = 0, items = [], current = { service:null, area:'', unit:'sqft', price:'' };
let address = '', clientName = '', lastLat = null, lastLng = null;
let editingQuoteId = null, chatHistory = [], aiPriceData = null, debounceTimer = null;

// Map drawing state
let mapPoints = [];  // [lng,lat] pairs
let drawnPolygonGeoJSON = null;

// ═══════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════
async function authFetch(url, opts = {}) {
  if (!opts.headers) opts.headers = {};
  if (authToken) opts.headers['x-auth-token'] = authToken;
  const r = await fetch(url, opts);
  if (r.status === 401) { sessionStorage.removeItem('qmach_token'); authToken = ''; showLogin(); throw new Error('Unauthorized'); }
  return r;
}
function showLogin() { el('login-gate').classList.remove('hidden'); }
function hideLogin() { el('login-gate').classList.add('hidden'); }
async function checkAuth() {
  try { const r = await fetch('/api/auth/check', { headers: authToken ? { 'x-auth-token': authToken } : {} }); const d = await r.json(); if (d.valid) { hideLogin(); return true; } } catch {} showLogin(); return false;
}
async function doLogin() {
  const btn = el('login-btn'), pw = el('login-password'), err = el('login-error');
  if (!pw.value.trim()) { err.textContent = 'Enter a password'; return; }
  btn.disabled = true; btn.textContent = 'Signing in...'; err.textContent = '';
  try { const r = await fetch('/api/auth', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:pw.value.trim()}) }); const d = await r.json();
    if (d.success) { authToken = d.token; sessionStorage.setItem('qmach_token', authToken); hideLogin(); bootApp(); } else { err.textContent = 'Wrong password'; pw.value = ''; pw.focus(); }
  } catch { err.textContent = 'Connection error'; } btn.disabled = false; btn.textContent = 'Sign In';
}

// ═══════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  on('login-btn', doLogin); el('login-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  if (await checkAuth()) bootApp();
});

async function bootApp() {
  el('app-shell').classList.remove('hidden');
  renderServiceList();

  // Tabs
  document.querySelectorAll('.htab').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));

  // Wizard nav
  on('btn-continue', onContinue);
  on('btn-back', () => goStep(step - 1));
  document.querySelectorAll('.pdot').forEach(dot => dot.addEventListener('click', () => { const s = parseInt(dot.dataset.step); if (s < step) goStep(s); }));

  // Address autocomplete
  const ai = el('inp-address');
  if (ai) { ai.addEventListener('input', () => { clearTimeout(debounceTimer); const q = ai.value.trim(); if (q.length < 3) { clearAC(); return; } debounceTimer = setTimeout(() => fetchAddr(q), 300); });
    ai.addEventListener('keydown', e => { if (e.key === 'Escape') clearAC(); }); document.addEventListener('click', e => { if (!ai.contains(e.target) && !el('addr-autocomplete')?.contains(e.target)) clearAC(); }); }

  // Quick btns
  on('btn-gps', geolocateUser); on('btn-gmaps', () => openExt('maps')); on('btn-gearth', () => openExt('earth')); on('btn-street', () => openExt('street'));

  // Measure
  el('inp-area')?.addEventListener('input', onMeasureChange);
  el('inp-unit')?.addEventListener('change', onMeasureChange);

  // Map buttons
  on('btn-open-map', openMap);
  on('btn-redraw', openMap);
  on('btn-map-close', closeMap);
  on('btn-map-done', finishMapDraw);
  on('btn-map-redo', redoMapDraw);

  // Price
  el('inp-price')?.addEventListener('input', onPriceChange);
  on('btn-ai-price', aiSuggestPrice);
  on('ai-price-dismiss', () => closeModal('ai-price-modal'));
  on('ai-price-apply', applyAiPrice);

  // Review
  on('btn-add-another', () => goStep(1));
  on('btn-save-share', saveAndShare);
  on('btn-pdf', generatePDF);
  on('btn-ai-narrative', generateNarrative);
  on('btn-new-quote', resetQuote);

  // Share
  on('share-sms', () => { closeSheet(); smsShare(); }); on('share-email', () => { closeSheet(); emailShare(); });
  on('share-copy', () => { closeSheet(); copyShare(); }); on('share-pdf', () => { closeSheet(); generatePDF(); });
  on('share-done', closeSheet); el('share-sheet')?.addEventListener('click', e => { if (e.target.id === 'share-sheet') closeSheet(); });

  // Saved & stats
  el('search-quotes')?.addEventListener('input', loadSaved); on('btn-export', exportAll);

  // Chat
  on('btn-ai-chat', openChat); on('ai-panel-close', closeChat); on('ai-overlay', closeChat);
  on('chat-send', sendChat); el('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  setupInstallBanner();

  // Load config
  try { const cfg = await authFetch('/api/config').then(r => r.json()); mapboxToken = cfg.mapboxToken || ''; } catch {}

  goStep(0);
}

// ═══════════════════════════════════════
//  WIZARD
// ═══════════════════════════════════════
function goStep(s) {
  if (s < 0 || s >= 5) return;
  step = s;
  document.querySelectorAll('.step').forEach((el, i) => { el.classList.toggle('hidden', i !== s); if (i === s) { el.style.animation = 'none'; void el.offsetHeight; el.style.animation = ''; } });
  document.querySelectorAll('.pdot').forEach((d, i) => { d.classList.remove('active','completed'); if (i < s) d.classList.add('completed'); else if (i === s) d.classList.add('active'); });
  document.querySelectorAll('.pline').forEach((l, i) => l.classList.toggle('filled', i < s));

  const ba = el('bottom-action'), bc = el('btn-continue'), bb = el('btn-back');
  if (s === 1 || s === 4) ba.classList.add('hidden');
  else { ba.classList.remove('hidden'); bb.classList.toggle('hidden', s === 0);
    if (s === 3) { bc.textContent = 'Review Quote →'; bc.className = 'btn-primary green'; } else { bc.textContent = 'Continue →'; bc.className = 'btn-primary'; } }
  updateBtn();
  if (s === 2) setupMeasure();
  if (s === 3) setupPrice();
  if (s === 4) renderReview();
}

function onContinue() {
  if (step === 3) { items.push({...current}); current = { service:null, area:'', unit:'sqft', price:'' }; goStep(4); }
  else if (step < 4) goStep(step + 1);
}
function canContinue() {
  if (step === 0) return (el('inp-address')?.value.trim().length > 3);
  if (step === 2) return parseFloat(el('inp-area')?.value) > 0;
  if (step === 3) return parseFloat(el('inp-price')?.value) > 0;
  return true;
}
function updateBtn() { const b = el('btn-continue'); if (b) b.disabled = !canContinue(); }
function switchView(v) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  el('view-' + v)?.classList.add('active');
  document.querySelectorAll('.htab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  if (v === 'saved') loadSaved(); if (v === 'stats') loadStats();
}

// ═══════════════════════════════════════
//  SERVICE LIST
// ═══════════════════════════════════════
function renderServiceList() {
  const list = el('service-list'); if (!list) return;
  list.innerHTML = JOB_TYPES.map(j => `<button class="svc-row" data-id="${j.id}"><span class="svc-icon">${j.icon}</span><div class="svc-info"><div class="svc-name">${j.label}</div><div class="svc-range">${j.range}</div></div><span class="svc-arrow">›</span></button>`).join('');
  list.querySelectorAll('.svc-row').forEach(r => r.addEventListener('click', () => {
    const j = JOB_TYPES.find(t => t.id === r.dataset.id); current.service = r.dataset.id; current.unit = j?.unit || 'sqft';
    list.querySelectorAll('.svc-row').forEach(x => x.classList.remove('selected')); r.classList.add('selected');
    setTimeout(() => goStep(2), 280);
  }));
}

// ═══════════════════════════════════════
//  MEASURE
// ═══════════════════════════════════════
function setupMeasure() {
  const u = el('inp-unit'), a = el('inp-area');
  if (u && current.unit) u.value = current.unit;
  if (a) { a.value = current.area || ''; }
  // Show map trigger or result
  const trigger = el('btn-open-map'), result = el('map-result');
  if (parseFloat(current.area) > 0 && drawnPolygonGeoJSON) {
    trigger.classList.add('hidden'); result.classList.remove('hidden');
  } else {
    trigger.classList.remove('hidden'); result.classList.add('hidden');
  }
  onMeasureChange();
}

function onMeasureChange() {
  current.area = el('inp-area')?.value || '';
  current.unit = el('inp-unit')?.value || 'sqft';
  const chips = el('conversion-chips'), v = parseFloat(current.area);
  if (chips && v > 0 && current.unit === 'sqft') {
    chips.innerHTML = `<span class="conv-chip">${(v/9).toFixed(1)} <span style="color:var(--text-lt)">sq yd</span></span><span class="conv-chip">${(v/43560).toFixed(4)} <span style="color:var(--text-lt)">acres</span></span>`;
  } else if (chips) chips.innerHTML = '';
  updateBtn();
}

// ═══════════════════════════════════════
//  MAPBOX — Full-screen satellite drawing
// ═══════════════════════════════════════
function openMap() {
  const overlay = el('map-overlay');
  overlay.classList.remove('hidden');
  mapPoints = [];
  updateMapUI();

  if (!map) {
    if (!mapboxToken) { toast('Map not available — enter area manually'); overlay.classList.add('hidden'); return; }
    mapboxgl.accessToken = mapboxToken;
    map = new mapboxgl.Map({
      container: 'map-box',
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: lastLng && lastLat ? [lastLng, lastLat] : [-96.797, 32.777],
      zoom: 18,
      attributionControl: true
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'bottom-right');

    map.on('load', () => {
      // Drawing layers
      map.addSource('draw-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw-src', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#E8A020', 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'draw-line', type: 'line', source: 'draw-src', paint: { 'line-color': '#E8A020', 'line-width': 3 } });
      map.addLayer({ id: 'draw-pts', type: 'circle', source: 'draw-src', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 7, 'circle-color': '#E8A020', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });

      // Click to add points
      map.on('click', onMapClick);
    });
  } else {
    // Map already exists — reset and re-center
    clearMapDraw();
    if (lastLng && lastLat) map.flyTo({ center: [lastLng, lastLat], zoom: 18, speed: 1.5 });
    setTimeout(() => map.resize(), 100);
  }
}

function onMapClick(e) {
  mapPoints.push([e.lngLat.lng, e.lngLat.lat]);
  updateMapPreview();
  updateMapUI();
}

function updateMapPreview() {
  if (!map || !map.getSource('draw-src')) return;
  const feats = [];
  // Points
  mapPoints.forEach(p => feats.push({ type:'Feature', geometry:{ type:'Point', coordinates:p }, properties:{} }));
  // Line/polygon preview
  if (mapPoints.length >= 2) {
    const coords = mapPoints.length >= 3 ? [...mapPoints, mapPoints[0]] : mapPoints;
    feats.push({ type:'Feature', geometry:{ type:'LineString', coordinates:coords }, properties:{} });
  }
  if (mapPoints.length >= 3) {
    feats.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[[...mapPoints, mapPoints[0]]] }, properties:{} });
  }
  map.getSource('draw-src').setData({ type:'FeatureCollection', features:feats });
}

function updateMapUI() {
  const n = mapPoints.length;
  const pts = el('map-pts');
  const done = el('btn-map-done');
  if (pts) {
    if (n === 0) pts.textContent = 'Tap on the map to start';
    else if (n === 1) pts.textContent = '1 point — tap more corners';
    else if (n === 2) pts.textContent = '2 points — tap one more';
    else pts.textContent = `${n} points — tap Done to calculate`;
  }
  if (done) done.disabled = n < 3;
}

function finishMapDraw() {
  if (mapPoints.length < 3) { toast('Tap at least 3 corners'); return; }
  const ring = [...mapPoints, mapPoints[0]];
  const sqm = polygonAreaSqm(ring);
  const sqft = sqm * 10.7639;

  if (sqft <= 0) { toast('Could not calculate area — try again'); return; }

  // Store polygon for saving with quote
  drawnPolygonGeoJSON = { type: 'Polygon', coordinates: [ring] };

  // Set area in current item
  current.area = String(Math.round(sqft));
  current.unit = 'sqft';

  // Show result on measure step
  el('mr-value').textContent = fmtNum(current.area);
  el('mr-unit').textContent = 'sq ft';
  el('map-result').classList.remove('hidden');
  el('btn-open-map').classList.add('hidden');
  el('inp-area').value = current.area;
  el('inp-unit').value = 'sqft';

  closeMap();
  onMeasureChange();
  toast('Area measured! ✓');
}

function redoMapDraw() {
  mapPoints = [];
  clearMapDraw();
  updateMapUI();
}

function clearMapDraw() {
  if (map && map.getSource('draw-src')) {
    map.getSource('draw-src').setData({ type:'FeatureCollection', features:[] });
  }
}

function closeMap() {
  el('map-overlay').classList.add('hidden');
}

// ═══════════════════════════════════════
//  PRICE
// ═══════════════════════════════════════
function setupPrice() {
  const svc = JOB_TYPES.find(j => j.id === current.service);
  const ctx = el('price-context');
  if (ctx && svc) ctx.innerHTML = `<span class="pc-icon">${svc.icon}</span><span class="pc-name">${svc.label}</span><span class="pc-area">${fmtNum(current.area)} ${US[current.unit]||'sf'}</span>`;
  const lbl = el('price-label'); if (lbl) lbl.textContent = `$ per ${UL[current.unit]||'unit'}`;
  const qp = el('quick-prices'), prices = QP[current.service]||[];
  if (qp) { qp.innerHTML = prices.map(p => `<button class="qp-btn" data-price="${p}">$${p}</button>`).join('');
    qp.querySelectorAll('.qp-btn').forEach(b => b.addEventListener('click', () => { current.price = b.dataset.price; el('inp-price').value = current.price; qp.querySelectorAll('.qp-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); onPriceChange(); })); }
  const pi = el('inp-price'); if (pi) { pi.value = current.price || ''; pi.focus(); }
  onPriceChange();
}

function onPriceChange() {
  current.price = el('inp-price')?.value || '';
  const total = (parseFloat(current.area)||0) * (parseFloat(current.price)||0);
  const lt = el('live-total');
  if (lt) { if (total > 0) { lt.classList.remove('hidden'); el('lt-amount').textContent = '$' + fmtMoney(total); el('lt-breakdown').textContent = `${fmtNum(current.area)} ${US[current.unit]} × $${current.price}/${US[current.unit]}`; } else lt.classList.add('hidden'); }
  el('quick-prices')?.querySelectorAll('.qp-btn').forEach(b => b.classList.toggle('active', b.dataset.price === current.price));
  updateBtn();
}

// ═══════════════════════════════════════
//  REVIEW
// ═══════════════════════════════════════
function renderReview() {
  const all = [...items];
  const gt = all.reduce((s,i) => s + (parseFloat(i.area)||0) * (parseFloat(i.price)||0), 0);
  el('review-total').textContent = '$' + fmtMoney(gt);
  el('review-count').textContent = all.length + ' service' + (all.length !== 1 ? 's' : '');
  const card = el('review-card'); if (!card) return;
  address = el('inp-address')?.value || ''; clientName = el('inp-client')?.value || '';
  let h = rcRow('Client', clientName || '—', 0) + rcRow('Address', address, 0);
  all.forEach(item => {
    const svc = JOB_TYPES.find(j => j.id === item.service); const sub = (parseFloat(item.area)||0) * (parseFloat(item.price)||0);
    h += `<div class="rc-item"><div class="rc-item-header"><div class="rc-item-name"><span>${svc?.icon||'📋'}</span> ${svc?.label||item.service}</div><span class="rc-item-sub">$${fmtMoney(sub)}</span></div><div class="rc-item-detail">${fmtNum(item.area)} ${UL[item.unit]} × $${item.price}/${US[item.unit]}</div></div>`;
  });
  card.innerHTML = h;
  card.querySelectorAll('.rc-row').forEach(r => r.addEventListener('click', () => goStep(parseInt(r.dataset.step))));
}
function rcRow(label, value, stepIdx) { return `<div class="rc-row" data-step="${stepIdx}"><span class="rc-label">${label}</span><div><span class="rc-value">${esc(value)}</span><span class="rc-edit">✏️</span></div></div>`; }

// ═══════════════════════════════════════
//  GEOCODING
// ═══════════════════════════════════════
async function fetchAddr(q) {
  if (!mapboxToken) return;
  try { const d = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&limit=5&country=US`).then(r=>r.json());
    const list = el('addr-autocomplete'); if (!list) return; list.innerHTML = '';
    (d.features||[]).forEach(f => { const item = document.createElement('div'); item.className = 'ac-item'; item.textContent = f.place_name;
      item.addEventListener('click', () => { el('inp-address').value = f.place_name; lastLat = f.center[1]; lastLng = f.center[0]; clearAC(); updateBtn(); }); list.appendChild(item); });
  } catch {}
}
function clearAC() { const l = el('addr-autocomplete'); if (l) l.innerHTML = ''; }

function geolocateUser() {
  if (!navigator.geolocation) { toast('GPS not available'); return; }
  toast('Getting location...');
  navigator.geolocation.getCurrentPosition(async pos => {
    lastLat = pos.coords.latitude; lastLng = pos.coords.longitude;
    if (mapboxToken) { try { const d = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${lastLng},${lastLat}.json?access_token=${mapboxToken}&limit=1`).then(r=>r.json());
      if (d.features?.length) { el('inp-address').value = d.features[0].place_name; updateBtn(); toast('Location set 📍'); } } catch { toast('Could not resolve address'); } }
    else { el('inp-address').value = `${lastLat.toFixed(5)}, ${lastLng.toFixed(5)}`; updateBtn(); toast('Location set 📍'); }
  }, () => toast('Location denied'));
}

function openExt(type) {
  const addr = el('inp-address')?.value || '', q = addr || (lastLat && lastLng ? `${lastLat},${lastLng}` : '');
  if (!q) { toast('Enter an address first'); return; }
  const urls = { maps:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`, earth:`https://earth.google.com/web/search/${encodeURIComponent(q)}`,
    street: lastLat && lastLng ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lastLat},${lastLng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` };
  window.open(urls[type], '_blank');
}

// ═══════════════════════════════════════
//  SAVE / LOAD
// ═══════════════════════════════════════
async function saveAndShare() {
  address = el('inp-address')?.value || ''; clientName = el('inp-client')?.value || '';
  if (!clientName) { toast('Enter a client name'); goStep(0); return; }
  const all = [...items], gt = all.reduce((s,i) => s + (parseFloat(i.area)||0)*(parseFloat(i.price)||0), 0);
  const p = all[0] || {}, narr = el('narrative-box')?.textContent || '';
  const payload = { client_name:clientName, project_type:p.service||'custom', area:parseFloat(p.area)||0, unit:p.unit||'sqft', price_per_unit:parseFloat(p.price)||0, total:gt, qty:1, notes:el('inp-notes')?.value||'', address, lat:lastLat, lng:lastLng, polygon_geojson:drawnPolygonGeoJSON,
    ai_narrative:(narr && !narr.includes('Writing')) ? narr : '', line_items:all.map(i => ({type:i.service,area:parseFloat(i.area)||0,unit:i.unit,price:parseFloat(i.price)||0,qty:1,label:JOB_TYPES.find(j=>j.id===i.service)?.label||i.service,subtotal:(parseFloat(i.area)||0)*(parseFloat(i.price)||0)})), markup:0 };
  try { let res; if (editingQuoteId) res = await authFetch(`/api/quotes/${editingQuoteId}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    else res = await authFetch('/api/quotes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if (!res.ok) throw new Error(); editingQuoteId = null; toast('Saved! 💾'); setTimeout(openSheet, 300);
  } catch { toast('Save failed'); }
}

async function loadSaved() {
  const s = el('search-quotes')?.value||'', c = el('saved-list'); if (!c) return; c.innerHTML = '<div class="empty-state">Loading...</div>';
  try { const d = await authFetch(`/api/quotes?search=${encodeURIComponent(s)}&limit=30`).then(r=>r.json()); renderSavedList(d.quotes||[]); } catch { c.innerHTML = '<div class="empty-state">Failed to load.</div>'; }
}

function renderSavedList(quotes) {
  const c = el('saved-list');
  if (!quotes.length) { c.innerHTML = '<div class="empty-state">No quotes yet.</div>'; return; }
  window._sq = {}; quotes.forEach(q => window._sq[q.id] = q);
  c.innerHTML = quotes.map(q => {
    let it = ''; try { const li = JSON.parse(q.line_items||'[]'); it = li.map(i=>(i.label||i.type||'').replace(/-/g,' ')).join(' + '); } catch {} if (!it) it = (q.project_type||'').replace(/-/g,' ');
    return `<div class="quote-card"><div class="qc-header"><div><div class="qc-client">${esc(q.client_name)}</div><div class="qc-meta">${it}</div><div class="qc-meta">${new Date(q.created_at).toLocaleDateString()}</div></div><div class="qc-total">$${fmtMoney(q.total)}</div></div>${q.address?`<div class="qc-meta">📍 ${esc(q.address.split(',').slice(0,2).join(','))}</div>`:''}<div class="qc-actions"><button class="mini-btn edit" data-id="${q.id}">✏️ Edit</button><button class="mini-btn load" data-id="${q.id}">Load</button><button class="mini-btn share" data-id="${q.id}">Share</button><button class="mini-btn del" data-id="${q.id}">Delete</button></div></div>`;
  }).join('');
  c.querySelectorAll('.mini-btn.edit').forEach(b => b.addEventListener('click', () => editQuote(b.dataset.id)));
  c.querySelectorAll('.mini-btn.load').forEach(b => b.addEventListener('click', () => loadQuote(b.dataset.id)));
  c.querySelectorAll('.mini-btn.share').forEach(b => b.addEventListener('click', () => { openSheet(); }));
  c.querySelectorAll('.mini-btn.del').forEach(b => b.addEventListener('click', () => deleteQuote(b.dataset.id)));
}

async function loadQuote(id) {
  try { const q = await authFetch(`/api/quotes/${id}`).then(r=>r.json()); if (q.error) throw new Error();
    el('inp-client').value = q.client_name||''; el('inp-address').value = q.address||''; el('inp-notes').value = q.notes||'';
    address = q.address||''; clientName = q.client_name||''; lastLat = q.lat; lastLng = q.lng;
    items = []; let li = []; try { li = JSON.parse(q.line_items||'[]'); } catch {}
    if (li.length > 0) li.forEach((l,i) => { const it = {service:l.type,area:String(l.area||0),unit:l.unit||'sqft',price:String(l.price||0)}; if (i < li.length-1) items.push(it); else current = it; });
    else current = {service:q.project_type||'custom',area:String(q.area||0),unit:q.unit||'sqft',price:String(q.price_per_unit||0)};
    if (q.polygon_geojson) { try { drawnPolygonGeoJSON = typeof q.polygon_geojson === 'string' ? JSON.parse(q.polygon_geojson) : q.polygon_geojson; } catch {} }
    if (q.ai_narrative) { el('narrative-box').textContent = q.ai_narrative; el('narrative-box').classList.remove('hidden'); }
    switchView('quote'); if (current.service) items.push({...current}); current = {service:null,area:'',unit:'sqft',price:''};
    goStep(4); toast('Quote loaded ✓');
  } catch { toast('Could not load quote'); }
}

async function editQuote(id) { await loadQuote(id); editingQuoteId = id; toast('Editing — make changes and Save'); }
async function deleteQuote(id) { if (!confirm('Delete this quote?')) return; try { await authFetch(`/api/quotes/${id}`,{method:'DELETE'}); toast('Deleted'); loadSaved(); } catch { toast('Delete failed'); } }
async function exportAll() { try { const d = await authFetch('/api/quotes?limit=500').then(r=>r.json()); const t = (d.quotes||[]).map(q=>buildShareQ(q)).join('\n\n══════\n\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t],{type:'text/plain'})); a.download = 'quotes.txt'; a.click(); toast('Exported!'); } catch { toast('Export failed'); } }

// ═══════════════════════════════════════
//  AI
// ═══════════════════════════════════════
async function aiSuggestPrice() {
  const a = parseFloat(current.area); if (!a) { toast('Enter an area first'); return; }
  const btn = el('btn-ai-price'); if (btn) { btn.disabled = true; btn.textContent = '⏳ Getting prices...'; }
  try { const r = await authFetch('/api/ai/suggest-price',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_type:current.service||'custom',area:a.toFixed(1),unit:UL[current.unit]||'sq ft',location:el('inp-address')?.value||'DFW Texas'})}); if (!r.ok) throw new Error(); aiPriceData = await r.json(); showAiPriceModal(aiPriceData); } catch { toast('AI pricing unavailable'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '✨ AI Suggest Price'; } }
}
function showAiPriceModal(d) { const f = v => '$'+parseFloat(v||0).toFixed(2);
  el('ai-price-content').innerHTML = `<div class="price-tier low"><div><div class="tier-label">🟢 Low</div><div class="tier-sub">Competitive</div></div><div class="tier-right"><div class="tier-val">${f(d.low_per_unit)}<span>/unit</span></div><div class="tier-total">≈ ${f(d.low_total)}</div></div></div><div class="price-tier mid"><div><div class="tier-label">⭐ Recommended</div><div class="tier-sub">Market rate</div></div><div class="tier-right"><div class="tier-val">${f(d.recommended_per_unit)}<span>/unit</span></div><div class="tier-total">≈ ${f(d.mid_total)}</div></div></div><div class="price-tier high"><div><div class="tier-label">🔴 Premium</div><div class="tier-sub">High-end</div></div><div class="tier-right"><div class="tier-val">${f(d.high_per_unit)}<span>/unit</span></div><div class="tier-total">≈ ${f(d.high_total)}</div></div></div>${d.reasoning?`<div class="ai-reasoning">💡 ${d.reasoning}</div>`:''}`;
  openModal('ai-price-modal');
}
function applyAiPrice() { if (!aiPriceData) return; current.price = String(parseFloat(aiPriceData.recommended_per_unit)); el('inp-price').value = current.price; onPriceChange(); closeModal('ai-price-modal'); toast('Price applied ✨'); }

async function generateNarrative() {
  clientName = el('inp-client')?.value||''; if (!clientName) { toast('Enter a client name'); return; }
  const box = el('narrative-box'); box.classList.remove('hidden'); box.textContent = '✍️ Writing...';
  const all = [...items], gt = all.reduce((s,i) => s+(parseFloat(i.area)||0)*(parseFloat(i.price)||0),0), p = all[0]||{};
  const is = all.map(i => `${JOB_TYPES.find(j=>j.id===i.service)?.label||i.service}: ${fmtNum(i.area)} ${UL[i.unit]} × $${parseFloat(i.price).toFixed(2)} = $${fmtMoney((parseFloat(i.area)||0)*(parseFloat(i.price)||0))}`).join('\n');
  try { const r = await authFetch('/api/ai/generate-narrative',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:clientName,project_type:all.map(i=>JOB_TYPES.find(j=>j.id===i.service)?.label||i.service).join(' + '),area:p.area||'0',unit:UL[p.unit]||'sq ft',price_per_unit:p.price||'0',total:fmtMoney(gt),notes:(el('inp-notes')?.value||'')+'\n\nLine items:\n'+is,address:el('inp-address')?.value||'',qty:1})}); const d = await r.json(); box.textContent = d.narrative||'No narrative returned.'; toast('Narrative ready ✍️'); } catch { box.textContent = 'Could not generate.'; }
}

function openChat() { el('ai-panel').classList.add('open'); el('ai-overlay').classList.add('open'); if (!chatHistory.length) addChat('ai','Hi! Ask me anything about pricing or measurements 💡'); setTimeout(()=>el('chat-input')?.focus(),300); }
function closeChat() { el('ai-panel').classList.remove('open'); el('ai-overlay').classList.remove('open'); }
async function sendChat() { const inp = el('chat-input'), msg = inp?.value.trim(); if (!msg) return; inp.value = ''; addChat('user',msg); chatHistory.push({role:'user',content:msg}); const tid = addChat('ai','...',true);
  try { const r = await authFetch('/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:chatHistory.slice(-10),context:{project_type:current.service,area:current.area,unit:UL[current.unit],price:current.price,address:el('inp-address')?.value||''}})}); const d = await r.json(); rmMsg(tid); const reply = d.reply||'Something went wrong.'; addChat('ai',reply); chatHistory.push({role:'assistant',content:reply}); } catch { rmMsg(tid); addChat('ai','Connection error.'); } }
function addChat(role,text,typing=false) { const c = el('chat-messages'); if (!c) return ''; const id = 'msg-'+Date.now(); const d = document.createElement('div'); d.id = id; d.className = `chat-msg ${role}${typing?' typing':''}`; d.textContent = text; c.appendChild(d); c.scrollTop = c.scrollHeight; return id; }
function rmMsg(id) { document.getElementById(id)?.remove(); }

// ═══════════════════════════════════════
//  PDF
// ═══════════════════════════════════════
function generatePDF() {
  const all = [...items], gt = all.reduce((s,i) => s+(parseFloat(i.area)||0)*(parseFloat(i.price)||0),0);
  clientName = el('inp-client')?.value||'Client'; address = el('inp-address')?.value||'';
  const notes = el('inp-notes')?.value||'', narr = el('narrative-box')?.textContent||'', today = new Date().toLocaleDateString();
  const rows = all.map(i => { const l = JOB_TYPES.find(j=>j.id===i.service)?.label||i.service, sub = (parseFloat(i.area)||0)*(parseFloat(i.price)||0);
    return `<tr><td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;font-weight:600">${l}</td><td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;text-align:right">${fmtNum(i.area)} ${UL[i.unit]}</td><td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;text-align:right">$${parseFloat(i.price).toFixed(2)}</td><td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;text-align:right;font-weight:700">$${fmtMoney(sub)}</td></tr>`; }).join('');
  const w = window.open('','_blank'); if (!w) { toast('Allow popups'); return; }
  w.document.write(`<!DOCTYPE html><html><head><title>Quote — ${clientName}</title><link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet"><style>*{box-sizing:border-box}body{font-family:'DM Sans',sans-serif;padding:40px;color:#0D2137;max-width:700px;margin:0 auto}table{width:100%;border-collapse:collapse;margin:16px 0}th{text-align:left;padding:8px;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;border-bottom:2px solid #1C3A5E}th:nth-child(n+2){text-align:right}.tr{background:#0D2137;color:white;padding:16px 20px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;margin:20px 0}.tv{font-family:'Bebas Neue',sans-serif;font-size:42px;color:#E8A020}.n{background:#F4F7FA;border-radius:8px;padding:16px;font-size:13px;line-height:1.8;margin:16px 0;white-space:pre-wrap}@media print{.np{display:none!important}}</style></head><body><h1 style="font-family:'Bebas Neue',sans-serif;font-size:42px;letter-spacing:4px;color:#1C3A5E;margin:0">QUOTE<span style="color:#E8A020">machine</span></h1><div style="color:#6B8FAD;font-size:13px;margin-bottom:24px">Estimate · ${today}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px"><div><div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;margin-bottom:3px">Client</div><div style="font-size:15px;font-weight:600">${clientName}</div></div>${address?`<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;margin-bottom:3px">Location</div><div style="font-size:13px">${address}</div></div>`:''}</div><table><thead><tr><th>Service</th><th>Area</th><th>Rate</th><th>Subtotal</th></tr></thead><tbody>${rows}</tbody></table><div class="tr"><div><div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.6);font-weight:700">Estimated Total</div></div><div class="tv">$${fmtMoney(gt)}</div></div>${notes?`<div style="font-size:13px;line-height:1.6;margin-bottom:16px">${notes}</div>`:``}${narr&&!narr.includes('Writing')?`<div class="n">${narr}</div>`:``}<div style="font-size:11px;color:#9ab;margin-top:28px;text-align:center">Estimate — final pricing subject to on-site inspection.</div><br><button class="np" onclick="window.print()" style="padding:12px 28px;background:#0D2137;color:white;border:none;border-radius:8px;font-size:15px;cursor:pointer">🖨️ Print / Save as PDF</button></body></html>`);
  w.document.close();
}

// ═══════════════════════════════════════
//  SHARE
// ═══════════════════════════════════════
function openSheet() { el('share-sheet')?.classList.add('open'); }
function closeSheet() { el('share-sheet')?.classList.remove('open'); }
function buildShareText() { const all = [...items], gt = all.reduce((s,i) => s+(parseFloat(i.area)||0)*(parseFloat(i.price)||0),0); clientName = el('inp-client')?.value||'Client'; address = el('inp-address')?.value||'';
  return `📋 QUOTE machine\nClient: ${clientName}\n${address?'Location: '+address+'\n':''}Items:\n${all.map(i=>`  • ${JOB_TYPES.find(j=>j.id===i.service)?.label||i.service}: ${fmtNum(i.area)} ${UL[i.unit]} × $${parseFloat(i.price).toFixed(2)} = $${fmtMoney((parseFloat(i.area)||0)*(parseFloat(i.price)||0))}`).join('\n')}\n──────────\nTOTAL: $${fmtMoney(gt)}\nDate: ${new Date().toLocaleDateString()}`; }
function buildShareQ(q) { let it=''; try { const li=JSON.parse(q.line_items||'[]'); it=li.map(i=>`  • ${i.label||i.type}: ${fmtNum(i.area)} ${UL[i.unit]||i.unit} × $${parseFloat(i.price).toFixed(2)} = $${fmtMoney(i.subtotal||(i.area*i.price))}`).join('\n'); } catch{} return `📋 QUOTE machine\nClient: ${q.client_name}\n${q.address?'Location: '+q.address+'\n':''}Items:\n${it}\n──────────\nTOTAL: $${fmtMoney(q.total)}\nDate: ${new Date(q.created_at).toLocaleDateString()}`; }
function copyShare() { navigator.clipboard.writeText(buildShareText()).then(()=>toast('Copied! 📋')).catch(()=>toast('Copy failed')); }
function smsShare() { window.open('sms:?body='+encodeURIComponent(buildShareText())); }
function emailShare() { window.open(`mailto:?subject=${encodeURIComponent('Quote Estimate')}&body=${encodeURIComponent(buildShareText())}`); }

// ═══════════════════════════════════════
//  STATS
// ═══════════════════════════════════════
async function loadStats() { const c = el('stats-content');
  try { const s = await authFetch('/api/stats').then(r=>r.json()); const m = v => '$'+parseFloat(v||0).toLocaleString(undefined,{maximumFractionDigits:0});
    const rows = (s.by_type||[]).map(t => `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--surface2)"><div style="font-size:13px;font-weight:600;text-transform:capitalize">${(t.project_type||'').replace(/-/g,' ')}</div><div style="text-align:right"><div style="font-family:'Bebas Neue',sans-serif;font-size:18px;color:var(--accent)">${m(t.revenue)}</div><div style="font-size:10px;color:var(--text-lt)">${t.count} quote${t.count!=1?'s':''}</div></div></div>`).join('');
    c.innerHTML = `<div class="stat-grid"><div class="stat-card"><div class="stat-val">${s.total_quotes}</div><div class="stat-lbl">Quotes</div></div><div class="stat-card"><div class="stat-val">${m(s.total_value)}</div><div class="stat-lbl">Total Value</div></div><div class="stat-card"><div class="stat-val">${m(s.avg_quote)}</div><div class="stat-lbl">Avg Quote</div></div><div class="stat-card"><div class="stat-val">${s.this_month}</div><div class="stat-lbl">This Month</div></div></div>${rows?`<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-lt);margin:12px 0 6px">By Job Type</div><div>${rows}</div>`:''}`;
  } catch { c.innerHTML = '<div class="empty-state">Failed to load stats.</div>'; } }

// ═══════════════════════════════════════
//  RESET
// ═══════════════════════════════════════
function resetQuote() {
  step = 0; items = []; current = {service:null,area:'',unit:'sqft',price:''}; editingQuoteId = null; drawnPolygonGeoJSON = null; mapPoints = [];
  el('inp-address').value = ''; el('inp-client').value = ''; el('inp-notes').value = ''; el('inp-area').value = ''; el('inp-price').value = '';
  el('narrative-box').classList.add('hidden'); el('narrative-box').textContent = '';
  el('map-result').classList.add('hidden'); el('btn-open-map').classList.remove('hidden');
  document.querySelectorAll('.svc-row').forEach(r => r.classList.remove('selected'));
  if (map && map.getSource('draw-src')) clearMapDraw();
  goStep(0); toast('New quote started');
}

// ═══════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════
function el(id) { return document.getElementById(id); }
function on(id, fn) { el(id)?.addEventListener('click', fn); }
function openModal(id) { el(id)?.classList.add('open'); }
function closeModal(id) { el(id)?.classList.remove('open'); }
function toast(msg) { const t = el('toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2600); }
function fmtNum(n) { return parseFloat(n||0).toLocaleString(undefined,{maximumFractionDigits:1}); }
function fmtMoney(n) { return parseFloat(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ═══════════════════════════════════════
//  PWA INSTALL
// ═══════════════════════════════════════
function setupInstallBanner() {
  let dp = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); dp = e; if (sessionStorage.getItem('qmach_install_dismissed')) return; el('install-banner').style.display = 'flex'; });
  on('install-btn', async () => { if (!dp) return; dp.prompt(); await dp.userChoice; dp = null; el('install-banner').style.display = 'none'; });
  on('install-dismiss', () => { el('install-banner').style.display = 'none'; sessionStorage.setItem('qmach_install_dismissed','1'); });
  window.addEventListener('appinstalled', () => { el('install-banner').style.display = 'none'; dp = null; });
}
