// ═══════════════════════════════════════
//  GEOMETRY MATH (no external library)
//  Replaces turf.js which fails CSP eval check
// ═══════════════════════════════════════

// Haversine distance between two [lng, lat] points in meters
function haversineMeters(a, b) {
  const R = 6371008.8; // Earth radius in meters
  const lat1 = a[1] * Math.PI / 180;
  const lat2 = b[1] * Math.PI / 180;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLng = (b[0] - a[0]) * Math.PI / 180;
  const x = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// Polygon area in square meters using spherical excess (shoelace on projected coords)
function polygonAreaMeters(ring) {
  // Convert lng/lat to approximate meters using equirectangular projection
  const R = 6371008.8;
  const toRad = d => d * Math.PI / 180;
  const pts = ring.map(p => [
    R * toRad(p[0]) * Math.cos(toRad(p[1])),
    R * toRad(p[1])
  ]);
  // Shoelace formula
  let area = 0;
  for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) {
    area += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  }
  return Math.abs(area / 2);
}

// LineString total length in meters
function lineStringMeters(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineMeters(coords[i-1], coords[i]);
  return total;
}

// ═══════════════════════════════════════
//  STATE
// ═══════════════════════════════════════
let map = null;
let draw = null;
let mapboxToken = '';
let drawnFeature = null;
let drawnRawMeters = 0;
let drawnPerimeterMeters = 0;
let drawnRawType = 'area';   // 'area' | 'line'
let isDrawing = false;
let drawMode = 'polygon';    // 'polygon' | 'line'
let trackedPoints = [];      // [lng, lat] pairs we track ourselves
let lastAddress = '';
let lastLat = null;
let lastLng = null;
let chatHistory = [];
let aiPriceData = null;
let isDragging = false;
let mapStyleHasLabels = true;
let debounceTimer = null;
let authToken = sessionStorage.getItem('qmach_token') || '';

// ── Line items state
let lineItems = [];
let lineItemIdCounter = 0;
let editingQuoteId = null;  // null = new quote, string = editing existing
const JOB_TYPES = [
  { value: 'pressure-washing', label: 'Pressure Washing' },
  { value: 'parking-lot-striping', label: 'Parking Lot Striping' },
  { value: 'sealcoating', label: 'Sealcoating' },
  { value: 'painting', label: 'Painting / Coating' },
  { value: 'roofing', label: 'Roofing' },
  { value: 'concrete', label: 'Concrete' },
  { value: 'landscaping', label: 'Landscaping' },
  { value: 'custom', label: 'Other / Custom' }
];

// ═══════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════
async function authFetch(url, options = {}) {
  if (!options.headers) options.headers = {};
  if (authToken) options.headers['x-auth-token'] = authToken;
  const resp = await fetch(url, options);
  if (resp.status === 401) {
    // Session expired — show login
    sessionStorage.removeItem('qmach_token');
    authToken = '';
    showLoginGate();
    throw new Error('Unauthorized');
  }
  return resp;
}

function showLoginGate() {
  const gate = document.getElementById('login-gate');
  if (gate) gate.classList.remove('hidden');
}

function hideLoginGate() {
  const gate = document.getElementById('login-gate');
  if (gate) gate.classList.add('hidden');
}

async function checkAuth() {
  try {
    const resp = await fetch('/api/auth/check', {
      headers: authToken ? { 'x-auth-token': authToken } : {}
    });
    const data = await resp.json();
    if (data.valid) {
      hideLoginGate();
      return true;
    }
  } catch {}
  showLoginGate();
  return false;
}

async function doLogin() {
  const btn = document.getElementById('login-btn');
  const pw = document.getElementById('login-password');
  const err = document.getElementById('login-error');
  if (!pw.value.trim()) { err.textContent = 'Enter a password'; return; }
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  err.textContent = '';
  try {
    const resp = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw.value.trim() })
    });
    const data = await resp.json();
    if (data.success) {
      authToken = data.token;
      sessionStorage.setItem('qmach_token', authToken);
      hideLoginGate();
      bootApp();
    } else {
      err.textContent = 'Wrong password';
      pw.value = '';
      pw.focus();
    }
  } catch {
    err.textContent = 'Connection error';
  }
  btn.disabled = false;
  btn.textContent = 'Sign In';
}

// ═══════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // Wire login form
  document.getElementById('login-btn')?.addEventListener('click', doLogin);
  document.getElementById('login-password')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });

  // Check if already authed
  const authed = await checkAuth();
  if (authed) bootApp();
});

async function bootApp() {
  updateCalc();
  initPanelDrag();
  initModalBackdrops();
  loadSavedCount();

  // Address input
  const addr = document.getElementById('addr-input');
  if (addr) {
    addr.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const q = addr.value.trim();
      if (q.length < 3) { clearAutocomplete(); return; }
      debounceTimer = setTimeout(() => fetchSuggestions(q), 300);
    });
    addr.addEventListener('keydown', e => { if (e.key === 'Enter') geocodeAddress(); });
  }

  // Tabs
  on('tab-btn-quote', () => showTab('quote'));
  on('tab-btn-saved', () => showTab('saved'));
  on('tab-btn-stats', () => showTab('stats'));

  // Map toolbar
  on('tool-draw',      () => startDrawing('polygon'));
  on('tool-line',      () => startDrawing('line'));
  on('tool-clear',     () => clearDrawing());
  on('tool-satellite', () => toggleLabels());
  on('tool-streetview', () => openStreetView());
  on('search-btn',     () => geocodeAddress());
  on('badge-clear-btn',() => clearDrawing());

  // Drawing overlay
  on('btn-done-drawing',   () => finishDrawing());
  on('btn-cancel-drawing', () => cancelDrawing());

  // Quote form — auto-recalc
  ['measure-type','markup'].forEach(id => on(id, () => updateCalc(), 'change'));
  on('manual-area', () => { drawnRawMeters = 0; drawnPerimeterMeters = 0; updateCalc(); }, 'input');

  // Line items
  on('btn-add-item', () => addLineItem());
  addLineItem(); // start with one

  // Address — use map address button
  on('btn-use-map-addr', () => {
    const addrInput = document.getElementById('quote-address');
    if (addrInput && lastAddress) { addrInput.value = lastAddress; showToast('Address set 📍'); }
    else if (!lastAddress) showToast('Search an address on the map first');
  });

  // Quote actions
  on('btn-save',            () => saveQuote());
  on('btn-narrative',       () => generateNarrative());
  on('btn-narrative-regen', () => generateNarrative());
  on('btn-print',           () => printQuote());
  on('btn-share',           () => openShareModal(null));
  on('btn-new',             () => newQuote());
  on('ai-suggest-btn',      () => aiSuggestPrice());
  on('btn-saved-header',    () => showTab('saved'));
  on('btn-pdf',             () => generatePDF(true));
  on('btn-pdf-plain',       () => generatePDF(false));

  // AI chat
  on('ai-chat-btn',   () => openAiPanel());
  on('ai-panel-close',() => closeAiPanel());
  on('ai-overlay',    () => closeAiPanel());
  on('chat-send-btn', () => sendChat());
  const chatIn = document.getElementById('chat-input');
  if (chatIn) chatIn.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  // Share modal
  on('share-cancel', () => closeModal('share-modal'));
  on('share-copy',   () => copyShare());
  on('share-sms',    () => smsShare());
  on('share-email',  () => emailShare());

  // AI price modal
  on('ai-price-dismiss', () => closeModal('ai-price-modal'));
  on('ai-price-apply',   () => applyAiPrice());

  // Saved tab
  on('search-input', () => loadSaved(), 'input');
  on('export-btn',   () => exportAll());

  // Load map
  try {
    const cfg = await authFetch('/api/config').then(r => r.json());
    mapboxToken = cfg.mapboxToken || '';
    if (!mapboxToken) return;
    initMap();
    setTimeout(() => { if (map && map.resize) map.resize(); }, 100);
    geolocateUser();
  } catch(err) {
    console.error('Boot:', err);
  }
}

function on(id, fn, evt = 'click') {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, fn);
}

// ═══════════════════════════════════════
//  LINE ITEMS
// ═══════════════════════════════════════
function addLineItem(data) {
  lineItemIdCounter++;
  const id = lineItemIdCounter;
  const item = {
    id,
    type: data?.type || 'pressure-washing',
    area: data?.area || 0,
    unit: data?.unit || 'sqft',
    price: data?.price || 0,
    qty: data?.qty || 1
  };
  lineItems.push(item);
  renderLineItems();
  updateCalc();
}

function removeLineItem(id) {
  lineItems = lineItems.filter(i => i.id !== id);
  renderLineItems();
  updateCalc();
}

function getLineItemFromDOM(id) {
  const el = document.getElementById(`li-${id}`);
  if (!el) return null;
  return {
    type: el.querySelector('.li-type')?.value || 'custom',
    area: parseFloat(el.querySelector('.li-area')?.value) || 0,
    unit: el.querySelector('.li-unit')?.value || 'sqft',
    price: parseFloat(el.querySelector('.li-price')?.value) || 0,
    qty: parseInt(el.querySelector('.li-qty')?.value) || 1
  };
}

function syncLineItemsFromDOM() {
  lineItems.forEach(item => {
    const vals = getLineItemFromDOM(item.id);
    if (vals) Object.assign(item, vals);
  });
}

function renderLineItems() {
  const container = document.getElementById('line-items-container');
  if (!container) return;
  const onlyOne = lineItems.length === 1;

  container.innerHTML = lineItems.map((item, idx) => {
    const typeOptions = JOB_TYPES.map(t =>
      `<option value="${t.value}" ${t.value === item.type ? 'selected' : ''}>${t.label}</option>`
    ).join('');
    const unitOptions = [
      ['sqft','Sq Ft'],['linft','Lin Ft'],['sqyd','Sq Yd'],['acre','Acres']
    ].map(([v,l]) => `<option value="${v}" ${v === item.unit ? 'selected' : ''}>${l}</option>`).join('');
    const qtyOptions = [1,2,3,4,5].map(q =>
      `<option value="${q}" ${q === item.qty ? 'selected' : ''}>${q}×</option>`
    ).join('');
    const sub = item.area * item.price * item.qty;

    return `
    <div class="line-item ${onlyOne ? 'only-item' : ''}" id="li-${item.id}">
      <div class="li-header">
        <div class="li-num">${idx + 1}</div>
        <select class="li-type" onchange="onLineItemChange()">${typeOptions}</select>
        <button class="li-remove" onclick="removeLineItem(${item.id})" title="Remove">✕</button>
      </div>
      <div class="li-fields">
        <div class="li-field">
          <label>Area <button class="li-use-map" onclick="useMapForItem(${item.id})">📐 Map</button></label>
          <input type="number" class="li-area" value="${item.area || ''}" placeholder="0" min="0" step="1" oninput="onLineItemChange()">
        </div>
        <div class="li-field">
          <label>Unit</label>
          <select class="li-unit" onchange="onLineItemChange()">${unitOptions}</select>
        </div>
        <div class="li-field">
          <label>$/unit</label>
          <input type="number" class="li-price" value="${item.price || ''}" placeholder="0.00" min="0" step="0.01" oninput="onLineItemChange()">
        </div>
      </div>
      <div class="li-fields" style="grid-template-columns: 1fr 2fr; margin-top:4px">
        <div class="li-field">
          <label>Qty</label>
          <select class="li-qty" onchange="onLineItemChange()">${qtyOptions}</select>
        </div>
        <div class="li-subtotal">
          <span class="li-subtotal-label">Subtotal</span>
          <span class="li-subtotal-val">$${fmtMoney(sub)}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function useMapForItem(id) {
  const measurement = getDisplayMeasurement();
  const item = lineItems.find(i => i.id === id);
  if (!item) return;
  item.area = measurement;
  item.unit = document.getElementById('measure-type')?.value || 'sqft';
  renderLineItems();
  updateCalc();
}

function onLineItemChange() {
  syncLineItemsFromDOM();
  // Update subtotals in-place (faster than full re-render)
  lineItems.forEach(item => {
    const el = document.getElementById(`li-${item.id}`);
    if (!el) return;
    const sub = item.area * item.price * item.qty;
    const subEl = el.querySelector('.li-subtotal-val');
    if (subEl) subEl.textContent = '$' + fmtMoney(sub);
  });
  updateCalc();
}

function getLineItemsSubtotal() {
  return lineItems.reduce((sum, item) => sum + (item.area * item.price * item.qty), 0);
}

// ═══════════════════════════════════════
//  MAP
// ═══════════════════════════════════════
function initMap() {
  mapboxgl.accessToken = mapboxToken;

  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    center: [-96.7970, 32.7767],
    zoom: 17,
    attributionControl: true,
    logoPosition: 'bottom-left'
  });

  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: false
  }), 'bottom-right');

  // MapboxDraw — only used for DISPLAYING the shape, not for input
  draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {},
    styles: [
      { id: 'fill', type: 'fill',
        filter: ['all', ['==', '$type', 'Polygon']],
        paint: { 'fill-color': '#E8A020', 'fill-opacity': 0.2 } },
      { id: 'stroke', type: 'line',
        filter: ['all', ['==', '$type', 'Polygon']],
        paint: { 'line-color': '#E8A020', 'line-width': 3 } },
      { id: 'line', type: 'line',
        filter: ['all', ['==', '$type', 'LineString']],
        paint: { 'line-color': '#E8A020', 'line-width': 4, 'line-dasharray': [2,1] } },
      { id: 'vertex', type: 'circle',
        filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']],
        paint: { 'circle-radius': 6, 'circle-color': '#E8A020', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } }
    ]
  });
  map.addControl(draw);

  map.on('load', () => {
    // Add our own live-preview layer for in-progress drawing
    map.addSource('draw-preview', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'draw-preview-fill',
      type: 'fill',
      source: 'draw-preview',
      filter: ['==', '$type', 'Polygon'],
      paint: { 'fill-color': '#E8A020', 'fill-opacity': 0.18 }
    });
    map.addLayer({
      id: 'draw-preview-line',
      type: 'line',
      source: 'draw-preview',
      paint: { 'line-color': '#E8A020', 'line-width': 2.5, 'line-dasharray': [3,2] }
    });
    map.addLayer({
      id: 'draw-preview-points',
      type: 'circle',
      source: 'draw-preview',
      filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': 6, 'circle-color': '#E8A020', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 }
    });

    // ── Direct canvas listener bypasses MapboxDraw event interception
    // map.on('click') does NOT fire when MapboxDraw is attached.
    // We use pointerup on the raw canvas + map.unproject() instead.
    const canvas = map.getCanvas();

    canvas.addEventListener('pointerup', e => {
      if (!isDrawing) return;
      // Only handle left-click / single touch (button 0)
      if (e.button !== undefined && e.button !== 0) return;
      // Ignore if the tap was on a UI element (button, select, input)
      if (e.target && e.target !== canvas) return;

      // Get pixel position relative to canvas
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Convert pixel to lng/lat
      const lngLat = map.unproject([x, y]);
      const pt = [lngLat.lng, lngLat.lat];

      trackedPoints.push(pt);
      console.log('Point added via canvas:', pt, '— total:', trackedPoints.length);
      updatePointCounter();
      updateDrawPreview();
    });

    activateTool('tool-draw');
  });
}

// ─── Draw start / finish / cancel
function startDrawing(mode) {
  if (!map || !map.loaded()) { showToast('Map is loading...'); return; }
  drawMode = mode;
  isDrawing = true;
  trackedPoints = [];
  draw.deleteAll();
  clearPreview();

  // Update toolbar & counter
  activateTool(mode === 'polygon' ? 'tool-draw' : 'tool-line');
  updatePointCounter();

  // Show drawing overlay
  const inst = document.getElementById('drawing-instructions');
  if (inst) {
    inst.innerHTML = mode === 'polygon'
      ? '<strong>Tap the corners</strong> of the work area, then tap Done'
      : '<strong>Tap points</strong> along the line to measure, then tap Done';
  }
  setEl('drawing-overlay', 'display', 'block');
  setEl('measure-badge', 'display', 'none');
  // Update done button text
  const doneBtn = document.getElementById('btn-done-drawing');
  if (doneBtn) doneBtn.textContent = mode === 'polygon' ? '✓ Done — Calculate Area' : '✓ Done — Calculate Length';

  // Change cursor
  map.getCanvas().style.cursor = 'crosshair';
}

function finishDrawing() {
  if (!isDrawing) return;

  const ptCount = trackedPoints.length;
  console.log('finishDrawing: points =', ptCount, trackedPoints);

  if (ptCount < 2) {
    showToast('Tap at least 2 points on the map first');
    return;
  }

  isDrawing = false;
  map.getCanvas().style.cursor = '';
  setEl('drawing-overlay', 'display', 'none');
  clearPreview();

  let feature;

  // Always try polygon if 3+ points, otherwise line
  const usePolygon = drawMode === 'polygon' && ptCount >= 3;

  if (usePolygon) {
    const ring = [...trackedPoints, trackedPoints[0]];
    feature = {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {}
    };
    try {
      const ring = feature.geometry.coordinates[0];
      const sq = polygonAreaMeters(ring);
      const perim = lineStringMeters(ring);
      console.log('Area result:', sq, 'sq meters, perimeter:', perim, 'meters');
      if (!sq || sq <= 0) throw new Error('Zero area');
      drawnRawMeters = sq;
      drawnPerimeterMeters = perim;
      drawnRawType = 'area';
    } catch(e) {
      console.error('Area calculation error:', e);
      showToast('Area calculation failed — try drawing again');
      return;
    }
  } else {
    feature = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: trackedPoints },
      properties: {}
    };
    try {
      const len = lineStringMeters(feature.geometry.coordinates);
      console.log('Length result:', len, 'meters');
      if (!len || len <= 0) throw new Error('Zero length');
      drawnRawMeters = len;
      drawnRawType = 'line';
    } catch(e) {
      console.error('Length calculation error:', e);
      showToast('Length calculation failed — try drawing again');
      return;
    }
  }

  drawnFeature = feature;

  // Display on map
  draw.deleteAll();
  draw.add(feature);

  // Update form
  document.getElementById('manual-area').value = '';
  updateMeasureOptions();
  updateCalc();
  updateBadge();

  // Update price unit label
  setText('price-unit-label', unitLabel(document.getElementById('measure-type').value));

  // Scroll panel to top
  const scroll = document.getElementById('panel-scroll');
  if (scroll) scroll.scrollTop = 0;

  showToast('Area measured! Set your price below ↓');
}

function cancelDrawing() {
  isDrawing = false;
  trackedPoints = [];
  map.getCanvas().style.cursor = '';
  setEl('drawing-overlay', 'display', 'none');
  clearPreview();
  activateTool('tool-draw');
}

function clearDrawing() {
  if (isDrawing) cancelDrawing();
  drawnFeature = null;
  drawnRawMeters = 0;
  drawnPerimeterMeters = 0;
  drawnRawType = 'area';
  trackedPoints = [];
  if (draw) draw.deleteAll();
  clearPreview();
  setEl('measure-badge', 'display', 'none');
  document.getElementById('manual-area').value = '';
  updateMeasureOptions();
  updateCalc();
}

// ─── Live preview while drawing
function updateDrawPreview() {
  if (!map || !map.getSource('draw-preview')) return;
  const pts = trackedPoints;
  const features = [];

  // Points
  pts.forEach(pt => {
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: pt }, properties: {} });
  });

  // Line connecting points
  if (pts.length >= 2) {
    const coords = drawMode === 'polygon' && pts.length >= 3
      ? [...pts, pts[0]]  // close it visually
      : pts;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {}
    });
  }

  // Fill preview for polygon
  if (drawMode === 'polygon' && pts.length >= 3) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[...pts, pts[0]]] },
      properties: {}
    });
  }

  map.getSource('draw-preview').setData({ type: 'FeatureCollection', features });
}

function clearPreview() {
  if (map && map.getSource('draw-preview')) {
    map.getSource('draw-preview').setData({ type: 'FeatureCollection', features: [] });
  }
}

// ─── Toolbar highlight
function activateTool(id) {
  document.querySelectorAll('.map-tool-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

// ─── Point counter during drawing
function updatePointCounter() {
  const el = document.getElementById('point-counter');
  if (!el) return;
  const n = trackedPoints.length;
  if (n === 0) {
    el.textContent = 'Tap on the map to add points';
  } else if (n === 1) {
    el.textContent = '1 point — tap more corners';
  } else if (n === 2) {
    el.textContent = '2 points — tap more or tap Done for a line';
  } else {
    el.textContent = `${n} points — tap Done to finish`;
  }
}

// ─── Toggle satellite labels
// ─── Street View / 360°
function openStreetView() {
  let lat, lng;
  if (map) {
    const center = map.getCenter();
    lat = center.lat;
    lng = center.lng;
  }
  if (lastLat && lastLng) {
    lat = lastLat;
    lng = lastLng;
  }
  if (!lat || !lng) {
    showToast('Search an address first');
    return;
  }
  // Open Google Street View in new tab
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}&heading=0&pitch=0&fov=90`;
  window.open(url, '_blank');
}

function toggleLabels() {
  if (!map) return;
  mapStyleHasLabels = !mapStyleHasLabels;
  const style = mapStyleHasLabels
    ? 'mapbox://styles/mapbox/satellite-streets-v12'
    : 'mapbox://styles/mapbox/satellite-v9';
  const saved = draw ? draw.getAll() : null;
  map.setStyle(style);
  map.once('style.load', () => {
    // Re-add preview source/layers after style reload
    map.addSource('draw-preview', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'draw-preview-fill', type: 'fill', source: 'draw-preview', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#E8A020', 'fill-opacity': 0.18 } });
    map.addLayer({ id: 'draw-preview-line', type: 'line', source: 'draw-preview', paint: { 'line-color': '#E8A020', 'line-width': 2.5, 'line-dasharray': [3,2] } });
    map.addLayer({ id: 'draw-preview-points', type: 'circle', source: 'draw-preview', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 6, 'circle-color': '#E8A020', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    if (draw) {
      try { map.removeControl(draw); } catch(e) {}
      map.addControl(draw);
      if (saved?.features.length) draw.add(saved);
    }
    showToast(mapStyleHasLabels ? 'Labels on' : 'Labels off');
  });
}

// ═══════════════════════════════════════
//  GEOCODING
// ═══════════════════════════════════════
async function fetchSuggestions(q) {
  if (!mapboxToken) return;
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&limit=5&country=US`;
    const data = await fetch(url).then(r => r.json());
    const list = document.getElementById('autocomplete-list');
    list.innerHTML = '';
    (data.features || []).forEach(f => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.textContent = f.place_name;
      item.addEventListener('click', () => {
        document.getElementById('addr-input').value = f.place_name;
        clearAutocomplete();
        flyTo(f.center[0], f.center[1], f.place_name);
      });
      list.appendChild(item);
    });
  } catch(e) {}
}

async function geocodeAddress() {
  const q = document.getElementById('addr-input').value.trim();
  if (!q || !mapboxToken) return;
  clearAutocomplete();
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&limit=1`;
    const data = await fetch(url).then(r => r.json());
    if (data.features?.length) { const f = data.features[0]; flyTo(f.center[0], f.center[1], f.place_name); }
    else showToast('Address not found');
  } catch { showToast('Search error'); }
}

function clearAutocomplete() {
  const el = document.getElementById('autocomplete-list');
  if (el) el.innerHTML = '';
}

function flyTo(lng, lat, name) {
  lastLat = lat; lastLng = lng; lastAddress = name;
  setText('address-display', name.split(',').slice(0,2).join(','));
  const addrInput = document.getElementById('quote-address');
  if (addrInput && !addrInput.value) addrInput.value = name;
  if (map) map.flyTo({ center: [lng, lat], zoom: 19, speed: 1.5 });
}

function geolocateUser() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    if (map) map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 18 });
  }, () => {});
}

// ═══════════════════════════════════════
//  MEASUREMENT & CALC
// ═══════════════════════════════════════
function updateMeasureOptions() {
  const sel = document.getElementById('measure-type');
  const label = document.querySelector('.mrow-label');
  if (!sel) return;

  if (drawnRawType === 'line') {
    // Line: only linear units make sense
    sel.innerHTML = '<option value="linft">Lin Ft</option><option value="sqyd">Yards</option>';
    sel.value = 'linft';
    if (label) label.textContent = 'Measured Length';
  } else {
    // Polygon or default: all units
    sel.innerHTML = '<option value="sqft">Sq Ft</option><option value="linft">Lin Ft</option><option value="sqyd">Sq Yd</option><option value="acre">Acres</option>';
    if (label) label.textContent = 'Measured Area';
  }
}

function getDisplayMeasurement() {
  const manual = parseFloat(document.getElementById('manual-area')?.value);
  if (!isNaN(manual) && manual > 0) return manual;
  if (!drawnRawMeters) return 0;
  const type = document.getElementById('measure-type')?.value || 'sqft';

  if (drawnRawType === 'line') {
    // drawnRawMeters = length in meters
    switch (type) {
      case 'linft': return drawnRawMeters * 3.28084;
      case 'sqft':  return drawnRawMeters * 3.28084;   // line has no area — show length in ft
      case 'sqyd':  return drawnRawMeters * 1.09361;   // meters → yards
      case 'acre':  return drawnRawMeters * 3.28084;   // no area — show length in ft
      default:      return drawnRawMeters * 3.28084;
    }
  }

  // drawnRawType === 'area' → drawnRawMeters = area in sq meters
  switch (type) {
    case 'sqft':  return drawnRawMeters * 10.7639;
    case 'linft': return drawnPerimeterMeters * 3.28084;  // perimeter in feet
    case 'sqyd':  return drawnRawMeters * 1.19599;
    case 'acre':  return drawnRawMeters / 4046.86;
    default:      return drawnRawMeters * 10.7639;
  }
}

function unitLabel(type) {
  if (drawnRawType === 'line') {
    return { linft: 'lin ft', sqyd: 'yd' }[type] || 'lin ft';
  }
  return { sqft: 'sq ft', linft: 'lin ft', sqyd: 'sq yd', acre: 'acres' }[type] || 'sq ft';
}

function getPrice() {
  // Legacy — returns price of first line item for backward compat
  if (lineItems.length > 0) return lineItems[0].price || 0;
  return 0;
}

function updateCalc() {
  const area = getDisplayMeasurement();
  const type = document.getElementById('measure-type')?.value || 'sqft';

  setText('area-display', fmt(area));
  setText('unit-display', unitLabel(type));

  // Calculate grand total from line items
  syncLineItemsFromDOM();
  const subtotal = getLineItemsSubtotal();
  const markup = parseFloat(document.getElementById('markup')?.value) || 0;
  const total = subtotal * (1 + markup / 100);

  // Build breakdown
  const itemCount = lineItems.filter(i => i.area > 0 && i.price > 0).length;
  const breakdownText = itemCount > 0
    ? `${itemCount} item${itemCount > 1 ? 's' : ''}` + (markup > 0 ? ` + ${markup}% markup` : '')
    : '—';

  setText('total-display', '$' + fmtMoney(total));
  setText('breakdown-display', breakdownText);

  if (drawnFeature || (parseFloat(document.getElementById('manual-area')?.value) > 0)) updateBadge();
}

function updateBadge() {
  const val = getDisplayMeasurement();
  const type = document.getElementById('measure-type')?.value || 'sqft';
  setText('badge-val', fmt(val));
  setText('badge-unit', unitLabel(type));
  setEl('measure-badge', 'display', 'flex');
}

// ═══════════════════════════════════════
//  AI FEATURES
// ═══════════════════════════════════════
async function aiSuggestPrice() {
  const btn = document.getElementById('ai-suggest-btn');
  syncLineItemsFromDOM();
  const firstItem = lineItems[0];
  const area = firstItem?.area || getDisplayMeasurement();
  if (!area) { showToast('Enter an area on the first line item'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Getting prices...'; }
  try {
    const res = await authFetch('/api/ai/suggest-price', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_type: firstItem?.type || 'pressure-washing',
        area: area.toFixed(1),
        unit: unitLabel(firstItem?.unit || 'sqft'),
        location: lastAddress || 'DFW Texas'
      })
    });
    if (!res.ok) throw new Error();
    aiPriceData = await res.json();
    showAiPriceModal(aiPriceData);
  } catch { showToast('AI pricing unavailable'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '✨ AI Suggest Price'; } }
}

function showAiPriceModal(d) {
  const f2 = v => '$' + parseFloat(v||0).toFixed(2);
  document.getElementById('ai-price-content').innerHTML = `
    <div class="price-tier low">
      <div><div class="tier-label">🟢 Low / Budget</div><div class="tier-sub">Competitive rate</div></div>
      <div class="tier-right"><div class="tier-val">${f2(d.low_per_unit)}<span>/unit</span></div><div class="tier-total">Total ≈ ${f2(d.low_total)}</div></div>
    </div>
    <div class="price-tier mid">
      <div><div class="tier-label">⭐ Recommended</div><div class="tier-sub">Market rate</div></div>
      <div class="tier-right"><div class="tier-val">${f2(d.recommended_per_unit)}<span>/unit</span></div><div class="tier-total">Total ≈ ${f2(d.mid_total)}</div></div>
    </div>
    <div class="price-tier high">
      <div><div class="tier-label">🔴 Premium</div><div class="tier-sub">High-end market</div></div>
      <div class="tier-right"><div class="tier-val">${f2(d.high_per_unit)}<span>/unit</span></div><div class="tier-total">Total ≈ ${f2(d.high_total)}</div></div>
    </div>
    ${d.reasoning ? `<div class="ai-reasoning">💡 ${d.reasoning}</div>` : ''}`;
  openModal('ai-price-modal');
}

function applyAiPrice() {
  if (!aiPriceData || lineItems.length === 0) return;
  const rec = parseFloat(aiPriceData.recommended_per_unit);
  lineItems[0].price = rec;
  renderLineItems();
  updateCalc();
  closeModal('ai-price-modal');
  showToast('AI price applied ✨');
}

async function generateNarrative() {
  const client = document.getElementById('client-name')?.value.trim();
  if (!client) { showToast('Enter a client name first'); return; }
  const section = document.getElementById('narrative-section');
  const box = document.getElementById('narrative-text');
  section.style.display = 'block';
  box.textContent = '✍️ Writing...';
  syncLineItemsFromDOM();
  const markup = parseFloat(document.getElementById('markup')?.value) || 0;
  const subtotal = getLineItemsSubtotal();
  const total = subtotal * (1 + markup / 100);
  const itemsSummary = lineItems.map(i => {
    const typeName = JOB_TYPES.find(t => t.value === i.type)?.label || i.type;
    return `${typeName}: ${fmt(i.area)} ${unitLabel(i.unit)} × $${i.price.toFixed(2)} × ${i.qty} = $${fmtMoney(i.area * i.price * i.qty)}`;
  }).join('\n');
  try {
    const res = await authFetch('/api/ai/generate-narrative', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: client,
        project_type: lineItems.map(i => JOB_TYPES.find(t => t.value === i.type)?.label || i.type).join(' + '),
        area: lineItems[0]?.area?.toFixed(1) || '0',
        unit: unitLabel(lineItems[0]?.unit || 'sqft'),
        price_per_unit: lineItems[0]?.price?.toFixed(2) || '0',
        total: fmtMoney(total),
        notes: document.getElementById('notes')?.value + '\n\nLine items:\n' + itemsSummary,
        address: lastAddress, qty: 1
      })
    });
    const data = await res.json();
    box.textContent = data.narrative || 'No narrative returned.';
    showToast('Narrative ready ✍️');
  } catch { box.textContent = 'Could not generate — check connection.'; }
}

// AI Chat
function openAiPanel() {
  document.getElementById('ai-panel').classList.add('open');
  document.getElementById('ai-overlay').classList.add('open');
  if (!chatHistory.length) addChatMsg('ai', "Hi! Ask me anything about pricing, measurements, or job scoping 💡");
  setTimeout(() => document.getElementById('chat-input')?.focus(), 300);
}
function closeAiPanel() {
  document.getElementById('ai-panel').classList.remove('open');
  document.getElementById('ai-overlay').classList.remove('open');
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input?.value.trim();
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
        context: {
          project_type: document.getElementById('project-type')?.value,
          area: getDisplayMeasurement().toFixed(1),
          unit: unitLabel(document.getElementById('measure-type')?.value),
          price: getPrice().toFixed(2), address: lastAddress
        }
      })
    });
    const data = await res.json();
    removeMsg(tid);
    const reply = data.reply || 'Something went wrong.';
    addChatMsg('ai', reply);
    chatHistory.push({ role: 'assistant', content: reply });
  } catch { removeMsg(tid); addChatMsg('ai', 'Connection error.'); }
}

function addChatMsg(role, text, isTyping = false) {
  const c = document.getElementById('chat-messages');
  if (!c) return '';
  const id = 'msg-' + Date.now();
  const div = document.createElement('div');
  div.id = id;
  div.className = `chat-msg ${role}${isTyping ? ' typing' : ''}`;
  div.textContent = text;
  c.appendChild(div);
  c.scrollTop = c.scrollHeight;
  return id;
}
function removeMsg(id) { document.getElementById(id)?.remove(); }

// ═══════════════════════════════════════
//  SAVE / LOAD
// ═══════════════════════════════════════
async function saveQuote() {
  const client = document.getElementById('client-name')?.value.trim();
  if (!client) { showToast('Enter a client name first'); return; }
  syncLineItemsFromDOM();
  const markup = parseFloat(document.getElementById('markup')?.value) || 0;
  const subtotal = getLineItemsSubtotal();
  const total = subtotal * (1 + markup / 100);
  const unit = document.getElementById('measure-type')?.value || 'sqft';
  const narrative = document.getElementById('narrative-text')?.textContent || '';
  const primaryType = lineItems[0]?.type || 'custom';
  const primaryArea = lineItems[0]?.area || 0;
  const primaryPrice = lineItems[0]?.price || 0;
  const address = document.getElementById('quote-address')?.value || lastAddress || '';
  const payload = {
    client_name: client,
    project_type: primaryType,
    area: primaryArea, unit, price_per_unit: primaryPrice, total, qty: 1,
    notes: document.getElementById('notes')?.value || '',
    address, lat: lastLat, lng: lastLng,
    polygon_geojson: drawnFeature ? drawnFeature.geometry : null,
    ai_narrative: (narrative && !narrative.includes('Writing')) ? narrative : '',
    line_items: lineItems.map(i => ({
      type: i.type, area: i.area, unit: i.unit, price: i.price, qty: i.qty,
      label: JOB_TYPES.find(t => t.value === i.type)?.label || i.type,
      subtotal: i.area * i.price * i.qty
    })),
    markup
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
    if (!res.ok) throw new Error();
    showToast(editingQuoteId ? 'Quote updated! ✓' : 'Quote saved! 💾');
    // Reset editing state
    editingQuoteId = null;
    const saveBtn = document.getElementById('btn-save');
    if (saveBtn) { saveBtn.textContent = '💾 Save'; saveBtn.classList.remove('editing'); }
    loadSavedCount();
  } catch { showToast('Save failed — check connection'); }
}

async function loadSavedCount() {
  try {
    const data = await authFetch('/api/stats').then(r => r.json());
    const n = data.total_quotes || 0;
    setText('saved-count', n);
    setText('saved-count-tab', n);
  } catch {}
}

async function loadSaved() {
  const search = document.getElementById('search-input')?.value || '';
  const container = document.getElementById('saved-list');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const res = await authFetch(`/api/quotes?search=${encodeURIComponent(search)}&limit=30`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderSavedList(data.quotes || []);
  } catch (err) {
    console.error('loadSaved error:', err);
    container.innerHTML = `<div class="empty-state">Failed to load quotes.<br><button onclick="loadSaved()" style="margin-top:8px;padding:6px 14px;border-radius:6px;border:1px solid #ccc;cursor:pointer">Retry</button></div>`;
  }
}

function renderSavedList(quotes) {
  const container = document.getElementById('saved-list');
  if (!quotes.length) { container.innerHTML = '<div class="empty-state">No quotes yet.</div>'; return; }
  window._savedQuotes = {};
  quotes.forEach(q => { window._savedQuotes[q.id] = q; });
  container.innerHTML = quotes.map(q => {
    let itemsSummary = '';
    try {
      const items = JSON.parse(q.line_items || '[]');
      if (items.length > 1) {
        itemsSummary = items.map(i => (i.label || i.type).replace(/-/g,' ')).join(' + ');
      } else if (items.length === 1) {
        itemsSummary = `${(items[0].label || items[0].type).replace(/-/g,' ')} · ${fmt(items[0].area)} ${unitLabel(items[0].unit)}`;
      }
    } catch {}
    if (!itemsSummary) {
      itemsSummary = `${(q.project_type||'').replace(/-/g,' ')} · ${fmt(q.area)} ${unitLabel(q.unit)}`;
    }
    return `
    <div class="quote-card">
      <div class="qc-header">
        <div>
          <div class="qc-client">${esc(q.client_name)}</div>
          <div class="qc-meta">${itemsSummary}</div>
          <div class="qc-meta">${new Date(q.created_at).toLocaleDateString()}</div>
        </div>
        <div class="qc-total">$${fmtMoney(q.total)}</div>
      </div>
      ${q.address ? `<div class="qc-meta">📍 ${esc(q.address.split(',').slice(0,2).join(','))}</div>` : ''}
      <div class="qc-actions">
        <button class="mini-btn edit" data-id="${q.id}">✏️ Edit</button>
        <button class="mini-btn load" data-id="${q.id}">Load</button>
        <button class="mini-btn share" data-id="${q.id}">Share</button>
        <button class="mini-btn del" data-id="${q.id}">Delete</button>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.mini-btn.edit').forEach(b => b.addEventListener('click', () => editQuote(b.dataset.id)));
  container.querySelectorAll('.mini-btn.load').forEach(b => b.addEventListener('click', () => loadQuote(b.dataset.id)));
  container.querySelectorAll('.mini-btn.share').forEach(b => b.addEventListener('click', () => openShareModal(window._savedQuotes[b.dataset.id])));
  container.querySelectorAll('.mini-btn.del').forEach(b => b.addEventListener('click', () => deleteQuote(b.dataset.id)));
}

async function loadQuote(id) {
  try {
    const q = await authFetch(`/api/quotes/${id}`).then(r => r.json());
    if (q.error) throw new Error();
    document.getElementById('client-name').value = q.client_name || '';
    document.getElementById('notes').value = q.notes || '';
    document.getElementById('markup').value = q.markup || 0;

    // Restore line items
    lineItems = [];
    lineItemIdCounter = 0;
    let items = [];
    try { items = JSON.parse(q.line_items || '[]'); } catch {}
    if (items.length > 0) {
      items.forEach(i => addLineItem(i));
    } else {
      // Legacy single-item quote
      addLineItem({
        type: q.project_type || 'pressure-washing',
        area: parseFloat(q.area) || 0,
        unit: q.unit || 'sqft',
        price: parseFloat(q.price_per_unit) || 0,
        qty: parseInt(q.qty) || 1
      });
    }

    document.getElementById('manual-area').value = q.area || '';
    drawnRawMeters = 0;
    drawnPerimeterMeters = 0;
    if (q.ai_narrative) {
      document.getElementById('narrative-text').textContent = q.ai_narrative;
      document.getElementById('narrative-section').style.display = 'block';
    }
    if (q.polygon_geojson && draw && map?.loaded()) {
      const geo = typeof q.polygon_geojson === 'string' ? JSON.parse(q.polygon_geojson) : q.polygon_geojson;
      const feature = { type: 'Feature', geometry: geo, properties: {} };
      drawnFeature = feature;
      drawnRawType = geo.type === 'LineString' ? 'line' : 'area';
      draw.deleteAll();
      draw.add(feature);
      if (q.lat && q.lng) map.flyTo({ center: [q.lng, q.lat], zoom: 18 });
    }
    if (q.address) {
      lastAddress = q.address; lastLat = q.lat; lastLng = q.lng;
      setText('address-display', q.address.split(',').slice(0,2).join(','));
      const addrInput = document.getElementById('quote-address');
      if (addrInput) addrInput.value = q.address;
    }
    updateMeasureOptions();
    const selU = document.getElementById('measure-type');
    const savedU = q.unit || 'sqft';
    if (selU && [...selU.options].some(o => o.value === savedU)) selU.value = savedU;
    updateCalc();
    showTab('quote');
    showToast('Quote loaded ✓');
  } catch { showToast('Could not load quote'); }
}

async function editQuote(id) {
  await loadQuote(id);
  editingQuoteId = id;
  const saveBtn = document.getElementById('btn-save');
  if (saveBtn) { saveBtn.textContent = '💾 Update'; saveBtn.classList.add('editing'); }
  showToast('Editing — make changes and hit Update');
}

async function deleteQuote(id) {
  if (!confirm('Delete this quote?')) return;
  try {
    await authFetch(`/api/quotes/${id}`, { method: 'DELETE' });
    showToast('Deleted');
    loadSaved(); loadSavedCount();
  } catch { showToast('Delete failed'); }
}

async function exportAll() {
  try {
    const data = await authFetch('/api/quotes?limit=500').then(r => r.json());
    const text = (data.quotes||[]).map(q => buildShareText(q)).join('\n\n══════════════\n\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'quotes-' + Date.now() + '.txt';
    a.click();
    showToast('Exported!');
  } catch { showToast('Export failed'); }
}

// ═══════════════════════════════════════
//  PRINT / SHARE
// ═══════════════════════════════════════
function printQuote() { generatePDF(true); }

function generatePDF(branded) {
  syncLineItemsFromDOM();
  const client = document.getElementById('client-name')?.value || 'Client';
  const markup = parseFloat(document.getElementById('markup')?.value) || 0;
  const subtotal = getLineItemsSubtotal();
  const total = subtotal * (1 + markup / 100);
  const notes = document.getElementById('notes')?.value || '';
  const narrative = document.getElementById('narrative-text')?.textContent || '';
  const today = new Date().toLocaleDateString();
  const address = document.getElementById('quote-address')?.value || lastAddress || '';

  // Build line items table rows
  const itemRows = lineItems.map((item, idx) => {
    const label = JOB_TYPES.find(t => t.value === item.type)?.label || item.type;
    const sub = item.area * item.price * item.qty;
    return `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;font-weight:600">${label}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;text-align:right">${fmt(item.area)} ${unitLabel(item.unit)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;text-align:right">$${item.price.toFixed(2)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;text-align:center">${item.qty}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;text-align:right;font-weight:700">$${fmtMoney(sub)}</td>
    </tr>`;
  }).join('');

  const header = branded
    ? `<h1 style="font-family:'Bebas Neue',sans-serif;font-size:42px;letter-spacing:4px;color:#1C3A5E;margin:0">QUOTE<span style="color:#E8A020">machine</span></h1>`
    : `<h1 style="font-size:28px;font-weight:700;color:#1C3A5E;margin:0">Estimate</h1>`;

  const win = window.open('', '_blank');
  if (!win) { showToast('Allow popups to print'); return; }
  win.document.write(`<!DOCTYPE html><html><head><title>Quote — ${client}</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{font-family:'DM Sans',sans-serif;padding:40px;color:#0D2137;max-width:700px;margin:0 auto}
.sub{color:#6B8FAD;font-size:13px;margin-bottom:24px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}
.lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;margin-bottom:3px}
.val{font-size:15px;font-weight:600;text-transform:capitalize}
table{width:100%;border-collapse:collapse;margin:16px 0}
th{text-align:left;padding:8px;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;border-bottom:2px solid #1C3A5E}
th:nth-child(n+2){text-align:right}th:nth-child(4){text-align:center}
.totals-section{margin:20px 0}
.total-row{display:flex;justify-content:space-between;padding:6px 0;font-size:14px}
.total-row.grand{background:#0D2137;color:white;padding:16px 20px;border-radius:10px;margin-top:8px}
.total-row.grand .t-val{font-family:'Bebas Neue',sans-serif;font-size:42px;color:#E8A020}
.narrative{background:#F4F7FA;border-radius:8px;padding:16px;font-size:13px;line-height:1.8;margin:16px 0;color:#2B4B6F;white-space:pre-wrap}
.footer{font-size:11px;color:#9ab;margin-top:28px;text-align:center}
@media print{.no-print{display:none!important}}</style></head><body>
${header}
<div class="sub">Estimate · ${today}</div>
<div class="info-grid">
  <div><div class="lbl">Client</div><div class="val">${client}</div></div>
  ${address?`<div><div class="lbl">Location</div><div class="val" style="text-transform:none;font-size:13px">${address}</div></div>`:'<div></div>'}
</div>
<table>
  <thead><tr><th>Service</th><th>Area</th><th>Rate</th><th>Qty</th><th>Subtotal</th></tr></thead>
  <tbody>${itemRows}</tbody>
</table>
<div class="totals-section">
  <div class="total-row"><span>Subtotal</span><span>$${fmtMoney(subtotal)}</span></div>
  ${markup > 0 ? `<div class="total-row"><span>Markup (${markup}%)</span><span>$${fmtMoney(subtotal * markup / 100)}</span></div>` : ''}
  <div class="total-row grand"><div><div class="lbl" style="color:rgba(255,255,255,.6)">Estimated Total</div></div><div class="t-val">$${fmtMoney(total)}</div></div>
</div>
${notes?`<div class="lbl" style="margin-bottom:6px">Notes</div><div style="font-size:13px;line-height:1.6;margin-bottom:16px">${notes}</div>`:''}
${narrative&&!narrative.includes('Writing')?`<div class="lbl" style="margin-bottom:6px">Scope of Work</div><div class="narrative">${narrative}</div>`:''}
<div class="footer">This is an estimate. Final pricing subject to on-site inspection.</div>
<br><button class="no-print" onclick="window.print()" style="padding:12px 28px;background:#0D2137;color:white;border:none;border-radius:8px;font-size:15px;cursor:pointer;margin-top:8px">🖨️ Print / Save as PDF</button>
</body></html>`);
  win.document.close();
}

function buildShareText(q) {
  if (q) {
    let itemsText = '';
    try {
      const items = JSON.parse(q.line_items || '[]');
      if (items.length > 0) {
        itemsText = items.map(i => `  • ${i.label || i.type}: ${fmt(i.area)} ${unitLabel(i.unit)} × $${parseFloat(i.price).toFixed(2)}${i.qty>1?' ×'+i.qty:''} = $${fmtMoney(i.subtotal || i.area*i.price*i.qty)}`).join('\n');
      }
    } catch {}
    if (!itemsText) {
      itemsText = `  • ${(q.project_type||'').replace(/-/g,' ')}: ${fmt(q.area)} ${unitLabel(q.unit)} × $${parseFloat(q.price_per_unit).toFixed(2)}`;
    }
    return `📋 QUOTE machine\nClient: ${q.client_name}\n${q.address?'Location: '+q.address+'\n':''}Items:\n${itemsText}\n──────────\nTOTAL: $${fmtMoney(q.total)}\n${q.notes?'Notes: '+q.notes+'\n':''}Date: ${new Date(q.created_at).toLocaleDateString()}`.replace(/\n{3,}/g,'\n\n');
  }
  // Build from current form
  syncLineItemsFromDOM();
  const client = document.getElementById('client-name')?.value || 'Client';
  const markup = parseFloat(document.getElementById('markup')?.value) || 0;
  const subtotal = getLineItemsSubtotal();
  const total = subtotal * (1 + markup / 100);
  const notes = document.getElementById('notes')?.value || '';
  const itemsText = lineItems.map(i => {
    const label = JOB_TYPES.find(t => t.value === i.type)?.label || i.type;
    return `  • ${label}: ${fmt(i.area)} ${unitLabel(i.unit)} × $${i.price.toFixed(2)}${i.qty>1?' ×'+i.qty:''} = $${fmtMoney(i.area*i.price*i.qty)}`;
  }).join('\n');
  const address = document.getElementById('quote-address')?.value || lastAddress || '';
  return `📋 QUOTE machine\nClient: ${client}\n${address?'Location: '+address+'\n':''}Items:\n${itemsText}\n${markup>0?'Markup: '+markup+'%\n':''}──────────\nTOTAL: $${fmtMoney(total)}\n${notes?'Notes: '+notes+'\n':''}Date: ${new Date().toLocaleDateString()}`.replace(/\n{3,}/g,'\n\n');
}

function openShareModal(q) {
  document.getElementById('share-text').value = buildShareText(q||null);
  openModal('share-modal');
}
function copyShare() {
  navigator.clipboard.writeText(document.getElementById('share-text').value)
    .then(() => { showToast('Copied! 📋'); closeModal('share-modal'); })
    .catch(() => showToast('Copy failed'));
}
function smsShare() { window.open('sms:?body=' + encodeURIComponent(document.getElementById('share-text').value)); }
function emailShare() {
  const b = encodeURIComponent(document.getElementById('share-text').value);
  window.open(`mailto:?subject=${encodeURIComponent('Quote Estimate')}&body=${b}`);
}

// ═══════════════════════════════════════
//  STATS
// ═══════════════════════════════════════
async function loadStats() {
  const container = document.getElementById('stats-content');
  try {
    const s = await authFetch('/api/stats').then(r => r.json());
    const mu = v => '$' + parseFloat(v||0).toLocaleString(undefined,{maximumFractionDigits:0});
    const rows = (s.by_type||[]).map(t => `
      <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #E8EEF4">
        <div style="font-size:13px;font-weight:600;text-transform:capitalize">${(t.project_type||'').replace(/-/g,' ')}</div>
        <div style="text-align:right">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:18px;color:#E8A020">${mu(t.revenue)}</div>
          <div style="font-size:10px;color:#6B8FAD">${t.count} quote${t.count!=1?'s':''}</div>
        </div>
      </div>`).join('');
    container.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${s.total_quotes}</div><div class="stat-lbl">Quotes</div></div>
        <div class="stat-card"><div class="stat-val">${mu(s.total_value)}</div><div class="stat-lbl">Total Value</div></div>
        <div class="stat-card"><div class="stat-val">${mu(s.avg_quote)}</div><div class="stat-lbl">Avg Quote</div></div>
        <div class="stat-card"><div class="stat-val">${s.this_month}</div><div class="stat-lbl">This Month</div></div>
      </div>
      ${rows?`<div class="section-title" style="margin-top:12px">By Job Type</div><div>${rows}</div>`:''}`;
  } catch { container.innerHTML = '<div class="empty-state">Failed to load stats.</div>'; }
}

// ═══════════════════════════════════════
//  UI
// ═══════════════════════════════════════
function showTab(tab) {
  ['quote','saved','stats'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const id = btn.id?.replace('tab-btn-','');
    btn.classList.toggle('active', id === tab);
  });
  const scroll = document.getElementById('panel-scroll');
  if (scroll) scroll.scrollTop = 0;
  if (tab === 'saved') loadSaved();
  if (tab === 'stats') loadStats();
}

function newQuote() {
  document.getElementById('client-name').value = '';
  document.getElementById('notes').value = '';
  document.getElementById('manual-area').value = '';
  document.getElementById('markup').value = 0;
  const addrInput = document.getElementById('quote-address');
  if (addrInput) addrInput.value = '';
  document.getElementById('narrative-section').style.display = 'none';
  // Reset editing state
  editingQuoteId = null;
  const saveBtn = document.getElementById('btn-save');
  if (saveBtn) { saveBtn.textContent = '💾 Save'; saveBtn.classList.remove('editing'); }
  // Reset line items
  lineItems = [];
  lineItemIdCounter = 0;
  addLineItem();
  clearDrawing();
  updateCalc();
  showToast('New quote started');
}

function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

function initModalBackdrops() {
  document.querySelectorAll('.modal-overlay').forEach(o => {
    o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
  });
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

function setText(id, val)        { const el = document.getElementById(id); if (el) el.textContent = val; }
function setEl(id, prop, val)    { const el = document.getElementById(id); if (el) el.style[prop] = val; }
function fmt(n)      { return parseFloat(n||0).toLocaleString(undefined,{maximumFractionDigits:1}); }
function fmtMoney(n) { return parseFloat(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function esc(s)      { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ═══════════════════════════════════════
//  PANEL DRAG
// ═══════════════════════════════════════
function initPanelDrag() {
  const handle = document.getElementById('panel-drag');
  const panel  = document.getElementById('bottom-panel');
  const chevron = document.getElementById('drag-chevron');
  if (!handle || !panel) return;

  // Snap heights (calculated on use to handle rotation)
  const getSnaps = () => {
    const vh = window.innerHeight;
    return {
      collapsed: 64,
      half: Math.round(vh * 0.52),
      full: vh - 48  // minus header
    };
  };

  let startY = 0, startH = 0, startTime = 0, lastY = 0;
  let currentSnap = 'half';

  const updateChevron = () => {
    if (!chevron) return;
    if (currentSnap === 'collapsed') chevron.textContent = '▲';
    else if (currentSnap === 'full') chevron.textContent = '▼';
    else chevron.textContent = '▲ ▼';
  };
  updateChevron();

  const snapTo = (snapName, animate) => {
    const snaps = getSnaps();
    const h = snaps[snapName] || snaps.half;
    currentSnap = snapName;
    panel.classList.remove('dragging', 'snap-collapsed', 'snap-full');
    if (animate !== false) {
      // Use CSS transition
      panel.style.height = h + 'px';
      panel.style.maxHeight = h + 'px';
    }
    if (snapName === 'collapsed') panel.classList.add('snap-collapsed');
    if (snapName === 'full') panel.classList.add('snap-full');
    updateChevron();
    // Resize map to fill available space
    if (map) { map.resize(); setTimeout(() => map.resize(), 350); }
  };

  const onStart = y => {
    isDragging = true;
    startY = y;
    lastY = y;
    startH = panel.offsetHeight;
    startTime = Date.now();
    panel.classList.add('dragging');
    panel.classList.remove('snap-collapsed', 'snap-full');
  };

  const onMove = y => {
    if (!isDragging) return;
    lastY = y;
    const snaps = getSnaps();
    const newH = Math.max(snaps.collapsed, Math.min(snaps.full, startH + (startY - y)));
    panel.style.height = newH + 'px';
    panel.style.maxHeight = newH + 'px';
    if (map) map.resize();
  };

  const onEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    panel.classList.remove('dragging');
    const snaps = getSnaps();
    const h = panel.offsetHeight;
    const dt = Date.now() - startTime;
    const dy = startY - lastY; // positive = swiped up
    const velocity = dt > 0 ? dy / dt : 0; // px/ms

    // Fast swipe detection (> 0.4 px/ms)
    if (Math.abs(velocity) > 0.4) {
      if (velocity > 0) {
        // Swiped up — go to next higher snap
        snapTo(currentSnap === 'collapsed' ? 'half' : 'full', true);
      } else {
        // Swiped down — go to next lower snap
        snapTo(currentSnap === 'full' ? 'half' : 'collapsed', true);
      }
      return;
    }

    // Slow drag — snap to nearest
    const dists = [
      { name: 'collapsed', d: Math.abs(h - snaps.collapsed) },
      { name: 'half',      d: Math.abs(h - snaps.half) },
      { name: 'full',      d: Math.abs(h - snaps.full) }
    ];
    dists.sort((a, b) => a.d - b.d);
    snapTo(dists[0].name, true);
  };

  // Touch events
  handle.addEventListener('touchstart', e => {
    e.preventDefault();
    onStart(e.touches[0].clientY);
  }, { passive: false });
  document.addEventListener('touchmove', e => {
    if (isDragging) onMove(e.touches[0].clientY);
  }, { passive: true });
  document.addEventListener('touchend', onEnd);

  // Mouse events (desktop)
  handle.addEventListener('mousedown', e => { onStart(e.clientY); e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (isDragging) onMove(e.clientY); });
  document.addEventListener('mouseup', onEnd);

  // Double-tap to toggle between collapsed and full
  let lastTap = 0;
  handle.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 350) {
      // Double tap
      snapTo(currentSnap === 'full' ? 'collapsed' : 'full', true);
    }
    lastTap = now;
  });
}

// ═══════════════════════════════════════
//  PULL TO REFRESH
// ═══════════════════════════════════════
(function initPullToRefresh() {
  const indicator = document.getElementById('ptr-indicator');
  if (!indicator) return;
  let ptrStartY = 0;
  let ptrActive = false;
  let ptrTriggered = false;
  const THRESHOLD = 80;

  document.addEventListener('touchstart', e => {
    // Only activate if at top of page and touch is on map area
    const t = e.target;
    const isMap = t.closest('#map-container') || t.closest('header');
    if (!isMap) return;
    if (window.scrollY > 0) return;
    ptrStartY = e.touches[0].clientY;
    ptrActive = true;
    ptrTriggered = false;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!ptrActive) return;
    const dy = e.touches[0].clientY - ptrStartY;
    if (dy > 20 && dy < THRESHOLD * 1.5) {
      indicator.classList.add('visible');
      indicator.querySelector('span').textContent = dy > THRESHOLD ? 'Release to refresh' : 'Pull down to refresh';
    }
    if (dy > THRESHOLD) ptrTriggered = true;
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!ptrActive) return;
    ptrActive = false;
    if (ptrTriggered) {
      indicator.querySelector('span').textContent = 'Refreshing...';
      indicator.classList.add('refreshing');
      setTimeout(() => window.location.reload(), 400);
    } else {
      indicator.classList.remove('visible');
    }
  });
})();

// ═══════════════════════════════════════
//  PWA INSTALL PROMPT
// ═══════════════════════════════════════
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  // Don't show if user dismissed before
  if (sessionStorage.getItem('qmach_install_dismissed')) return;
  const banner = document.getElementById('install-banner');
  if (banner) banner.style.display = 'block';
});

document.getElementById('install-btn')?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const result = await deferredInstallPrompt.userChoice;
  if (result.outcome === 'accepted') {
    showToast('App installed! 📲');
  }
  deferredInstallPrompt = null;
  document.getElementById('install-banner').style.display = 'none';
});

document.getElementById('install-dismiss')?.addEventListener('click', () => {
  document.getElementById('install-banner').style.display = 'none';
  sessionStorage.setItem('qmach_install_dismissed', '1');
});

// Detect if already installed
window.addEventListener('appinstalled', () => {
  document.getElementById('install-banner').style.display = 'none';
  deferredInstallPrompt = null;
});
