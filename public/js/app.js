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

// ═══════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
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
  on('search-btn',     () => geocodeAddress());
  on('badge-clear-btn',() => clearDrawing());

  // Drawing overlay
  on('btn-done-drawing',   () => finishDrawing());
  on('btn-cancel-drawing', () => cancelDrawing());

  // Quote form — auto-recalc
  ['measure-type','qty','markup','project-type','price-dollars','price-cents'].forEach(id => on(id, () => updateCalc(), 'change'));
  on('price-per-unit', () => {
    // When user types in the manual box, clear the dropdowns
    const v = parseFloat(document.getElementById('price-per-unit').value);
    if (!isNaN(v) && v >= 0) {
      const dSel = document.getElementById('price-dollars');
      const cSel = document.getElementById('price-cents');
      if (dSel) dSel.value = '';
      if (cSel) cSel.value = '';
    }
    updateCalc();
  }, 'input');
  on('manual-area',    () => { drawnRawMeters = 0; updateCalc(); }, 'input');
  // Build price dropdowns
  buildPriceDropdowns();

  // Quote actions
  on('btn-save',            () => saveQuote());
  on('btn-narrative',       () => generateNarrative());
  on('btn-narrative-regen', () => generateNarrative());
  on('btn-print',           () => printQuote());
  on('btn-share',           () => openShareModal(null));
  on('btn-new',             () => newQuote());
  on('ai-suggest-btn',      () => aiSuggestPrice());
  on('btn-saved-header',    () => showTab('saved'));

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

  // Update price unit label when unit changes
  on('measure-type', () => {
    const label = unitLabel(document.getElementById('measure-type').value);
    setText('price-unit-label', label);
  }, 'change');

  // Load map
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    mapboxToken = cfg.mapboxToken || '';
    if (!mapboxToken) return;
    initMap();
    geolocateUser();
  } catch(err) {
    console.error('Boot:', err);
  }
});

function on(id, fn, evt = 'click') {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, fn);
}

// ═══════════════════════════════════════
//  PRICE DROPDOWNS
// ═══════════════════════════════════════
function buildPriceDropdowns() {
  const dSel = document.getElementById('price-dollars');
  const cSel = document.getElementById('price-cents');
  if (!dSel || !cSel) return;
  dSel.innerHTML = '<option value="">--</option>';
  for (let d = 0; d <= 9; d++) dSel.appendChild(new Option('$' + d, d));
  cSel.innerHTML = '<option value="">--</option>';
  for (let c = 0; c <= 99; c++) {
    const o = new Option(c.toString().padStart(2,'0') + '¢', c);
    if (c === 5) o.selected = true;
    cSel.appendChild(o);
  }
  // Set initial dollars to 0
  dSel.value = '0';
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
      console.log('Area result:', sq, 'sq meters');
      if (!sq || sq <= 0) throw new Error('Zero area');
      drawnRawMeters = sq;
      drawnRawType = 'area';
      document.getElementById('measure-type').value = 'sqft';
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
      document.getElementById('measure-type').value = 'linft';
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
  drawnRawType = 'area';
  trackedPoints = [];
  if (draw) draw.deleteAll();
  clearPreview();
  setEl('measure-badge', 'display', 'none');
  document.getElementById('manual-area').value = '';
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
function getDisplayMeasurement() {
  const manual = parseFloat(document.getElementById('manual-area')?.value);
  if (!isNaN(manual) && manual > 0) return manual;
  if (!drawnRawMeters) return 0;
  const type = document.getElementById('measure-type')?.value || 'sqft';
  if (drawnRawType === 'line') return drawnRawMeters * 3.28084;
  switch (type) {
    case 'sqft':  return drawnRawMeters * 10.7639;
    case 'linft': return drawnRawMeters * 3.28084;
    case 'sqyd':  return drawnRawMeters * 1.19599;
    case 'acre':  return drawnRawMeters / 4046.86;
    default:      return drawnRawMeters * 10.7639;
  }
}

function unitLabel(type) {
  return { sqft: 'sq ft', linft: 'lin ft', sqyd: 'sq yd', acre: 'acres' }[type] || 'sq ft';
}

function getPrice() {
  // Check if user typed a manual override price
  const manual = parseFloat(document.getElementById('price-per-unit')?.value);
  let basePrice = 0;
  if (!isNaN(manual) && manual > 0) {
    basePrice = manual;
  } else {
    // Use dropdowns
    const d = parseFloat(document.getElementById('price-dollars')?.value) || 0;
    const c = parseFloat(document.getElementById('price-cents')?.value) || 0;
    basePrice = d + (c / 100);
  }
  const markup = parseFloat(document.getElementById('markup')?.value) || 0;
  return basePrice * (1 + markup / 100);
}

function updateCalc() {
  const area  = getDisplayMeasurement();
  const qty   = parseInt(document.getElementById('qty')?.value) || 1;
  const type  = document.getElementById('measure-type')?.value || 'sqft';
  const price = getPrice();
  const totalArea = area * qty;
  const total = totalArea * price;

  setText('area-display', fmt(totalArea));
  setText('unit-display', unitLabel(type) + (qty > 1 ? ' ×' + qty : ''));
  setText('total-display', '$' + fmtMoney(total));
  setText('breakdown-display', fmt(totalArea) + ' ' + unitLabel(type) + ' × $' + price.toFixed(2));
  setText('price-unit-label', unitLabel(type));

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
  const area = getDisplayMeasurement();
  if (!area) { showToast('Draw or enter an area first'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Getting prices...'; }
  try {
    const res = await fetch('/api/ai/suggest-price', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_type: document.getElementById('project-type')?.value,
        area: area.toFixed(1),
        unit: unitLabel(document.getElementById('measure-type')?.value),
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
  if (!aiPriceData) return;
  const rec = parseFloat(aiPriceData.recommended_per_unit);
  // Apply to dropdowns
  const dollars = Math.min(9, Math.floor(rec));
  const cents = Math.round((rec - Math.floor(rec)) * 100);
  const dSel = document.getElementById('price-dollars');
  const cSel = document.getElementById('price-cents');
  if (dSel) dSel.value = dollars;
  if (cSel) cSel.value = cents;
  // Clear manual override
  const manInput = document.getElementById('price-per-unit');
  if (manInput) manInput.value = '';
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
  const area = getDisplayMeasurement();
  const unit = unitLabel(document.getElementById('measure-type')?.value);
  const price = getPrice();
  const qty = parseInt(document.getElementById('qty')?.value) || 1;
  try {
    const res = await fetch('/api/ai/generate-narrative', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: client,
        project_type: document.getElementById('project-type')?.value.replace(/-/g,' '),
        area: area.toFixed(1), unit, price_per_unit: price.toFixed(2),
        total: (area * qty * price).toFixed(2),
        notes: document.getElementById('notes')?.value || '',
        address: lastAddress, qty
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
    const res = await fetch('/api/ai/chat', {
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
  const area  = getDisplayMeasurement();
  const qty   = parseInt(document.getElementById('qty')?.value) || 1;
  const price = getPrice();
  const unit  = document.getElementById('measure-type')?.value || 'sqft';
  const narrative = document.getElementById('narrative-text')?.textContent || '';
  try {
    const res = await fetch('/api/quotes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: client,
        project_type: document.getElementById('project-type')?.value,
        area, unit, price_per_unit: price, total: area * qty * price, qty,
        notes: document.getElementById('notes')?.value || '',
        address: lastAddress, lat: lastLat, lng: lastLng,
        polygon_geojson: drawnFeature ? drawnFeature.geometry : null,
        ai_narrative: (narrative && !narrative.includes('Writing')) ? narrative : ''
      })
    });
    if (!res.ok) throw new Error();
    showToast('Quote saved! 💾');
    loadSavedCount();
  } catch { showToast('Save failed — check connection'); }
}

async function loadSavedCount() {
  try {
    const data = await fetch('/api/stats').then(r => r.json());
    const n = data.total_quotes || 0;
    setText('saved-count', n);
    setText('saved-count-tab', n);
  } catch {}
}

async function loadSaved() {
  const search = document.getElementById('search-input')?.value || '';
  const container = document.getElementById('saved-list');
  try {
    const data = await fetch(`/api/quotes?search=${encodeURIComponent(search)}&limit=30`).then(r => r.json());
    renderSavedList(data.quotes || []);
  } catch {
    if (container) container.innerHTML = '<div class="empty-state">Failed to load.</div>';
  }
}

function renderSavedList(quotes) {
  const container = document.getElementById('saved-list');
  if (!quotes.length) { container.innerHTML = '<div class="empty-state">No quotes yet.</div>'; return; }
  window._savedQuotes = {};
  quotes.forEach(q => { window._savedQuotes[q.id] = q; });
  container.innerHTML = quotes.map(q => `
    <div class="quote-card">
      <div class="qc-header">
        <div>
          <div class="qc-client">${esc(q.client_name)}</div>
          <div class="qc-meta">${(q.project_type||'').replace(/-/g,' ')} · ${new Date(q.created_at).toLocaleDateString()}</div>
        </div>
        <div class="qc-total">$${fmtMoney(q.total)}</div>
      </div>
      <div class="qc-meta">${fmt(q.area)} ${unitLabel(q.unit)} × $${parseFloat(q.price_per_unit).toFixed(2)}${q.qty>1?' ('+q.qty+'x)':''}</div>
      ${q.address ? `<div class="qc-meta">📍 ${esc(q.address.split(',').slice(0,2).join(','))}</div>` : ''}
      <div class="qc-actions">
        <button class="mini-btn load" data-id="${q.id}">Load</button>
        <button class="mini-btn share" data-id="${q.id}">Share</button>
        <button class="mini-btn del" data-id="${q.id}">Delete</button>
      </div>
    </div>`).join('');

  container.querySelectorAll('.mini-btn.load').forEach(b => b.addEventListener('click', () => loadQuote(b.dataset.id)));
  container.querySelectorAll('.mini-btn.share').forEach(b => b.addEventListener('click', () => openShareModal(window._savedQuotes[b.dataset.id])));
  container.querySelectorAll('.mini-btn.del').forEach(b => b.addEventListener('click', () => deleteQuote(b.dataset.id)));
}

async function loadQuote(id) {
  try {
    const q = await fetch(`/api/quotes/${id}`).then(r => r.json());
    if (q.error) throw new Error();
    document.getElementById('client-name').value = q.client_name || '';
    document.getElementById('project-type').value = q.project_type || 'pressure-washing';
    document.getElementById('notes').value = q.notes || '';
    document.getElementById('manual-area').value = q.area || '';
    document.getElementById('measure-type').value = q.unit || 'sqft';
    document.getElementById('qty').value = q.qty || 1;
    document.getElementById('markup').value = 0;
    // Restore price to dropdowns + manual field
    const savedPrice = parseFloat(q.price_per_unit) || 0;
    const dollars = Math.min(9, Math.floor(savedPrice));
    const cents = Math.round((savedPrice - Math.floor(savedPrice)) * 100);
    const dSel = document.getElementById('price-dollars');
    const cSel = document.getElementById('price-cents');
    if (dSel) dSel.value = dollars;
    if (cSel) cSel.value = cents;
    const priceInput = document.getElementById('price-per-unit');
    if (priceInput) priceInput.value = '';
    drawnRawMeters = 0; // use manual area
    if (q.ai_narrative) {
      document.getElementById('narrative-text').textContent = q.ai_narrative;
      document.getElementById('narrative-section').style.display = 'block';
    }
    if (q.polygon_geojson && draw && map?.loaded()) {
      const feature = { type: 'Feature', geometry: q.polygon_geojson, properties: {} };
      drawnFeature = feature;
      drawnRawType = q.polygon_geojson.type === 'LineString' ? 'line' : 'area';
      draw.deleteAll();
      draw.add(feature);
      if (q.lat && q.lng) map.flyTo({ center: [q.lng, q.lat], zoom: 18 });
    }
    if (q.address) {
      lastAddress = q.address; lastLat = q.lat; lastLng = q.lng;
      setText('address-display', q.address.split(',').slice(0,2).join(','));
    }
    updateCalc();
    showTab('quote');
    showToast('Quote loaded ✓');
  } catch { showToast('Could not load quote'); }
}

async function deleteQuote(id) {
  if (!confirm('Delete this quote?')) return;
  try {
    await fetch(`/api/quotes/${id}`, { method: 'DELETE' });
    showToast('Deleted');
    loadSaved(); loadSavedCount();
  } catch { showToast('Delete failed'); }
}

async function exportAll() {
  try {
    const data = await fetch('/api/quotes?limit=500').then(r => r.json());
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
function printQuote() {
  const client   = document.getElementById('client-name')?.value || 'Client';
  const projType = (document.getElementById('project-type')?.value||'').replace(/-/g,' ');
  const area     = getDisplayMeasurement();
  const unit     = unitLabel(document.getElementById('measure-type')?.value);
  const qty      = parseInt(document.getElementById('qty')?.value) || 1;
  const price    = getPrice();
  const total    = area * qty * price;
  const notes    = document.getElementById('notes')?.value || '';
  const narrative = document.getElementById('narrative-text')?.textContent || '';
  const today    = new Date().toLocaleDateString();
  const win = window.open('', '_blank');
  if (!win) { showToast('Allow popups to print'); return; }
  win.document.write(`<!DOCTYPE html><html><head><title>Quote — ${client}</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{font-family:'DM Sans',sans-serif;padding:40px;color:#0D2137;max-width:640px;margin:0 auto}
h1{font-family:'Bebas Neue',sans-serif;font-size:42px;letter-spacing:4px;color:#1C3A5E;margin:0}
.sub{color:#6B8FAD;font-size:13px;margin-bottom:28px}.row{display:flex;gap:24px;margin-bottom:14px;flex-wrap:wrap}
.block{flex:1;min-width:120px}.lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;margin-bottom:3px}
.val{font-size:16px;font-weight:600;text-transform:capitalize}
.total-box{background:#0D2137;color:white;padding:20px 24px;border-radius:12px;margin:24px 0;display:flex;justify-content:space-between;align-items:center}
.t-lbl{font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:.6}
.t-val{font-family:'Bebas Neue',sans-serif;font-size:48px;color:#E8A020}
.narrative{background:#F4F7FA;border-radius:8px;padding:16px;font-size:13px;line-height:1.8;margin-bottom:20px;color:#2B4B6F;white-space:pre-wrap}
.footer{font-size:11px;color:#9ab;margin-top:28px;text-align:center}
@media print{.no-print{display:none!important}}</style></head><body>
<h1>QUOTE<span style="color:#E8A020">machine</span></h1>
<div class="sub">Estimate · ${today}</div>
<div class="row">
  <div class="block"><div class="lbl">Client</div><div class="val">${client}</div></div>
  <div class="block"><div class="lbl">Project</div><div class="val">${projType}</div></div>
</div>
${lastAddress?`<div class="row"><div class="block"><div class="lbl">Location</div><div class="val" style="text-transform:none">${lastAddress}</div></div></div>`:''}
<div class="row">
  <div class="block"><div class="lbl">Measurement</div><div class="val">${fmt(area*qty)} ${unit}${qty>1?' ('+qty+'×)':''}</div></div>
  <div class="block"><div class="lbl">Rate</div><div class="val">$${price.toFixed(2)} / ${unit}</div></div>
</div>
${notes?`<div class="row"><div class="block"><div class="lbl">Notes</div><div class="val" style="font-weight:400">${notes}</div></div></div>`:''}
${narrative&&!narrative.includes('Writing')?`<div class="lbl" style="margin-bottom:8px">Scope of Work</div><div class="narrative">${narrative}</div>`:''}
<div class="total-box">
  <div class="t-lbl">Estimated Total</div>
  <div class="t-val">$${fmtMoney(total)}</div>
</div>
<div class="footer">This is an estimate. Final pricing subject to on-site inspection.</div>
<br><button class="no-print" onclick="window.print()" style="padding:12px 28px;background:#0D2137;color:white;border:none;border-radius:8px;font-size:15px;cursor:pointer;margin-top:8px">🖨️ Print / Save as PDF</button>
</body></html>`);
  win.document.close();
}

function buildShareText(q) {
  if (q) {
    return `📋 QUOTE machine\nClient: ${q.client_name}\nJob: ${(q.project_type||'').replace(/-/g,' ')}\nArea: ${fmt(q.area)} ${unitLabel(q.unit)}${q.qty>1?' ×'+q.qty:''}\nRate: $${parseFloat(q.price_per_unit).toFixed(2)}/${unitLabel(q.unit)}\n${q.address?'Location: '+q.address:''}\n──────────\nTOTAL: $${fmtMoney(q.total)}\n${q.notes?'Notes: '+q.notes:''}\nDate: ${new Date(q.created_at).toLocaleDateString()}`.replace(/\n{3,}/g,'\n\n');
  }
  const client = document.getElementById('client-name')?.value || 'Client';
  const projType = (document.getElementById('project-type')?.value||'').replace(/-/g,' ');
  const area = getDisplayMeasurement();
  const unit = unitLabel(document.getElementById('measure-type')?.value);
  const qty  = parseInt(document.getElementById('qty')?.value) || 1;
  const price = getPrice();
  const notes = document.getElementById('notes')?.value || '';
  return `📋 QUOTE machine\nClient: ${client}\nJob: ${projType}\nArea: ${fmt(area*qty)} ${unit}${qty>1?' ×'+qty:''}\nRate: $${price.toFixed(2)}/${unit}\n${lastAddress?'Location: '+lastAddress:''}\n──────────\nTOTAL: $${fmtMoney(area*qty*price)}\n${notes?'Notes: '+notes:''}\nDate: ${new Date().toLocaleDateString()}`.replace(/\n{3,}/g,'\n\n');
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
    const s = await fetch('/api/stats').then(r => r.json());
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
  document.getElementById('qty').value = 1;
  document.getElementById('markup').value = 0;
  // Reset price
  const dSel = document.getElementById('price-dollars');
  const cSel = document.getElementById('price-cents');
  if (dSel) dSel.value = '0';
  if (cSel) cSel.value = '5';
  const priceInput = document.getElementById('price-per-unit');
  if (priceInput) priceInput.value = '';
  document.getElementById('narrative-section').style.display = 'none';
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
  if (!handle || !panel) return;
  let startY = 0, startH = 0;
  const onStart = y => { isDragging = true; startY = y; startH = panel.offsetHeight; };
  const onMove  = y => {
    if (!isDragging) return;
    const newH = Math.max(56, Math.min(window.innerHeight * 0.85, startH + (startY - y)));
    panel.style.height = newH + 'px';
    panel.style.maxHeight = newH + 'px';
  };
  const onEnd = () => { isDragging = false; };
  handle.addEventListener('touchstart', e => onStart(e.touches[0].clientY), { passive: true });
  document.addEventListener('touchmove', e => { if (isDragging) onMove(e.touches[0].clientY); }, { passive: true });
  document.addEventListener('touchend', onEnd);
  handle.addEventListener('mousedown', e => { onStart(e.clientY); e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (isDragging) onMove(e.clientY); });
  document.addEventListener('mouseup', onEnd);
}
