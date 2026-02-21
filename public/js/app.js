// ══════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════
let map = null;
let draw = null;
let mapboxToken = '';
let drawnFeature = null;
let drawnRawMeters = 0;
let drawnRawType = 'area';
let lastAddress = '';
let lastLat = null;
let lastLng = null;
let chatHistory = [];
let aiPriceData = null;
let screenshotDataURL = null;
let isDragging = false;
let mapStyleHasLabels = true;
let debounceTimer = null;

// ══════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  buildPriceDropdowns();
  updateCalc();
  initPanelDrag();
  initModalBackdrops();
  loadSavedCount();

  // ── Map toolbar
  on('tool-polygon',    () => setDrawMode('draw_polygon'));
  on('tool-line',       () => setDrawMode('draw_line_string'));
  on('tool-select',     () => setDrawMode('simple_select'));
  on('tool-clear',      () => clearDrawing());
  on('tool-screenshot', () => takeScreenshot());
  on('tool-satellite',  () => toggleLabels());
  on('search-btn',      () => geocodeAddress());
  on('badge-clear-btn', () => clearDrawing());

  // ── Address input
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

  // ── Tabs
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => showTab(['quote','saved','stats'][i]));
  });

  // ── Calc triggers
  ['measure-type','qty','price-dollars','price-cents','markup','project-type'].forEach(id =>
    on(id, () => updateCalc(), 'change'));
  on('manual-area', () => updateCalc(), 'input');

  // ── Quote actions
  on('btn-save',      () => saveQuote());
  on('btn-narrative', () => generateNarrative());
  on('btn-print',     () => printQuote());
  on('btn-share',     () => openShareModal(null));
  on('btn-new',       () => newQuote());
  on('ai-suggest-btn',() => aiSuggestPrice());
  on('btn-narrative-regen', () => generateNarrative());

  // ── Header
  on('ai-chat-btn',   () => openAiPanel());

  // ── AI panel
  on('ai-panel-close',() => closeAiPanel());
  on('ai-overlay',    () => closeAiPanel());
  on('chat-send-btn', () => sendChat());
  const chatIn = document.getElementById('chat-input');
  if (chatIn) chatIn.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  // ── Share modal
  on('share-cancel',  () => closeModal('share-modal'));
  on('share-copy',    () => copyShare());
  on('share-sms',     () => smsShare());
  on('share-email',   () => emailShare());

  // ── Screenshot modal
  on('ss-close',      () => closeModal('screenshot-modal'));
  on('ss-download',   () => downloadScreenshot());
  on('ss-share',      () => shareScreenshot());

  // ── AI price modal
  on('ai-price-dismiss', () => closeModal('ai-price-modal'));
  on('ai-price-apply',   () => applyAiPrice());

  // ── Saved tab
  on('search-input',  () => loadSaved(), 'input');
  on('export-btn',    () => exportAll());

  // ── Load map config
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    mapboxToken = cfg.mapboxToken || '';
    if (!mapboxToken) { setMapHint('⚠️ Map unavailable — MAPBOX_TOKEN not set'); return; }
    initMap();
    geolocateUser();
  } catch (err) {
    console.error('Boot error:', err);
    setMapHint('⚠️ Failed to load config');
  }
});

// Helper: bind click (or other event) to element by id
function on(id, fn, evt = 'click') {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, fn);
}

// ══════════════════════════════════════════
//  MAP
// ══════════════════════════════════════════
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

  draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {},
    styles: [
      { id: 'gl-draw-polygon-fill', type: 'fill',
        filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
        paint: { 'fill-color': '#E8A020', 'fill-opacity': 0.22 } },
      { id: 'gl-draw-polygon-stroke', type: 'line',
        filter: ['all', ['==', '$type', 'Polygon']],
        paint: { 'line-color': '#E8A020', 'line-width': 3 } },
      { id: 'gl-draw-line', type: 'line',
        filter: ['all', ['==', '$type', 'LineString'], ['!=', 'mode', 'static']],
        paint: { 'line-color': '#E8A020', 'line-width': 4, 'line-dasharray': [2,1] } },
      { id: 'gl-draw-vertex', type: 'circle',
        filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']],
        paint: { 'circle-radius': 6, 'circle-color': '#E8A020', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } },
      { id: 'gl-draw-midpoint', type: 'circle',
        filter: ['all', ['==', 'meta', 'midpoint'], ['==', '$type', 'Point']],
        paint: { 'circle-radius': 4, 'circle-color': '#F5C35A' } }
    ]
  });

  map.addControl(draw);
  map.on('draw.create', onDrawChange);
  map.on('draw.update', onDrawChange);
  map.on('draw.delete', onDrawDelete);

  map.on('load', () => {
    activateTool('tool-polygon');
    setMapHint('Tap ⬡ then draw on the map to measure');
  });
}

// ── Draw tools
function setDrawMode(mode) {
  if (!draw || !map) { showToast('Map loading...'); return; }
  if (!map.loaded()) { map.once('load', () => setDrawMode(mode)); return; }
  try {
    draw.changeMode(mode);
    const ids = { draw_polygon:'tool-polygon', draw_line_string:'tool-line', simple_select:'tool-select' };
    activateTool(ids[mode] || null);
  } catch(e) {
    console.warn('setDrawMode:', e.message);
  }
}

function activateTool(id) {
  document.querySelectorAll('.map-tool-btn').forEach(b => b.classList.remove('active'));
  if (id) document.getElementById(id)?.classList.add('active');
}

function onDrawChange(e) {
  // Use event features first, fall back to getAll
  let feature = null;
  if (e && e.features && e.features.length) {
    feature = e.features[0];
  } else {
    const data = draw.getAll();
    if (!data.features.length) return;
    feature = data.features[0];
  }

  drawnFeature = feature;

  try {
    if (feature.geometry.type === 'LineString') {
      drawnRawMeters = turf.length(feature, { units: 'meters' });
      drawnRawType = 'line';
      document.getElementById('measure-type').value = 'linft';
    } else {
      drawnRawMeters = turf.area(feature);
      drawnRawType = 'area';
      document.getElementById('measure-type').value = 'sqft';
    }
  } catch(err) {
    console.error('Measurement error:', err);
    return;
  }

  document.getElementById('manual-area').value = '';
  updateCalc();
  updateBadge();
  setMapHint('');

  // Scroll panel to top so user sees the measurement
  const scroll = document.getElementById('panel-scroll');
  if (scroll) scroll.scrollTop = 0;
}

function onDrawDelete() {
  drawnFeature = null;
  drawnRawMeters = 0;
  drawnRawType = 'area';
  document.getElementById('measure-badge').style.display = 'none';
  document.getElementById('manual-area').value = '';
  setMapHint('Tap ⬡ then draw on the map to measure');
  updateCalc();
}

function clearDrawing() {
  if (draw) draw.deleteAll();
  onDrawDelete();
}

function getDisplayMeasurement() {
  const manual = parseFloat(document.getElementById('manual-area').value);
  if (!isNaN(manual) && manual > 0) return manual;
  if (!drawnRawMeters) return 0;
  const type = document.getElementById('measure-type').value;
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
  return { sqft:'sq ft', linft:'lin ft', sqyd:'sq yd', acre:'acres' }[type] || 'sq ft';
}

function updateBadge() {
  const val = getDisplayMeasurement();
  const type = document.getElementById('measure-type').value;
  document.getElementById('badge-val').textContent = fmt(val);
  document.getElementById('badge-unit').textContent = unitLabel(type);
  document.getElementById('measure-badge').style.display = 'flex';
}

function setMapHint(msg) {
  const el = document.getElementById('map-hint');
  if (!el) return;
  if (msg) { el.textContent = msg; el.style.display = 'block'; }
  else { el.style.display = 'none'; }
}

// ── Toggle labels
function toggleLabels() {
  if (!map) return;
  mapStyleHasLabels = !mapStyleHasLabels;
  const style = mapStyleHasLabels
    ? 'mapbox://styles/mapbox/satellite-streets-v12'
    : 'mapbox://styles/mapbox/satellite-v9';
  const saved = draw ? draw.getAll() : null;
  map.setStyle(style);
  map.once('style.load', () => {
    if (draw) {
      try { map.removeControl(draw); } catch(e) {}
      map.addControl(draw);
      if (saved && saved.features.length) draw.add(saved);
    }
    showToast(mapStyleHasLabels ? 'Labels on' : 'Labels off');
  });
}

// ── Screenshot
function takeScreenshot() {
  if (!map) { showToast('Map not loaded'); return; }
  try {
    screenshotDataURL = map.getCanvas().toDataURL('image/png');
    document.getElementById('screenshot-img').src = screenshotDataURL;
    openModal('screenshot-modal');
  } catch(e) { showToast('Screenshot failed'); }
}

function downloadScreenshot() {
  if (!screenshotDataURL) return;
  const a = document.createElement('a');
  a.href = screenshotDataURL;
  a.download = 'quote-map-' + Date.now() + '.png';
  a.click();
}

function shareScreenshot() {
  if (!screenshotDataURL) { downloadScreenshot(); return; }
  fetch(screenshotDataURL).then(r => r.blob()).then(blob => {
    const file = new File([blob], 'quote-map.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'QUOTE machine' });
    } else { downloadScreenshot(); }
  });
}

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
  if (!q) return;
  clearAutocomplete();
  if (!mapboxToken) { showToast('Map not available'); return; }
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
  const el = document.getElementById('address-display');
  if (el) el.textContent = name.split(',').slice(0,2).join(',');
  if (map) map.flyTo({ center: [lng, lat], zoom: 19, speed: 1.5 });
}

function geolocateUser() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    if (map) map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 18 });
  }, () => {});
}

// ══════════════════════════════════════════
//  PRICING
// ══════════════════════════════════════════
function buildPriceDropdowns() {
  const dSel = document.getElementById('price-dollars');
  const cSel = document.getElementById('price-cents');
  if (!dSel || !cSel) return;
  for (let d = 0; d <= 5; d++) dSel.appendChild(new Option('$' + d, d));
  for (let c = 0; c <= 99; c++) {
    const o = new Option(c.toString().padStart(2,'0') + '¢', c);
    if (c === 5) o.selected = true;
    cSel.appendChild(o);
  }
}

function getPrice() {
  const d = parseFloat(document.getElementById('price-dollars')?.value) || 0;
  const c = parseFloat(document.getElementById('price-cents')?.value) || 0;
  const markup = parseFloat(document.getElementById('markup')?.value) || 0;
  return (d + c / 100) * (1 + markup / 100);
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

  if (drawnFeature) updateBadge();
}

// ══════════════════════════════════════════
//  AI FEATURES
// ══════════════════════════════════════════
async function aiSuggestPrice() {
  const btn = document.getElementById('ai-suggest-btn');
  const area = getDisplayMeasurement();
  if (!area) { showToast('Draw or enter an area first'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }
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
  } catch { showToast('AI pricing failed'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '✨ AI Suggest'; } }
}

function showAiPriceModal(d) {
  const f2 = v => '$' + parseFloat(v||0).toFixed(2);
  document.getElementById('ai-price-content').innerHTML = `
    <div class="price-tier low">
      <div><div class="tier-label">🟢 Low</div><div class="tier-sub">Budget rate</div></div>
      <div class="tier-right"><div class="tier-val">${f2(d.low_per_unit)}<span>/unit</span></div><div class="tier-total">Total: ${f2(d.low_total)}</div></div>
    </div>
    <div class="price-tier mid">
      <div><div class="tier-label">⭐ Recommended</div><div class="tier-sub">Market rate</div></div>
      <div class="tier-right"><div class="tier-val">${f2(d.recommended_per_unit)}<span>/unit</span></div><div class="tier-total">Total: ${f2(d.mid_total)}</div></div>
    </div>
    <div class="price-tier high">
      <div><div class="tier-label">🔴 Premium</div><div class="tier-sub">High-end</div></div>
      <div class="tier-right"><div class="tier-val">${f2(d.high_per_unit)}<span>/unit</span></div><div class="tier-total">Total: ${f2(d.high_total)}</div></div>
    </div>
    ${d.reasoning ? `<div class="ai-reasoning">💡 ${d.reasoning}</div>` : ''}
    ${d.factors?.length ? `<div class="ai-reasoning">Factors: ${d.factors.join(' · ')}</div>` : ''}`;
  openModal('ai-price-modal');
}

function applyAiPrice() {
  if (!aiPriceData) return;
  const rec = parseFloat(aiPriceData.recommended_per_unit);
  const dollars = Math.min(5, Math.floor(rec));
  const cents = Math.round((rec - Math.floor(rec)) * 100);
  const dSel = document.getElementById('price-dollars');
  const cSel = document.getElementById('price-cents');
  if (dSel) dSel.value = dollars;
  if (cSel) cSel.value = cents;
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
  box.textContent = '✍️ Generating...';
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
  } catch { box.textContent = 'Failed — check connection.'; }
}

// AI Chat
function openAiPanel() {
  document.getElementById('ai-panel').classList.add('open');
  document.getElementById('ai-overlay').classList.add('open');
  if (!chatHistory.length) {
    addChatMsg('ai', "Hi! I'm your QUOTE machine assistant. Ask me about pricing, measurements, or anything trades-related 💡");
  }
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
  const container = document.getElementById('chat-messages');
  if (!container) return '';
  const id = 'msg-' + Date.now() + Math.random();
  const div = document.createElement('div');
  div.id = id;
  div.className = `chat-msg ${role}${isTyping ? ' typing' : ''}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

function removeMsg(id) { document.getElementById(id)?.remove(); }

// ══════════════════════════════════════════
//  SAVE / LOAD / DELETE
// ══════════════════════════════════════════
async function saveQuote() {
  const client = document.getElementById('client-name')?.value.trim();
  if (!client) { showToast('Enter a client name first'); return; }
  const area = getDisplayMeasurement();
  const qty = parseInt(document.getElementById('qty')?.value) || 1;
  const price = getPrice();
  const unit = document.getElementById('measure-type')?.value || 'sqft';
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
        ai_narrative: (narrative && !narrative.includes('Generating')) ? narrative : ''
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
    setText('saved-count', data.total_quotes || 0);
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
  if (!quotes.length) { container.innerHTML = '<div class="empty-state">No quotes found.</div>'; return; }
  container.innerHTML = quotes.map(q => {
    const date = new Date(q.created_at).toLocaleDateString();
    const label = (q.project_type||'').replace(/-/g,' ');
    return `<div class="quote-card">
      <div class="qc-header">
        <div>
          <div class="qc-client">${esc(q.client_name)}</div>
          <div class="qc-meta">${label} · ${date}</div>
        </div>
        <div class="qc-total">$${fmtMoney(q.total)}</div>
      </div>
      <div class="qc-meta">${fmt(q.area)} ${unitLabel(q.unit)} × $${parseFloat(q.price_per_unit).toFixed(2)}${q.qty>1?' ('+q.qty+'x)':''}</div>
      ${q.address ? `<div class="qc-meta">📍 ${esc(q.address.split(',').slice(0,2).join(','))}</div>` : ''}
      <div class="qc-actions">
        <button class="mini-btn load" data-id="${q.id}">Load</button>
        <button class="mini-btn share" data-idx="${q.id}">Share</button>
        <button class="mini-btn del" data-id="${q.id}">Delete</button>
      </div>
    </div>`;
  }).join('');

  // Store quotes for share lookup
  window._savedQuotes = {};
  quotes.forEach(q => { window._savedQuotes[q.id] = q; });

  container.querySelectorAll('.mini-btn.load').forEach(btn =>
    btn.addEventListener('click', () => loadQuote(btn.dataset.id)));
  container.querySelectorAll('.mini-btn.share').forEach(btn =>
    btn.addEventListener('click', () => openShareModal(window._savedQuotes[btn.dataset.idx])));
  container.querySelectorAll('.mini-btn.del').forEach(btn =>
    btn.addEventListener('click', () => deleteQuote(btn.dataset.id)));
}

async function loadQuote(id) {
  try {
    const q = await fetch(`/api/quotes/${id}`).then(r => r.json());
    if (q.error) throw new Error();
    document.getElementById('client-name').value = q.client_name || '';
    document.getElementById('project-type').value = q.project_type || 'parking-lot-striping';
    document.getElementById('notes').value = q.notes || '';
    document.getElementById('manual-area').value = q.area || '';
    document.getElementById('measure-type').value = q.unit || 'sqft';
    document.getElementById('qty').value = q.qty || 1;
    document.getElementById('markup').value = 0;
    const d = Math.min(5, Math.floor(q.price_per_unit));
    const c = Math.round((q.price_per_unit - Math.floor(q.price_per_unit)) * 100);
    document.getElementById('price-dollars').value = d;
    document.getElementById('price-cents').value = c;
    if (q.ai_narrative) {
      document.getElementById('narrative-text').textContent = q.ai_narrative;
      document.getElementById('narrative-section').style.display = 'block';
    }
    if (q.polygon_geojson && draw) {
      draw.deleteAll();
      drawnFeature = { type: 'Feature', geometry: q.polygon_geojson, properties: {} };
      draw.add(drawnFeature);
      drawnRawType = q.polygon_geojson.type === 'LineString' ? 'line' : 'area';
      if (q.lat && q.lng && map) map.flyTo({ center: [q.lng, q.lat], zoom: 18 });
    }
    if (q.address) {
      lastAddress = q.address; lastLat = q.lat; lastLng = q.lng;
      setText('address-display', q.address.split(',').slice(0,2).join(','));
    }
    updateCalc();
    showTab('quote');
    showToast('Quote loaded ✓');
  } catch { showToast('Failed to load quote'); }
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
    a.href = URL.createObjectURL(new Blob([text], { type:'text/plain' }));
    a.download = 'quotes-' + Date.now() + '.txt';
    a.click();
    showToast('Exported!');
  } catch { showToast('Export failed'); }
}

// ══════════════════════════════════════════
//  PRINT / SHARE
// ══════════════════════════════════════════
function printQuote() {
  const client   = document.getElementById('client-name')?.value || 'Client';
  const projType = (document.getElementById('project-type')?.value||'').replace(/-/g,' ');
  const area     = getDisplayMeasurement();
  const unit     = unitLabel(document.getElementById('measure-type')?.value);
  const qty      = parseInt(document.getElementById('qty')?.value) || 1;
  const price    = getPrice();
  const total    = area * qty * price;
  const notes    = document.getElementById('notes')?.value || '';
  const narrative= document.getElementById('narrative-text')?.textContent || '';
  const today    = new Date().toLocaleDateString();
  const win = window.open('', '_blank');
  if (!win) { showToast('Allow popups to print'); return; }
  win.document.write(`<!DOCTYPE html><html><head><title>Quote - ${client}</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{font-family:'DM Sans',sans-serif;padding:40px;color:#0D1F33;max-width:640px;margin:0 auto}
h1{font-family:'Bebas Neue',sans-serif;font-size:40px;letter-spacing:4px;color:#1C3A5E;margin-bottom:2px}
.sub{color:#6B8FAD;font-size:13px;margin-bottom:28px}.row{display:flex;gap:24px;margin-bottom:16px;flex-wrap:wrap}
.block{flex:1;min-width:120px}.lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;margin-bottom:3px}
.val{font-size:16px;font-weight:600;text-transform:capitalize}
.total-box{background:#1C3A5E;color:white;padding:20px 24px;border-radius:12px;margin:24px 0;display:flex;justify-content:space-between;align-items:center}
.t-lbl{font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:.7}
.t-val{font-family:'Bebas Neue',sans-serif;font-size:44px;color:#E8A020}
.narrative{background:#EDF3FA;border-radius:8px;padding:16px;font-size:13px;line-height:1.7;margin-bottom:20px;color:#2B4B6F;white-space:pre-wrap}
.footer{font-size:11px;color:#9ab;margin-top:30px;text-align:center}@media print{.no-print{display:none!important}}</style></head><body>
<h1>QUOTE<span style="color:#E8A020">machine</span></h1>
<div class="sub">Estimate · ${today}</div>
<div class="row"><div class="block"><div class="lbl">Client</div><div class="val">${client}</div></div>
<div class="block"><div class="lbl">Project</div><div class="val">${projType}</div></div></div>
${lastAddress?`<div class="row"><div class="block"><div class="lbl">Location</div><div class="val" style="text-transform:none">${lastAddress}</div></div></div>`:''}
<div class="row"><div class="block"><div class="lbl">Measurement</div><div class="val">${fmt(area*qty)} ${unit}${qty>1?' ('+qty+'x)':''}</div></div>
<div class="block"><div class="lbl">Rate</div><div class="val">$${price.toFixed(2)} / ${unit}</div></div></div>
${notes?`<div class="row"><div class="block"><div class="lbl">Notes</div><div class="val" style="font-weight:400">${notes}</div></div></div>`:''}
${narrative&&!narrative.includes('Generating')?`<div class="lbl" style="margin-bottom:8px">Scope of Work</div><div class="narrative">${narrative}</div>`:''}
<div class="total-box"><div class="t-lbl">Estimated Total</div><div class="t-val">$${fmtMoney(total)}</div></div>
<div class="footer">Estimate only. Final pricing subject to on-site inspection.</div>
<br><button class="no-print" onclick="window.print()" style="padding:12px 24px;background:#1C3A5E;color:white;border:none;border-radius:8px;font-size:15px;cursor:pointer">🖨️ Print / Save PDF</button>
</body></html>`);
  win.document.close();
}

function buildShareText(q) {
  if (q) {
    return `📋 QUOTE machine Estimate
Client: ${q.client_name}
Type: ${(q.project_type||'').replace(/-/g,' ')}
Area: ${fmt(q.area)} ${unitLabel(q.unit)}${q.qty>1?' ×'+q.qty:''}
Rate: $${parseFloat(q.price_per_unit).toFixed(2)}/${unitLabel(q.unit)}
${q.address?'Location: '+q.address:''}
──────────────────
TOTAL: $${fmtMoney(q.total)}
${q.notes?'Notes: '+q.notes:''}
Date: ${new Date(q.created_at).toLocaleDateString()}`.replace(/\n{3,}/g,'\n\n');
  }
  const client = document.getElementById('client-name')?.value || 'Client';
  const projType = (document.getElementById('project-type')?.value||'').replace(/-/g,' ');
  const area = getDisplayMeasurement();
  const unit = unitLabel(document.getElementById('measure-type')?.value);
  const qty = parseInt(document.getElementById('qty')?.value) || 1;
  const price = getPrice();
  const notes = document.getElementById('notes')?.value || '';
  return `📋 QUOTE machine Estimate
Client: ${client}
Type: ${projType}
Area: ${fmt(area*qty)} ${unit}${qty>1?' ×'+qty:''}
Rate: $${price.toFixed(2)}/${unit}
${lastAddress?'Location: '+lastAddress:''}
──────────────────
TOTAL: $${fmtMoney(area*qty*price)}
${notes?'Notes: '+notes:''}
Date: ${new Date().toLocaleDateString()}`.replace(/\n{3,}/g,'\n\n');
}

function openShareModal(q) {
  document.getElementById('share-text').value = buildShareText(q||null);
  openModal('share-modal');
}

function copyShare() {
  const text = document.getElementById('share-text').value;
  navigator.clipboard.writeText(text)
    .then(() => { showToast('Copied! 📋'); closeModal('share-modal'); })
    .catch(() => showToast('Copy failed'));
}

function smsShare() {
  window.open('sms:?body=' + encodeURIComponent(document.getElementById('share-text').value));
}

function emailShare() {
  const b = encodeURIComponent(document.getElementById('share-text').value);
  window.open(`mailto:?subject=${encodeURIComponent('Quote Estimate')}&body=${b}`);
}

// ══════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════
async function loadStats() {
  const container = document.getElementById('stats-content');
  try {
    const s = await fetch('/api/stats').then(r => r.json());
    const mu = v => '$' + parseFloat(v||0).toLocaleString(undefined,{maximumFractionDigits:0});
    const rows = (s.by_type||[]).map(t => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--surface2)">
        <div style="font-size:13px;font-weight:600;text-transform:capitalize">${(t.project_type||'').replace(/-/g,' ')}</div>
        <div style="text-align:right">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:18px;color:var(--accent)">${mu(t.revenue)}</div>
          <div style="font-size:10px;color:var(--text-lt)">${t.count} quote${t.count!=1?'s':''}</div>
        </div>
      </div>`).join('');
    container.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${s.total_quotes}</div><div class="stat-lbl">Total Quotes</div></div>
        <div class="stat-card"><div class="stat-val">${mu(s.total_value)}</div><div class="stat-lbl">Total Value</div></div>
        <div class="stat-card"><div class="stat-val">${mu(s.avg_quote)}</div><div class="stat-lbl">Avg Quote</div></div>
        <div class="stat-card"><div class="stat-val">${s.this_month}</div><div class="stat-lbl">This Month</div></div>
      </div>
      ${rows?`<div class="section-title" style="margin-top:14px">By Type</div><div>${rows}</div>`:''}`;
  } catch {
    container.innerHTML = '<div class="empty-state">Failed to load stats.</div>';
  }
}

// ══════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════
function showTab(tab) {
  ['quote','saved','stats'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', ['quote','saved','stats'][i] === tab);
  });
  // Always scroll to top when switching tabs
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
  document.getElementById('price-dollars').selectedIndex = 0;
  document.getElementById('price-cents').value = 5;
  document.getElementById('narrative-section').style.display = 'none';
  document.getElementById('ai-price-banner').style.display = 'none';
  clearDrawing();
  updateCalc();
  showToast('New quote ready');
}

function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

function initModalBackdrops() {
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function fmt(n) { return parseFloat(n||0).toLocaleString(undefined,{maximumFractionDigits:1}); }
function fmtMoney(n) { return parseFloat(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ══════════════════════════════════════════
//  PANEL DRAG
// ══════════════════════════════════════════
function initPanelDrag() {
  const handle = document.getElementById('panel-drag');
  const panel  = document.getElementById('bottom-panel');
  if (!handle || !panel) return;
  let startY = 0, startH = 0;
  const onStart = y => { isDragging = true; startY = y; startH = panel.offsetHeight; };
  const onMove  = y => {
    if (!isDragging) return;
    const newH = Math.max(50, Math.min(window.innerHeight * 0.85, startH + (startY - y)));
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
