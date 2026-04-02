// ═══════════════════════════════════════
//  QUOTE machine — Phase 1+2 (all bugs fixed)
// ═══════════════════════════════════════

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
const UNIT_LABELS = { sqft:'sq ft', linft:'lin ft', sqyd:'sq yd', acre:'acres' };
const UNIT_SHORT  = { sqft:'sf', linft:'lf', sqyd:'sy', acre:'ac' };
const QUICK_PRICES = {
  'pressure-washing':[0.08,0.12,0.18,0.25,0.35],'parking-lot-striping':[0.15,0.25,0.35,0.50],
  'sealcoating':[0.10,0.15,0.20,0.25],'painting':[1.50,2.00,3.00,4.00],
  'roofing':[3.50,5.00,6.50,8.00],'concrete':[4.00,6.00,8.00,12.00],
  'landscaping':[2.00,3.00,4.00,6.00],'custom':[1.00,5.00,10.00,25.00]
};

// ── State
let authToken = sessionStorage.getItem('qmach_token') || '';
let mapboxToken = '';
let step = 0;
let items = [];                // completed line items [{service, area, unit, price}]
let current = { service: null, area: '', unit: 'sqft', price: '' };
let address = '', clientName = '', lastLat = null, lastLng = null;
let editingQuoteId = null, chatHistory = [], aiPriceData = null, debounceTimer = null;
let map = null, mapReady = false, drawPoints = [];
let drawnPolygonGeoJSON = null, drawnAreaSqMeters = 0;

// ═══════════════════════════════════════
//  GEOMETRY (no turf.js — CSP safe)
// ═══════════════════════════════════════
function haversineMeters(a, b) {
  const R = 6371008.8, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]), dLng = toRad(b[0] - a[0]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function polygonAreaSqMeters(ring) {
  const R = 6371008.8, toRad = d => d * Math.PI / 180;
  const pts = ring.map(p => [R * toRad(p[0]) * Math.cos(toRad(p[1])), R * toRad(p[1])]);
  let area = 0;
  for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) {
    area += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  }
  return Math.abs(area / 2);
}

// ═══════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════
async function authFetch(url, opts = {}) {
  if (!opts.headers) opts.headers = {};
  if (authToken) opts.headers['x-auth-token'] = authToken;
  const r = await fetch(url, opts);
  if (r.status === 401) {
    sessionStorage.removeItem('qmach_token'); authToken = '';
    showLogin(); throw new Error('Unauthorized');
  }
  return r;
}

function showLogin() { el('login-gate').classList.remove('hidden'); }
function hideLogin() { el('login-gate').classList.add('hidden'); }

async function checkAuth() {
  try {
    const r = await fetch('/api/auth/check', { headers: authToken ? { 'x-auth-token': authToken } : {} });
    const d = await r.json();
    if (d.valid) { hideLogin(); return true; }
  } catch {}
  showLogin(); return false;
}

async function doLogin() {
  const btn = el('login-btn'), pw = el('login-password'), err = el('login-error');
  if (!pw.value.trim()) { err.textContent = 'Enter a password'; return; }
  btn.disabled = true; btn.textContent = 'Signing in...'; err.textContent = '';
  try {
    const r = await fetch('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw.value.trim() })
    });
    const d = await r.json();
    if (d.success) {
      authToken = d.token; sessionStorage.setItem('qmach_token', authToken);
      hideLogin(); bootApp();
    } else { err.textContent = 'Wrong password'; pw.value = ''; pw.focus(); }
  } catch { err.textContent = 'Connection error'; }
  btn.disabled = false; btn.textContent = 'Sign In';
}

// ═══════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  on('login-btn', doLogin);
  el('login-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  if (await checkAuth()) bootApp();
});

async function bootApp() {
  el('app-shell').classList.remove('hidden');
  renderServiceList();

  // Header tabs
  document.querySelectorAll('.htab').forEach(btn =>
    btn.addEventListener('click', () => switchView(btn.dataset.view))
  );

  // Wizard nav
  on('btn-continue', onContinue);
  on('btn-back', () => goStep(step - 1));
  document.querySelectorAll('.pdot').forEach(dot =>
    dot.addEventListener('click', () => { const s = parseInt(dot.dataset.step); if (s < step) goStep(s); })
  );

  // ── FIX: Address input enables Continue on every keystroke
  const addrInput = el('inp-address');
  if (addrInput) {
    addrInput.addEventListener('input', () => {
      updateContinueBtn(); // <-- THIS WAS MISSING
      clearTimeout(debounceTimer);
      const q = addrInput.value.trim();
      if (q.length < 3) { clearAddrAC(); return; }
      debounceTimer = setTimeout(() => fetchAddrSuggestions(q), 300);
    });
    addrInput.addEventListener('keydown', e => { if (e.key === 'Escape') clearAddrAC(); });
    document.addEventListener('click', e => {
      if (!addrInput.contains(e.target) && !el('addr-autocomplete')?.contains(e.target)) clearAddrAC();
    });
  }

  // ── FIX: Client input also triggers Continue check
  el('inp-client')?.addEventListener('input', () => updateContinueBtn());

  // Quick buttons
  on('btn-gps', geolocateUser);
  on('btn-gmaps', () => openExternal('maps'));
  on('btn-gearth', () => openExternal('earth'));
  on('btn-street', () => openExternal('street'));

  // Measure inputs
  el('inp-area')?.addEventListener('input', onMeasureChange);
  el('inp-unit')?.addEventListener('change', onMeasureChange);

  // Price input
  el('inp-price')?.addEventListener('input', onPriceChange);

  // Map
  on('btn-open-map', openMapOverlay);
  on('btn-map-close', closeMapOverlay);
  on('btn-map-done', finishMapDraw);
  on('btn-map-redo', redoMapDraw);
  on('btn-redraw', () => {
    el('map-result').classList.add('hidden');
    el('btn-open-map').classList.remove('hidden');
    openMapOverlay();
  });

  // AI / actions
  on('btn-ai-price', aiSuggestPrice);
  on('ai-price-dismiss', () => closeModal('ai-price-modal'));
  on('ai-price-apply', applyAiPrice);
  on('btn-add-another', addAnother);
  on('btn-save-share', saveAndShare);
  on('btn-pdf', () => generatePDF());
  on('btn-ai-narrative', generateNarrative);
  on('btn-new-quote', resetQuote);
  on('btn-cancel', cancelQuote);

  // Share sheet
  on('share-sms', () => { closeSheet(); smsShare(); });
  on('share-email', () => { closeSheet(); emailShare(); });
  on('share-copy', () => { closeSheet(); copyShare(); });
  on('share-pdf', () => { closeSheet(); generatePDF(); });
  on('share-done', closeSheet);
  el('share-sheet')?.addEventListener('click', e => { if (e.target.id === 'share-sheet') closeSheet(); });

  // Saved + stats
  el('search-quotes')?.addEventListener('input', loadSaved);
  on('btn-export', exportAll);

  // AI chat
  on('btn-ai-chat', openChat);
  on('ai-panel-close', closeChat);
  on('ai-overlay', closeChat);
  on('chat-send', sendChat);
  el('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  setupInstallBanner();

  try {
    const cfg = await authFetch('/api/config').then(r => r.json());
    mapboxToken = cfg.mapboxToken || '';
  } catch {}

  // Browser back button → navigate wizard steps instead of leaving the app
  history.replaceState({ step: 0 }, '', '');
  window.addEventListener('popstate', e => {
    // If map overlay is open, close it instead of navigating
    if (!el('map-overlay').classList.contains('hidden')) {
      closeMapOverlay();
      history.pushState({ step: step }, '', '');
      return;
    }
    // If share sheet is open, close it
    if (el('share-sheet').classList.contains('open')) {
      closeSheet();
      history.pushState({ step: step }, '', '');
      return;
    }
    // If AI panel is open, close it
    if (el('ai-panel').classList.contains('open')) {
      closeChat();
      history.pushState({ step: step }, '', '');
      return;
    }
    // If any modal is open, close it
    const openModal = document.querySelector('.modal-overlay.open');
    if (openModal) {
      openModal.classList.remove('open');
      history.pushState({ step: step }, '', '');
      return;
    }
    // Navigate wizard steps
    if (e.state && typeof e.state.step === 'number') {
      goStep(e.state.step, true);
    } else if (step > 0) {
      goStep(step - 1, true);
    }
    // If already at step 0, push state to prevent leaving
    if (step === 0) {
      history.pushState({ step: 0 }, '', '');
    }
  });

  goStep(0);
}

// ═══════════════════════════════════════
//  MAP — Full-screen overlay
// ═══════════════════════════════════════
function openMapOverlay() {
  if (!mapboxToken) { toast('Map not available — enter area manually'); return; }
  el('map-overlay').classList.remove('hidden');
  drawPoints = [];
  updateMapUI();
  if (!map) initMap();
  else { map.resize(); resetMapDraw(); }
  if (lastLat && lastLng && map) {
    setTimeout(() => map.flyTo({ center: [lastLng, lastLat], zoom: 19, speed: 2 }), 100);
  }
}

function closeMapOverlay() { el('map-overlay').classList.add('hidden'); }

function initMap() {
  mapboxgl.accessToken = mapboxToken;
  map = new mapboxgl.Map({
    container: 'map-box',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    center: lastLng && lastLat ? [lastLng, lastLat] : [-96.797, 32.777],
    zoom: 18, attributionControl: true
  });
  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'bottom-right');

  map.on('load', () => {
    mapReady = true;
    map.addSource('draw-poly', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw-poly', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#3A5E30', 'fill-opacity': 0.2 } });
    map.addLayer({ id: 'draw-line', type: 'line', source: 'draw-poly', paint: { 'line-color': '#3A5E30', 'line-width': 3, 'line-dasharray': [3, 2] } });
    map.addSource('draw-pts', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'draw-vertices', type: 'circle', source: 'draw-pts', paint: { 'circle-radius': 7, 'circle-color': '#3A5E30', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    if (lastLat && lastLng) map.flyTo({ center: [lastLng, lastLat], zoom: 19 });
  });

  map.on('click', e => {
    drawPoints.push([e.lngLat.lng, e.lngLat.lat]);
    updateMapPreview();
    updateMapUI();
  });
}

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

function updateMapPreview() {
  if (!map || !mapReady) return;
  const pts = drawPoints;
  const ptFeatures = pts.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} }));
  map.getSource('draw-pts')?.setData({ type: 'FeatureCollection', features: ptFeatures });
  const features = [];
  if (pts.length >= 2) {
    const coords = pts.length >= 3 ? [...pts, pts[0]] : pts;
    const geomType = pts.length >= 3 ? 'Polygon' : 'LineString';
    const geomCoords = pts.length >= 3 ? [coords] : coords;
    features.push({ type: 'Feature', geometry: { type: geomType, coordinates: geomCoords }, properties: {} });
  }
  map.getSource('draw-poly')?.setData({ type: 'FeatureCollection', features });
}

function updateMapUI() {
  const n = drawPoints.length;
  const pts = el('map-pts'), done = el('btn-map-done');
  if (n === 0) pts.textContent = 'Tap on the map to start';
  else if (n === 1) pts.textContent = '1 point — tap more corners';
  else if (n === 2) pts.textContent = '2 points — one more for area';
  else pts.textContent = `${n} points — tap Done to calculate`;
  done.disabled = n < 3;
}

function finishMapDraw() {
  if (drawPoints.length < 3) { toast('Tap at least 3 corners'); return; }
  const ring = [...drawPoints, drawPoints[0]];
  const sqm = polygonAreaSqMeters(ring);
  if (!sqm || sqm <= 0) { toast('Could not calculate — try again'); return; }

  drawnAreaSqMeters = sqm;
  drawnPolygonGeoJSON = { type: 'Polygon', coordinates: [ring] };
  const sqft = sqm * 10.7639;

  current.area = String(Math.round(sqft));
  current.unit = 'sqft';

  el('mr-value').textContent = fmtNum(sqft);
  el('mr-unit').textContent = 'sq ft';
  el('map-result').classList.remove('hidden');
  el('btn-open-map').classList.add('hidden');
  el('inp-area').value = Math.round(sqft);
  el('inp-unit').value = 'sqft';
  onMeasureChange();

  closeMapOverlay();
  toast(`${fmtNum(sqft)} sq ft measured ✓`);
}

function redoMapDraw() {
  drawPoints = [];
  if (map && mapReady) {
    map.getSource('draw-poly')?.setData(emptyFC());
    map.getSource('draw-pts')?.setData(emptyFC());
  }
  updateMapUI();
}

function resetMapDraw() { redoMapDraw(); }

// ═══════════════════════════════════════
//  WIZARD NAVIGATION
// ═══════════════════════════════════════
function goStep(s, fromPopState) {
  if (s < 0 || s >= 5) return;
  step = s;

  // Push browser history so back button navigates steps, not away from app
  if (!fromPopState) {
    history.pushState({ step: s }, '', '');
  }

  // Show/hide step panels
  document.querySelectorAll('.step').forEach((el, i) => {
    el.classList.toggle('hidden', i !== s);
    if (i === s) { el.style.animation = 'none'; void el.offsetHeight; el.style.animation = ''; }
  });

  // Progress dots
  document.querySelectorAll('.pdot').forEach((d, i) => {
    d.classList.remove('active', 'completed');
    if (i < s) d.classList.add('completed');
    else if (i === s) d.classList.add('active');
  });
  document.querySelectorAll('.pline').forEach((l, i) => l.classList.toggle('filled', i < s));

  // Bottom action bar
  const ba = el('bottom-action'), bc = el('btn-continue'), bb = el('btn-back');
  if (s === 1 || s === 4) {
    // Service: auto-advance, no button. Review: has its own buttons.
    ba.classList.add('hidden');
  } else {
    ba.classList.remove('hidden');
    bb.classList.toggle('hidden', s === 0);
    if (s === 3) {
      bc.textContent = 'Review Quote →';
      bc.className = 'btn-primary green';
    } else {
      bc.textContent = 'Continue →';
      bc.className = 'btn-primary';
    }
  }

  updateContinueBtn();

  // Step-specific setup
  if (s === 0) el('inp-address')?.focus();
  if (s === 1) {
    // Pre-select current service if editing
    document.querySelectorAll('.svc-row').forEach(r => {
      r.classList.toggle('selected', r.dataset.id === current.service);
    });
  }
  if (s === 2) setupMeasureStep();
  if (s === 3) setupPriceStep();
  if (s === 4) renderReview();

  // Scroll step content to top
  el('step-content')?.scrollTo(0, 0);
}

function onContinue() {
  if (step === 3) {
    // Finish current item → push to items → go to review
    items.push({ ...current });
    current = { service: null, area: '', unit: 'sqft', price: '' };
    goStep(4);
  } else if (step < 4) {
    goStep(step + 1);
  }
}

function addAnother() {
  // Reset current for a new item, go back to service selection
  current = { service: null, area: '', unit: 'sqft', price: '' };
  drawnAreaSqMeters = 0;
  drawnPolygonGeoJSON = null;
  goStep(1);
}

function canContinue() {
  if (step === 0) return (el('inp-address')?.value.trim().length > 3);
  if (step === 2) return parseFloat(el('inp-area')?.value) > 0;
  if (step === 3) return parseFloat(el('inp-price')?.value) > 0;
  return true;
}

function updateContinueBtn() {
  const b = el('btn-continue');
  if (b) b.disabled = !canContinue();
}

function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  el('view-' + view)?.classList.add('active');
  document.querySelectorAll('.htab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'saved') loadSaved();
  if (view === 'stats') loadStats();
}

// ═══════════════════════════════════════
//  STEP 1: SERVICE
// ═══════════════════════════════════════
function renderServiceList() {
  const list = el('service-list');
  if (!list) return;
  list.innerHTML = JOB_TYPES.map(j =>
    `<button class="svc-row" data-id="${j.id}">
      <span class="svc-icon">${j.icon}</span>
      <div class="svc-info"><div class="svc-name">${j.label}</div><div class="svc-range">${j.range}</div></div>
      <span class="svc-arrow">›</span>
    </button>`
  ).join('');

  list.querySelectorAll('.svc-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      const job = JOB_TYPES.find(j => j.id === id);
      current.service = id;
      current.unit = job?.unit || 'sqft';
      list.querySelectorAll('.svc-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      setTimeout(() => goStep(2), 280);
    });
  });
}

// ═══════════════════════════════════════
//  STEP 2: MEASURE
// ═══════════════════════════════════════
function setupMeasureStep() {
  const u = el('inp-unit');
  if (u && current.unit) u.value = current.unit;
  const a = el('inp-area');
  if (a) { a.value = current.area || ''; if (!current.area) a.focus(); }

  if (parseFloat(current.area) > 0 && drawnAreaSqMeters > 0) {
    el('map-result').classList.remove('hidden');
    el('btn-open-map').classList.add('hidden');
  } else {
    el('map-result').classList.add('hidden');
    el('btn-open-map').classList.remove('hidden');
  }
  onMeasureChange();
}

function onMeasureChange() {
  current.area = el('inp-area')?.value || '';
  current.unit = el('inp-unit')?.value || 'sqft';
  const chips = el('conversion-chips'), v = parseFloat(current.area);
  if (chips && v > 0 && current.unit === 'sqft') {
    chips.innerHTML = `<span class="conv-chip">${(v / 9).toFixed(1)} sq yd</span>
      <span class="conv-chip">${(v / 43560).toFixed(4)} acres</span>`;
  } else if (chips) chips.innerHTML = '';
  updateContinueBtn();
}

// ═══════════════════════════════════════
//  STEP 3: PRICE
// ═══════════════════════════════════════
function setupPriceStep() {
  const svc = JOB_TYPES.find(j => j.id === current.service);
  const ctx = el('price-context');
  if (ctx && svc) {
    ctx.innerHTML = `<span class="pc-icon">${svc.icon}</span>
      <span class="pc-name">${svc.label}</span>
      <span class="pc-area">${fmtNum(current.area)} ${UNIT_SHORT[current.unit] || 'sf'}</span>`;
  }
  el('price-label').textContent = `$ per ${UNIT_LABELS[current.unit] || 'unit'}`;

  const qp = el('quick-prices');
  const prices = QUICK_PRICES[current.service] || [];
  if (qp) {
    qp.innerHTML = prices.map(p => `<button class="qp-btn" data-price="${p}">$${p}</button>`).join('');
    qp.querySelectorAll('.qp-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        current.price = btn.dataset.price;
        el('inp-price').value = current.price;
        qp.querySelectorAll('.qp-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onPriceChange();
      });
    });
  }

  const pi = el('inp-price');
  if (pi) { pi.value = current.price || ''; pi.focus(); }
  onPriceChange();
}

function onPriceChange() {
  current.price = el('inp-price')?.value || '';
  const total = (parseFloat(current.area) || 0) * (parseFloat(current.price) || 0);
  const lt = el('live-total');
  if (lt) {
    if (total > 0) {
      lt.classList.remove('hidden');
      el('lt-amount').textContent = '$' + fmtMoney(total);
      el('lt-breakdown').textContent = `${fmtNum(current.area)} ${UNIT_SHORT[current.unit]} × $${current.price}/${UNIT_SHORT[current.unit]}`;
    } else {
      lt.classList.add('hidden');
    }
  }
  el('quick-prices')?.querySelectorAll('.qp-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.price === current.price)
  );
  updateContinueBtn();
}

// ═══════════════════════════════════════
//  STEP 4: REVIEW
// ═══════════════════════════════════════
function renderReview() {
  const all = [...items];
  const gt = all.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);

  el('review-total').textContent = '$' + fmtMoney(gt);
  el('review-count').textContent = all.length + ' service' + (all.length !== 1 ? 's' : '');

  address = el('inp-address')?.value || '';
  clientName = el('inp-client')?.value || '';

  const card = el('review-card');
  if (!card) return;

  let html = '';
  html += rcRow('Client', clientName || '(tap to add)', 0);
  html += rcRow('Address', address || '(tap to add)', 0);

  all.forEach((item, idx) => {
    const svc = JOB_TYPES.find(j => j.id === item.service);
    const sub = (parseFloat(item.area) || 0) * (parseFloat(item.price) || 0);
    html += `<div class="rc-item" style="cursor:pointer" data-item-idx="${idx}">
      <div class="rc-item-header">
        <div class="rc-item-name"><span>${svc?.icon || '📋'}</span> ${svc?.label || item.service}</div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="rc-item-sub">$${fmtMoney(sub)}</span>
          <span class="rc-edit" data-edit-idx="${idx}" style="cursor:pointer;font-size:14px">✏️</span>
          ${all.length > 1 ? `<span data-remove-idx="${idx}" style="cursor:pointer;font-size:14px;color:#DC2626">✕</span>` : ''}
        </div>
      </div>
      <div class="rc-item-detail">${fmtNum(item.area)} ${UNIT_LABELS[item.unit]} × $${item.price}/${UNIT_SHORT[item.unit]}</div>
    </div>`;
  });

  card.innerHTML = html;

  // Wire client/address row clicks
  card.querySelectorAll('.rc-row').forEach(row =>
    row.addEventListener('click', () => goStep(parseInt(row.dataset.step)))
  );

  // Wire edit buttons on service items
  card.querySelectorAll('[data-edit-idx]').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      editItem(parseInt(btn.dataset.editIdx));
    })
  );

  // Wire remove buttons on service items
  card.querySelectorAll('[data-remove-idx]').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeItem(parseInt(btn.dataset.removeIdx));
    })
  );

  // Wire whole row tap as edit shortcut
  card.querySelectorAll('[data-item-idx]').forEach(row =>
    row.addEventListener('click', () => editItem(parseInt(row.dataset.itemIdx)))
  );
}

function rcRow(label, value, stepIdx) {
  return `<div class="rc-row" data-step="${stepIdx}">
    <span class="rc-label">${label}</span>
    <div><span class="rc-value">${esc(value)}</span><span class="rc-edit">✏️</span></div>
  </div>`;
}

function editItem(idx) {
  if (idx < 0 || idx >= items.length) return;
  // Pull item out of items array and into current for editing
  current = { ...items[idx] };
  items.splice(idx, 1);
  // Go to service step — user can change service, area, or price
  goStep(1);
}

function removeItem(idx) {
  if (idx < 0 || idx >= items.length) return;
  if (items.length <= 1) { toast('Need at least one service'); return; }
  items.splice(idx, 1);
  renderReview();
  toast('Service removed');
}

function cancelQuote() {
  if (items.length > 0 || parseFloat(current.area) > 0) {
    if (!confirm('Cancel this quote? All progress will be lost.')) return;
  }
  resetQuote();
}

// ═══════════════════════════════════════
//  GEOCODING
// ═══════════════════════════════════════
async function fetchAddrSuggestions(q) {
  if (!mapboxToken) return;
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&limit=5&country=US`;
    const data = await fetch(url).then(r => r.json());
    const list = el('addr-autocomplete');
    if (!list) return;
    list.innerHTML = '';
    (data.features || []).forEach(f => {
      const item = document.createElement('div');
      item.className = 'ac-item';
      item.textContent = f.place_name;
      item.addEventListener('click', () => {
        el('inp-address').value = f.place_name;
        lastLat = f.center[1]; lastLng = f.center[0];
        clearAddrAC();
        updateContinueBtn();
      });
      list.appendChild(item);
    });
  } catch {}
}

function clearAddrAC() { const l = el('addr-autocomplete'); if (l) l.innerHTML = ''; }

function geolocateUser() {
  if (!navigator.geolocation) { toast('GPS not available'); return; }
  toast('Getting location...');
  navigator.geolocation.getCurrentPosition(async pos => {
    lastLat = pos.coords.latitude; lastLng = pos.coords.longitude;
    if (mapboxToken) {
      try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lastLng},${lastLat}.json?access_token=${mapboxToken}&limit=1`;
        const data = await fetch(url).then(r => r.json());
        if (data.features?.length) {
          el('inp-address').value = data.features[0].place_name;
          updateContinueBtn();
          toast('Location set 📍');
        }
      } catch { toast('Could not resolve address'); }
    } else {
      el('inp-address').value = `${lastLat.toFixed(5)}, ${lastLng.toFixed(5)}`;
      updateContinueBtn(); toast('Location set 📍');
    }
  }, () => toast('Location denied'));
}

function openExternal(type) {
  const addr = el('inp-address')?.value || '';
  const q = addr || (lastLat && lastLng ? `${lastLat},${lastLng}` : '');
  if (!q) { toast('Enter an address first'); return; }
  const urls = {
    maps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
    earth: `https://earth.google.com/web/search/${encodeURIComponent(q)}`,
    street: lastLat && lastLng
      ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lastLat},${lastLng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
  };
  window.open(urls[type], '_blank');
}

// ═══════════════════════════════════════
//  SAVE & SHARE — FIX: loading state, no silent bounce, stringify geojson
// ═══════════════════════════════════════
async function saveAndShare() {
  address = el('inp-address')?.value || '';
  clientName = el('inp-client')?.value || '';

  // FIX: Don't bounce to step 0 — prompt inline
  if (!clientName) {
    const name = prompt('Enter a client name to save:');
    if (!name || !name.trim()) { toast('Client name required to save'); return; }
    clientName = name.trim();
    el('inp-client').value = clientName;
  }

  const all = [...items];
  if (all.length === 0) { toast('No services to save'); return; }

  const gt = all.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  const primary = all[0] || {};
  const narrative = el('narrative-box')?.textContent || '';

  // FIX: Loading state on button
  const btn = el('btn-save-share');
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving...'; }

  const payload = {
    client_name: clientName,
    project_type: primary.service || 'custom',
    area: parseFloat(primary.area) || 0,
    unit: primary.unit || 'sqft',
    price_per_unit: parseFloat(primary.price) || 0,
    total: gt,
    qty: 1,
    notes: el('inp-notes')?.value || '',
    address: address,
    lat: lastLat, lng: lastLng,
    // Backend stringifies polygon_geojson and line_items — send as raw objects
    polygon_geojson: drawnPolygonGeoJSON || null,
    ai_narrative: (narrative && !narrative.includes('Writing')) ? narrative : '',
    line_items: all.map(i => ({
      type: i.service,
      area: parseFloat(i.area) || 0,
      unit: i.unit,
      price: parseFloat(i.price) || 0,
      qty: 1,
      label: JOB_TYPES.find(j => j.id === i.service)?.label || i.service,
      subtotal: (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0)
    })),
    markup: 0
  };

  try {
    let res;
    if (editingQuoteId) {
      res = await authFetch(`/api/quotes/${editingQuoteId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await authFetch('/api/quotes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error('Save error:', res.status, errData);
      throw new Error('Save failed');
    }
    editingQuoteId = null;
    toast('Saved! 💾');
    setTimeout(() => openSheet(), 400);
  } catch (err) {
    console.error('Save error:', err);
    toast('Save failed — check connection');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText || 'Save & Share'; }
  }
}

// ═══════════════════════════════════════
//  LOAD / EDIT / DELETE
// ═══════════════════════════════════════
async function loadSaved() {
  const search = el('search-quotes')?.value || '';
  const c = el('saved-list');
  if (!c) return;
  c.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const res = await authFetch(`/api/quotes?search=${encodeURIComponent(search)}&limit=30`);
    const data = await res.json();
    renderSavedList(data.quotes || []);
  } catch {
    c.innerHTML = '<div class="empty-state">Failed to load.</div>';
  }
}

function renderSavedList(quotes) {
  const c = el('saved-list');
  if (!quotes.length) { c.innerHTML = '<div class="empty-state">No quotes yet.</div>'; return; }
  window._sq = {};
  quotes.forEach(q => { window._sq[q.id] = q; });

  c.innerHTML = quotes.map(q => {
    let itemsText = '';
    try {
      const li = JSON.parse(q.line_items || '[]');
      itemsText = li.map(i => (i.label || i.type || '').replace(/-/g, ' ')).join(' + ');
    } catch {}
    if (!itemsText) itemsText = (q.project_type || '').replace(/-/g, ' ');

    return `<div class="quote-card">
      <div class="qc-header">
        <div><div class="qc-client">${esc(q.client_name)}</div>
        <div class="qc-meta">${itemsText}</div>
        <div class="qc-meta">${new Date(q.created_at).toLocaleDateString()}</div></div>
        <div class="qc-total">$${fmtMoney(q.total)}</div>
      </div>
      ${q.address ? `<div class="qc-meta">📍 ${esc(q.address.split(',').slice(0, 2).join(','))}</div>` : ''}
      <div class="qc-actions">
        <button class="mini-btn edit" data-id="${q.id}">✏️ Edit</button>
        <button class="mini-btn load" data-id="${q.id}">Load</button>
        <button class="mini-btn share" data-id="${q.id}">Share</button>
        <button class="mini-btn del" data-id="${q.id}">Delete</button>
      </div>
    </div>`;
  }).join('');

  c.querySelectorAll('.mini-btn.edit').forEach(b => b.addEventListener('click', () => editQuote(b.dataset.id)));
  c.querySelectorAll('.mini-btn.load').forEach(b => b.addEventListener('click', () => loadQuote(b.dataset.id)));
  c.querySelectorAll('.mini-btn.share').forEach(b => b.addEventListener('click', () => {
    const q = window._sq[b.dataset.id];
    if (q) openSheet();
  }));
  c.querySelectorAll('.mini-btn.del').forEach(b => b.addEventListener('click', () => deleteQuote(b.dataset.id)));
}

async function loadQuote(id) {
  try {
    const q = await authFetch(`/api/quotes/${id}`).then(r => r.json());
    if (q.error) throw new Error();

    el('inp-client').value = q.client_name || '';
    el('inp-address').value = q.address || '';
    el('inp-notes').value = q.notes || '';
    address = q.address || ''; clientName = q.client_name || '';
    lastLat = q.lat; lastLng = q.lng;

    items = [];
    let lineItems = [];
    try { lineItems = JSON.parse(q.line_items || '[]'); } catch {}

    if (lineItems.length > 0) {
      lineItems.forEach(li => {
        items.push({
          service: li.type, area: String(li.area || 0),
          unit: li.unit || 'sqft', price: String(li.price || 0)
        });
      });
    } else {
      items.push({
        service: q.project_type || 'custom', area: String(q.area || 0),
        unit: q.unit || 'sqft', price: String(q.price_per_unit || 0)
      });
    }

    current = { service: null, area: '', unit: 'sqft', price: '' };

    if (q.ai_narrative) {
      el('narrative-box').textContent = q.ai_narrative;
      el('narrative-box').classList.remove('hidden');
    }
    if (q.polygon_geojson) {
      try { drawnPolygonGeoJSON = typeof q.polygon_geojson === 'string' ? JSON.parse(q.polygon_geojson) : q.polygon_geojson; } catch {}
    }

    switchView('quote');
    goStep(4);
    toast('Quote loaded ✓');
  } catch { toast('Could not load quote'); }
}

async function editQuote(id) {
  await loadQuote(id);
  editingQuoteId = id;
  toast('Editing — make changes and Save');
}

async function deleteQuote(id) {
  if (!confirm('Delete this quote?')) return;
  try {
    await authFetch(`/api/quotes/${id}`, { method: 'DELETE' });
    toast('Deleted'); loadSaved();
  } catch { toast('Delete failed'); }
}

async function exportAll() {
  try {
    const data = await authFetch('/api/quotes?limit=500').then(r => r.json());
    const text = (data.quotes || []).map(q => buildShareTextFromQuote(q)).join('\n\n══════════════\n\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'quotes-' + Date.now() + '.txt'; a.click();
    toast('Exported!');
  } catch { toast('Export failed'); }
}

// ═══════════════════════════════════════
//  AI FEATURES
// ═══════════════════════════════════════
async function aiSuggestPrice() {
  const area = parseFloat(current.area);
  if (!area) { toast('Enter an area first'); return; }
  const btn = el('btn-ai-price');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Getting prices...'; }
  try {
    const res = await authFetch('/api/ai/suggest-price', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_type: current.service || 'custom',
        area: area.toFixed(1),
        unit: UNIT_LABELS[current.unit] || 'sq ft',
        location: el('inp-address')?.value || 'DFW Texas'
      })
    });
    if (!res.ok) throw new Error();
    aiPriceData = await res.json();
    showAiPriceModal(aiPriceData);
  } catch { toast('AI pricing unavailable'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '✨ AI Suggest Price'; } }
}

function showAiPriceModal(d) {
  const f2 = v => '$' + parseFloat(v || 0).toFixed(2);
  el('ai-price-content').innerHTML = `
    <div class="price-tier low"><div><div class="tier-label">🟢 Low</div><div class="tier-sub">Competitive</div></div>
      <div class="tier-right"><div class="tier-val">${f2(d.low_per_unit)}<span>/unit</span></div><div class="tier-total">≈ ${f2(d.low_total)}</div></div></div>
    <div class="price-tier mid"><div><div class="tier-label">⭐ Recommended</div><div class="tier-sub">Market rate</div></div>
      <div class="tier-right"><div class="tier-val">${f2(d.recommended_per_unit)}<span>/unit</span></div><div class="tier-total">≈ ${f2(d.mid_total)}</div></div></div>
    <div class="price-tier high"><div><div class="tier-label">🔴 Premium</div><div class="tier-sub">High-end</div></div>
      <div class="tier-right"><div class="tier-val">${f2(d.high_per_unit)}<span>/unit</span></div><div class="tier-total">≈ ${f2(d.high_total)}</div></div></div>
    ${d.reasoning ? `<div class="ai-reasoning">💡 ${d.reasoning}</div>` : ''}`;
  openModal('ai-price-modal');
}

function applyAiPrice() {
  if (!aiPriceData) return;
  current.price = String(parseFloat(aiPriceData.recommended_per_unit));
  el('inp-price').value = current.price;
  onPriceChange();
  closeModal('ai-price-modal');
  toast('Price applied ✨');
}

async function generateNarrative() {
  clientName = el('inp-client')?.value || '';
  if (!clientName) { toast('Enter a client name first'); return; }
  const box = el('narrative-box');
  box.classList.remove('hidden'); box.textContent = '✍️ Writing...';
  const all = [...items];
  const gt = all.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  const p = all[0] || {};
  const summary = all.map(i => {
    const l = JOB_TYPES.find(j => j.id === i.service)?.label || i.service;
    return `${l}: ${fmtNum(i.area)} ${UNIT_LABELS[i.unit]} × $${parseFloat(i.price).toFixed(2)}`;
  }).join('\n');
  try {
    const res = await authFetch('/api/ai/generate-narrative', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        project_type: all.map(i => JOB_TYPES.find(j => j.id === i.service)?.label || i.service).join(' + '),
        area: p.area || '0', unit: UNIT_LABELS[p.unit] || 'sq ft',
        price_per_unit: p.price || '0', total: fmtMoney(gt),
        notes: (el('inp-notes')?.value || '') + '\n\nLine items:\n' + summary,
        address: el('inp-address')?.value || '', qty: 1
      })
    });
    const data = await res.json();
    box.textContent = data.narrative || 'No narrative returned.';
    toast('Narrative ready ✍️');
  } catch { box.textContent = 'Could not generate.'; }
}

// AI Chat
function openChat() {
  el('ai-panel').classList.add('open'); el('ai-overlay').classList.add('open');
  if (!chatHistory.length) addChatMsg('ai', 'Hi! Ask me anything about pricing, measurements, or job scoping 💡');
  setTimeout(() => el('chat-input')?.focus(), 300);
}
function closeChat() { el('ai-panel').classList.remove('open'); el('ai-overlay').classList.remove('open'); }

async function sendChat() {
  const input = el('chat-input'), msg = input?.value.trim();
  if (!msg) return;
  input.value = '';
  addChatMsg('user', msg);
  chatHistory.push({ role: 'user', content: msg });
  const tid = addChatMsg('ai', '...', true);
  try {
    const res = await authFetch('/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: chatHistory.slice(-10),
        context: { project_type: current.service, area: current.area, unit: UNIT_LABELS[current.unit], price: current.price, address: el('inp-address')?.value || '' }
      })
    });
    const data = await res.json();
    removeMsg(tid);
    const reply = data.reply || 'Something went wrong.';
    addChatMsg('ai', reply);
    chatHistory.push({ role: 'assistant', content: reply });
  } catch { removeMsg(tid); addChatMsg('ai', 'Connection error.'); }
}

function addChatMsg(role, text, typing = false) {
  const c = el('chat-messages'); if (!c) return '';
  const id = 'msg-' + Date.now();
  const div = document.createElement('div');
  div.id = id; div.className = `chat-msg ${role}${typing ? ' typing' : ''}`;
  div.textContent = text; c.appendChild(div); c.scrollTop = c.scrollHeight;
  return id;
}
function removeMsg(id) { document.getElementById(id)?.remove(); }

// ═══════════════════════════════════════
//  PDF
// ═══════════════════════════════════════
function generatePDF() {
  const all = [...items];
  const gt = all.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  clientName = el('inp-client')?.value || 'Client';
  address = el('inp-address')?.value || '';
  const notes = el('inp-notes')?.value || '';
  const narrative = el('narrative-box')?.textContent || '';
  const today = new Date().toLocaleDateString();

  const rows = all.map(i => {
    const l = JOB_TYPES.find(j => j.id === i.service)?.label || i.service;
    const sub = (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0);
    return `<tr><td style="padding:10px 8px;border-bottom:1px solid #E4E2DA;font-weight:600">${l}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E4E2DA;text-align:right">${fmtNum(i.area)} ${UNIT_LABELS[i.unit]}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E4E2DA;text-align:right">$${parseFloat(i.price).toFixed(2)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E4E2DA;text-align:right;font-weight:700">$${fmtMoney(sub)}</td></tr>`;
  }).join('');

  const win = window.open('', '_blank');
  if (!win) { toast('Allow popups to print'); return; }
  win.document.write(`<!DOCTYPE html><html><head><title>Quote — ${clientName}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700;800&family=Nunito:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{font-family:'Nunito',sans-serif;padding:40px;color:#2A2824;max-width:700px;margin:0 auto;background:#F2F0EB}
table{width:100%;border-collapse:collapse;margin:16px 0}
th{text-align:left;padding:8px;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#4E4C46;font-weight:500;border-bottom:2px solid #2A2824;font-family:'DM Mono',monospace}
th:nth-child(n+2){text-align:right}
.total-box{background:#2A2824;color:white;padding:16px 20px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin:20px 0}
.total-val{font-family:'Playfair Display',serif;font-size:42px;font-weight:800;color:#E0EDDA}
.narr{background:#E4E2DA;border-radius:8px;padding:16px;font-size:13px;line-height:1.8;margin:16px 0;white-space:pre-wrap}
.lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#4E4C46;font-weight:500;margin-bottom:3px;font-family:'DM Mono',monospace}
@media print{.noprint{display:none!important}body{background:white}}</style></head><body>
<h1 style="font-family:'Playfair Display',serif;font-size:36px;font-weight:700;color:#2A2824;margin:0">QUOTE<span style="color:#3A5E30">machine</span></h1>
<div style="color:#4E4C46;font-size:13px;margin-bottom:24px;font-family:'DM Mono',monospace">Estimate · ${today}</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
  <div><div class="lbl">Client</div><div style="font-size:15px;font-weight:600">${clientName}</div></div>
  ${address ? `<div><div class="lbl">Location</div><div style="font-size:13px">${address}</div></div>` : ''}
</div>
<table><thead><tr><th>Service</th><th>Area</th><th>Rate</th><th>Subtotal</th></tr></thead><tbody>${rows}</tbody></table>
<div class="total-box"><div class="lbl" style="color:rgba(255,255,255,.5)">Estimated Total</div><div class="total-val">$${fmtMoney(gt)}</div></div>
${notes ? `<div class="lbl" style="margin-bottom:6px">Notes</div><div style="font-size:13px;line-height:1.6;margin-bottom:16px">${notes}</div>` : ''}
${narrative && !narrative.includes('Writing') ? `<div class="lbl" style="margin-bottom:6px">Scope of Work</div><div class="narr">${narrative}</div>` : ''}
<div style="font-size:11px;color:#A8A49A;margin-top:28px;text-align:center">Estimate only. Final pricing subject to on-site inspection.</div>
<br><button class="noprint" onclick="window.print()" style="padding:12px 28px;background:#3A5E30;color:white;border:none;border-radius:6px;font-size:15px;cursor:pointer;font-family:'DM Mono',monospace">🖨️ Print / Save as PDF</button></body></html>`);
  win.document.close();
}

// ═══════════════════════════════════════
//  SHARE
// ═══════════════════════════════════════
function openSheet() { el('share-sheet')?.classList.add('open'); }
function closeSheet() { el('share-sheet')?.classList.remove('open'); }

function buildShareText() {
  const all = [...items];
  const gt = all.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  clientName = el('inp-client')?.value || 'Client';
  address = el('inp-address')?.value || '';
  const it = all.map(i => {
    const l = JOB_TYPES.find(j => j.id === i.service)?.label || i.service;
    return `  • ${l}: ${fmtNum(i.area)} ${UNIT_LABELS[i.unit]} × $${parseFloat(i.price).toFixed(2)} = $${fmtMoney((parseFloat(i.area) || 0) * (parseFloat(i.price) || 0))}`;
  }).join('\n');
  return `📋 QUOTE machine\nClient: ${clientName}\n${address ? 'Location: ' + address + '\n' : ''}Items:\n${it}\n──────────\nTOTAL: $${fmtMoney(gt)}\nDate: ${new Date().toLocaleDateString()}`;
}

function buildShareTextFromQuote(q) {
  let it = '';
  try {
    const li = JSON.parse(q.line_items || '[]');
    it = li.map(i => `  • ${i.label || i.type}: ${fmtNum(i.area)} ${UNIT_LABELS[i.unit] || i.unit} × $${parseFloat(i.price).toFixed(2)} = $${fmtMoney(i.subtotal || (i.area * i.price))}`).join('\n');
  } catch {}
  return `📋 QUOTE machine\nClient: ${q.client_name}\n${q.address ? 'Location: ' + q.address + '\n' : ''}Items:\n${it}\n──────────\nTOTAL: $${fmtMoney(q.total)}\nDate: ${new Date(q.created_at).toLocaleDateString()}`;
}

function copyShare() { navigator.clipboard.writeText(buildShareText()).then(() => toast('Copied! 📋')).catch(() => toast('Copy failed')); }
function smsShare() { window.open('sms:?body=' + encodeURIComponent(buildShareText())); }
function emailShare() { window.open(`mailto:?subject=${encodeURIComponent('Quote Estimate')}&body=${encodeURIComponent(buildShareText())}`); }

// ═══════════════════════════════════════
//  STATS
// ═══════════════════════════════════════
async function loadStats() {
  const c = el('stats-content');
  try {
    const s = await authFetch('/api/stats').then(r => r.json());
    const mu = v => '$' + parseFloat(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const rows = (s.by_type || []).map(t =>
      `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--surface2)">
        <div style="font-size:13px;font-weight:600;text-transform:capitalize">${(t.project_type || '').replace(/-/g, ' ')}</div>
        <div style="text-align:right"><div style="font-family:'Playfair Display',serif;font-size:18px;font-weight:700;color:var(--accent)">${mu(t.revenue)}</div>
        <div style="font-size:10px;color:var(--text-lt)">${t.count} quote${t.count != 1 ? 's' : ''}</div></div></div>`
    ).join('');
    c.innerHTML = `<div class="stat-grid">
      <div class="stat-card"><div class="stat-val">${s.total_quotes}</div><div class="stat-lbl">Quotes</div></div>
      <div class="stat-card"><div class="stat-val">${mu(s.total_value)}</div><div class="stat-lbl">Total Value</div></div>
      <div class="stat-card"><div class="stat-val">${mu(s.avg_quote)}</div><div class="stat-lbl">Avg Quote</div></div>
      <div class="stat-card"><div class="stat-val">${s.this_month}</div><div class="stat-lbl">This Month</div></div></div>
      ${rows ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-lt);margin:12px 0 6px">By Job Type</div><div>${rows}</div>` : ''}`;
  } catch { c.innerHTML = '<div class="empty-state">Failed to load stats.</div>'; }
}

// ═══════════════════════════════════════
//  RESET
// ═══════════════════════════════════════
function resetQuote() {
  step = 0; items = [];
  current = { service: null, area: '', unit: 'sqft', price: '' };
  editingQuoteId = null;
  drawnAreaSqMeters = 0; drawnPolygonGeoJSON = null; drawPoints = [];
  el('inp-address').value = ''; el('inp-client').value = '';
  el('inp-notes').value = ''; el('inp-area').value = ''; el('inp-price').value = '';
  el('narrative-box').classList.add('hidden'); el('narrative-box').textContent = '';
  el('map-result').classList.add('hidden'); el('btn-open-map').classList.remove('hidden');
  document.querySelectorAll('.svc-row').forEach(r => r.classList.remove('selected'));
  goStep(0);
  toast('New quote started');
}

// ═══════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════
function el(id) { return document.getElementById(id); }
function on(id, fn) { el(id)?.addEventListener('click', fn); }
function openModal(id) { el(id)?.classList.add('open'); }
function closeModal(id) { el(id)?.classList.remove('open'); }
function toast(msg) {
  const t = el('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
function fmtNum(n) { return parseFloat(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
function fmtMoney(n) { return parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ═══════════════════════════════════════
//  PWA
// ═══════════════════════════════════════
function setupInstallBanner() {
  let dp = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); dp = e;
    if (sessionStorage.getItem('qmach_install_dismissed')) return;
    el('install-banner').style.display = 'flex';
  });
  on('install-btn', async () => {
    if (!dp) return; dp.prompt(); await dp.userChoice;
    dp = null; el('install-banner').style.display = 'none';
  });
  on('install-dismiss', () => {
    el('install-banner').style.display = 'none';
    sessionStorage.setItem('qmach_install_dismissed', '1');
  });
  window.addEventListener('appinstalled', () => { el('install-banner').style.display = 'none'; dp = null; });
}
