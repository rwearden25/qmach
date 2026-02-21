// ── State
let map, draw;
let mapboxToken = '';
let drawnFeature = null;
let drawnType = null; // 'polygon' | 'line'
let lastAddress = '';
let lastLat = null, lastLng = null;
let chatHistory = [];
let aiPriceData = null;
let panelY = 0;
let isDragging = false;
let screenshotDataURL = null;
const PANEL_MIN_HEIGHT = 44;

// ── Boot
(async function init() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    mapboxToken = cfg.mapboxToken;
    if (!mapboxToken) {
      document.getElementById('map-hint').textContent = '⚠️ Mapbox token not configured — set MAPBOX_TOKEN env var';
      return;
    }
    initMap();
    buildPriceDropdowns();
    updateCalc();
    loadSavedCount();
    initPanelDrag();
    geolocateUser();
  } catch (err) {
    console.error('Init error:', err);
  }
})();

// ══════════════════════════════════════════
//  MAP
// ══════════════════════════════════════════
function initMap() {
  mapboxgl.accessToken = mapboxToken;

  map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    center: [-96.7970, 32.7767], // DFW default
    zoom: 17,
    attributionControl: true,
    logoPosition: 'bottom-left'
  });

  map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new mapboxgl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: false
  }), 'bottom-right');

  // Mapbox Draw
  draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: {},
    styles: [
      {
        id: 'gl-draw-polygon-fill',
        type: 'fill',
        filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
        paint: { 'fill-color': '#E8A020', 'fill-opacity': 0.25 }
      },
      {
        id: 'gl-draw-polygon-stroke',
        type: 'line',
        filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'mode', 'static']],
        paint: { 'line-color': '#E8A020', 'line-width': 3 }
      },
      {
        id: 'gl-draw-line',
        type: 'line',
        filter: ['all', ['==', '$type', 'LineString'], ['!=', 'mode', 'static']],
        paint: { 'line-color': '#E8A020', 'line-width': 4, 'line-dasharray': [2, 1] }
      },
      {
        id: 'gl-draw-vertex',
        type: 'circle',
        filter: ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point'], ['!=', 'mode', 'static']],
        paint: { 'circle-radius': 6, 'circle-color': '#E8A020', 'circle-stroke-color': 'white', 'circle-stroke-width': 2 }
      },
      {
        id: 'gl-draw-midpoint',
        type: 'circle',
        filter: ['all', ['==', 'meta', 'midpoint'], ['==', '$type', 'Point']],
        paint: { 'circle-radius': 4, 'circle-color': '#F5C35A', 'circle-stroke-color': 'white', 'circle-stroke-width': 1 }
      }
    ]
  });
  map.addControl(draw);

  map.on('draw.create', onDrawChange);
  map.on('draw.update', onDrawChange);
  map.on('draw.delete', onDrawDelete);
  map.on('draw.modechange', onModeChange);

  // Set initial tool
  setDrawMode('draw_polygon');
}

function setDrawMode(mode) {
  if (!draw) return;
  draw.changeMode(mode);
  document.querySelectorAll('.map-tool-btn').forEach(b => b.classList.remove('active'));
  const id = mode === 'draw_polygon' ? 'tool-polygon'
           : mode === 'draw_line_string' ? 'tool-line'
           : 'tool-rect';
  document.getElementById(id)?.classList.add('active');
}

function onDrawChange(e) {
  const data = draw.getAll();
  if (!data.features.length) return;
  drawnFeature = data.features[0];
  drawnType = drawnFeature.geometry.type === 'LineString' ? 'line' : 'polygon';
  calculateFromFeature(drawnFeature, drawnType);
  document.getElementById('map-hint').classList.add('hidden');
}

function onDrawDelete() {
  drawnFeature = null;
  drawnType = null;
  document.getElementById('measure-badge').style.display = 'none';
  document.getElementById('map-hint').classList.remove('hidden');
  document.getElementById('manual-area').value = '';
  updateCalc();
}

function onModeChange(e) {
  // Reset tool buttons when draw mode ends
  if (e.mode === 'simple_select' || e.mode === 'direct_select') {
    // keep last active tool highlighted
  }
}

function calculateFromFeature(feature, type) {
  if (type === 'line') {
    const length = turf.length(feature, { units: 'meters' });
    // Store raw meters
    feature._rawMeters = length;
    feature._rawType = 'line';
    document.getElementById('measure-type').value = 'linft';
  } else {
    const area = turf.area(feature); // sq meters
    feature._rawMeters = area;
    feature._rawType = 'area';
    document.getElementById('measure-type').value = 'sqft';
  }
  document.getElementById('manual-area').value = '';
  updateCalc();
  showMeasureBadge();
}

function getRawMeasurement() {
  if (!drawnFeature) return 0;
  return drawnFeature._rawMeters || 0;
}

function getDisplayMeasurement() {
  const manual = parseFloat(document.getElementById('manual-area').value);
  const type = document.getElementById('measure-type').value;

  if (!isNaN(manual) && manual > 0) {
    return manual;
  }

  const raw = getRawMeasurement();
  if (!raw) return 0;

  const isLine = drawnFeature?._rawType === 'line';
  switch (type) {
    case 'sqft':  return isLine ? raw * 3.28084  : raw * 10.7639;
    case 'linft': return raw * 3.28084;
    case 'sqyd':  return raw * 1.19599;
    case 'acre':  return raw / 4046.86;
    default:      return raw * 10.7639;
  }
}

function unitLabel(type) {
  return { sqft: 'sq ft', linft: 'lin ft', sqyd: 'sq yd', acre: 'acres' }[type] || 'sq ft';
}

function showMeasureBadge() {
  const val = getDisplayMeasurement();
  const type = document.getElementById('measure-type').value;
  document.getElementById('badge-val').textContent = val.toLocaleString(undefined, { maximumFractionDigits: 1 });
  document.getElementById('badge-unit').textContent = unitLabel(type);
  document.getElementById('measure-badge').style.display = 'flex';
}

function clearDrawing() {
  if (draw) draw.deleteAll();
  onDrawDelete();
}

function toggleLabels() {
  if (!map) return;
  const style = map.getStyle().name;
  if (style && style.includes('satellite-streets')) {
    map.setStyle('mapbox://styles/mapbox/satellite-v9');
    showToast('Labels hidden');
  } else {
    map.setStyle('mapbox://styles/mapbox/satellite-streets-v12');
    showToast('Labels shown');
  }
  // Re-add draw control after style change
  map.once('style.load', () => {
    map.addControl(draw);
  });
}

function takeScreenshot() {
  showToast('Capturing map...');
  const mapCanvas = map.getCanvas();
  const dataURL = mapCanvas.toDataURL('image/png');
  screenshotDataURL = dataURL;
  document.getElementById('screenshot-img').src = dataURL;
  openModal('screenshot-modal');
}

function downloadScreenshot() {
  if (!screenshotDataURL) return;
  const a = document.createElement('a');
  a.href = screenshotDataURL;
  const addr = lastAddress ? lastAddress.split(',')[0].replace(/\s/g, '_') : 'map';
  a.download = `quote-machine-${addr}-${Date.now()}.png`;
  a.click();
}

function shareScreenshot() {
  if (!screenshotDataURL) return;
  // Convert dataURL to blob for Web Share API
  fetch(screenshotDataURL)
    .then(r => r.blob())
    .then(blob => {
      const file = new File([blob], 'quote-map.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'QUOTE machine map' });
      } else {
        downloadScreenshot();
      }
    });
}

// ── Address Geocoding (Mapbox)
let debounceTimer;
document.getElementById('addr-input').addEventListener('input', function() {
  clearTimeout(debounceTimer);
  const q = this.value.trim();
  if (q.length < 3) {
    document.getElementById('autocomplete-list').innerHTML = '';
    return;
  }
  debounceTimer = setTimeout(() => fetchSuggestions(q), 300);
});

async function fetchSuggestions(q) {
  if (!mapboxToken) return;
  try {
    const res = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&limit=5&country=US`
    );
    const data = await res.json();
    const list = document.getElementById('autocomplete-list');
    list.innerHTML = '';
    (data.features || []).forEach(f => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.textContent = f.place_name;
      item.onclick = () => {
        document.getElementById('addr-input').value = f.place_name;
        list.innerHTML = '';
        flyTo(f.center[0], f.center[1], f.place_name);
      };
      list.appendChild(item);
    });
  } catch (e) {}
}

async function geocodeAddress() {
  const q = document.getElementById('addr-input').value.trim();
  if (!q || !mapboxToken) return;
  document.getElementById('autocomplete-list').innerHTML = '';
  try {
    const res = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&limit=1`
    );
    const data = await res.json();
    if (data.features?.length) {
      const f = data.features[0];
      flyTo(f.center[0], f.center[1], f.place_name);
    } else {
      showToast('Address not found');
    }
  } catch (e) {
    showToast('Search error');
  }
}

function flyTo(lng, lat, placeName) {
  lastLat = lat;
  lastLng = lng;
  lastAddress = placeName;
  document.getElementById('address-display').textContent = placeName.split(',').slice(0, 2).join(',');
  map.flyTo({ center: [lng, lat], zoom: 19, speed: 1.5 });
}

function geolocateUser() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(pos => {
    if (map) map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 18 });
  }, () => {});
}

// ══════════════════════════════════════════
//  PRICING CALC
// ══════════════════════════════════════════
function buildPriceDropdowns() {
  const dSel = document.getElementById('price-dollars');
  const cSel = document.getElementById('price-cents');
  for (let d = 0; d <= 5; d++) {
    const o = new Option('$' + d, d);
    dSel.appendChild(o);
  }
  for (let c = 0; c <= 99; c++) {
    const o = new Option(c.toString().padStart(2, '0') + '¢', c);
    if (c === 5) o.selected = true;
    cSel.appendChild(o);
  }
}

function getPrice() {
  const d = parseFloat(document.getElementById('price-dollars').value) || 0;
  const c = parseFloat(document.getElementById('price-cents').value) || 0;
  const markup = parseFloat(document.getElementById('markup').value) || 0;
  const base = d + c / 100;
  return base * (1 + markup / 100);
}

function updateCalc() {
  const area = getDisplayMeasurement();
  const qty = parseInt(document.getElementById('qty').value) || 1;
  const type = document.getElementById('measure-type').value;
  const price = getPrice();
  const totalArea = area * qty;
  const total = totalArea * price;

  document.getElementById('area-display').textContent = totalArea.toLocaleString(undefined, { maximumFractionDigits: 1 });
  document.getElementById('unit-display').textContent = unitLabel(type) + (qty > 1 ? ' × ' + qty : '');
  document.getElementById('total-display').textContent = '$' + total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('breakdown-display').textContent =
    totalArea.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' ' + unitLabel(type) + ' × $' + price.toFixed(2);

  if (drawnFeature) showMeasureBadge();
}

// ══════════════════════════════════════════
//  AI FEATURES
// ══════════════════════════════════════════
async function aiSuggestPrice() {
  const btn = document.getElementById('ai-suggest-btn');
  const projType = document.getElementById('project-type').value;
  const area = getDisplayMeasurement();
  const unit = unitLabel(document.getElementById('measure-type').value);

  if (!area || area <= 0) {
    showToast('Draw a shape or enter area first');
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Loading...';

  try {
    const res = await fetch('/api/ai/suggest-price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_type: projType,
        area: area.toFixed(1),
        unit,
        location: lastAddress || 'DFW Texas'
      })
    });

    if (!res.ok) throw new Error('AI request failed');
    aiPriceData = await res.json();
    showAiPriceModal(aiPriceData);
  } catch (err) {
    showToast('AI pricing request failed');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ AI Suggest';
  }
}

function showAiPriceModal(data) {
  const fmtUSD = v => '$' + parseFloat(v).toFixed(2);
  const content = document.getElementById('ai-price-content');
  content.innerHTML = `
    <div class="price-tier low">
      <div><div class="tier-label">🟢 Low</div><div style="font-size:11px;color:#666">Budget competitive</div></div>
      <div><div class="tier-val">${fmtUSD(data.low_per_unit)}<small style="font-size:14px">/unit</small></div><div style="font-size:12px;text-align:right;color:#555">Total: ${fmtUSD(data.low_total)}</div></div>
    </div>
    <div class="price-tier mid">
      <div><div class="tier-label">⭐ Recommended</div><div style="font-size:11px;color:#666">Market rate</div></div>
      <div><div class="tier-val">${fmtUSD(data.recommended_per_unit)}<small style="font-size:14px">/unit</small></div><div style="font-size:12px;text-align:right;color:#555">Total: ${fmtUSD(data.mid_total)}</div></div>
    </div>
    <div class="price-tier high">
      <div><div class="tier-label">🔴 Premium</div><div style="font-size:11px;color:#666">High-end market</div></div>
      <div><div class="tier-val">${fmtUSD(data.high_per_unit)}<small style="font-size:14px">/unit</small></div><div style="font-size:12px;text-align:right;color:#555">Total: ${fmtUSD(data.high_total)}</div></div>
    </div>
    ${data.reasoning ? `<div class="ai-reasoning">💡 ${data.reasoning}</div>` : ''}
    ${data.factors?.length ? `<div class="ai-reasoning" style="margin-top:6px">Factors: ${data.factors.join(' · ')}</div>` : ''}
  `;
  openModal('ai-price-modal');
}

function applyAiPrice() {
  if (!aiPriceData) return;
  const recommended = parseFloat(aiPriceData.recommended_per_unit);
  const dollars = Math.floor(recommended);
  const cents = Math.round((recommended - dollars) * 100);
  document.getElementById('price-dollars').value = dollars > 5 ? 5 : dollars;
  document.getElementById('price-cents').value = cents;
  updateCalc();
  closeModal('ai-price-modal');
  showToast('AI price applied! ✨');
}

async function generateNarrative() {
  const client = document.getElementById('client-name').value.trim();
  const projType = document.getElementById('project-type').value;
  const area = getDisplayMeasurement();
  const unit = unitLabel(document.getElementById('measure-type').value);
  const price = getPrice();
  const qty = parseInt(document.getElementById('qty').value) || 1;
  const total = (area * qty * price).toFixed(2);
  const notes = document.getElementById('notes').value;

  if (!client) {
    showToast('Enter a client name first');
    return;
  }

  const narSection = document.getElementById('narrative-section');
  const narText = document.getElementById('narrative-text');
  narSection.style.display = 'block';
  narText.textContent = '✍️ Generating professional narrative...';

  try {
    const res = await fetch('/api/ai/generate-narrative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: client,
        project_type: projType.replace(/-/g, ' '),
        area: area.toFixed(1),
        unit,
        price_per_unit: price.toFixed(2),
        total,
        notes,
        address: lastAddress,
        qty
      })
    });
    const data = await res.json();
    narText.textContent = data.narrative || 'No narrative generated.';
    showToast('Narrative generated! ✍️');
  } catch (err) {
    narText.textContent = 'Failed to generate narrative. Check your connection.';
  }
}

// ── AI Chat
function openAiPanel() {
  document.getElementById('ai-panel').classList.add('open');
  document.getElementById('ai-overlay').classList.add('open');
  if (!chatHistory.length) {
    addChatMsg('ai', "Hi! I'm your QUOTE machine assistant. Ask me about pricing, measurements, or anything trades-related. 💡");
  }
  setTimeout(() => document.getElementById('chat-input').focus(), 300);
}

function closeAiPanel() {
  document.getElementById('ai-panel').classList.remove('open');
  document.getElementById('ai-overlay').classList.remove('open');
}

document.getElementById('ai-chat-btn').onclick = openAiPanel;

async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  addChatMsg('user', msg);
  chatHistory.push({ role: 'user', content: msg });

  // typing indicator
  const typingId = addChatMsg('ai', '...', true);

  try {
    const context = {
      project_type: document.getElementById('project-type').value,
      area: getDisplayMeasurement().toFixed(1),
      unit: unitLabel(document.getElementById('measure-type').value),
      price: getPrice().toFixed(2),
      address: lastAddress
    };

    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory, context })
    });
    const data = await res.json();
    removeTyping(typingId);
    const reply = data.reply || 'Sorry, I had trouble responding.';
    addChatMsg('ai', reply);
    chatHistory.push({ role: 'assistant', content: reply });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
  } catch {
    removeTyping(typingId);
    addChatMsg('ai', 'Connection error. Please try again.');
  }
}

function addChatMsg(role, text, isTyping = false) {
  const container = document.getElementById('chat-messages');
  const id = 'msg-' + Date.now();
  const div = document.createElement('div');
  div.id = id;
  div.className = `chat-msg ${role}${isTyping ? ' typing' : ''}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

function removeTyping(id) {
  document.getElementById(id)?.remove();
}

// ══════════════════════════════════════════
//  SAVE / LOAD / DELETE
// ══════════════════════════════════════════
async function saveQuote() {
  const client = document.getElementById('client-name').value.trim();
  if (!client) { showToast('Enter a client name first'); return; }

  const area = getDisplayMeasurement();
  const qty = parseInt(document.getElementById('qty').value) || 1;
  const price = getPrice();
  const unit = document.getElementById('measure-type').value;
  const total = area * qty * price;
  const narrative = document.getElementById('narrative-text').textContent;

  const payload = {
    client_name: client,
    project_type: document.getElementById('project-type').value,
    area, unit,
    price_per_unit: price,
    total,
    qty,
    notes: document.getElementById('notes').value,
    address: lastAddress || document.getElementById('notes').value.split('\n')[0],
    lat: lastLat, lng: lastLng,
    polygon_geojson: drawnFeature ? drawnFeature.geometry : null,
    ai_narrative: narrative && !narrative.includes('Generating') ? narrative : ''
  };

  try {
    const res = await fetch('/api/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error();
    showToast('Quote saved! 💾');
    loadSavedCount();
  } catch {
    showToast('Save failed — check server');
  }
}

async function loadSaved() {
  const search = document.getElementById('search-input')?.value || '';
  try {
    const res = await fetch(`/api/quotes?search=${encodeURIComponent(search)}&limit=30`);
    const data = await res.json();
    renderSavedList(data.quotes || []);
  } catch {
    document.getElementById('saved-list').innerHTML =
      '<div class="empty-state">Failed to load quotes.</div>';
  }
}

async function loadSavedCount() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    document.getElementById('saved-count').textContent = data.total_quotes || 0;
  } catch {}
}

function renderSavedList(quotes) {
  const container = document.getElementById('saved-list');
  if (!quotes.length) {
    container.innerHTML = '<div class="empty-state">No quotes found.</div>';
    return;
  }
  container.innerHTML = quotes.map(q => {
    const date = new Date(q.created_at).toLocaleDateString();
    const typeLabel = q.project_type.replace(/-/g, ' ');
    return `
    <div class="quote-card">
      <div class="qc-header">
        <div>
          <div class="qc-client">${q.client_name}</div>
          <div class="qc-meta">${typeLabel} · ${date}</div>
        </div>
        <div class="qc-total">$${parseFloat(q.total).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>
      <div class="qc-meta">${parseFloat(q.area).toLocaleString(undefined,{maximumFractionDigits:1})} ${unitLabel(q.unit)} × $${parseFloat(q.price_per_unit).toFixed(2)}/unit${q.qty>1?' ('+q.qty+'x)':''}</div>
      ${q.address ? `<div class="qc-meta">📍 ${q.address.split(',').slice(0,2).join(',')}</div>` : ''}
      <div class="qc-actions">
        <button class="mini-btn load" onclick="loadQuote('${q.id}')">Load</button>
        <button class="mini-btn share" onclick="shareQuoteObj(${JSON.stringify(q).replace(/"/g,'&quot;')})">Share</button>
        <button class="mini-btn del" onclick="deleteQuote('${q.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

async function loadQuote(id) {
  try {
    const q = await fetch(`/api/quotes/${id}`).then(r => r.json());
    document.getElementById('client-name').value = q.client_name;
    document.getElementById('project-type').value = q.project_type;
    document.getElementById('notes').value = q.notes || '';
    document.getElementById('manual-area').value = q.area;
    document.getElementById('measure-type').value = q.unit;
    document.getElementById('qty').value = q.qty || 1;

    const dollars = Math.floor(q.price_per_unit);
    const cents = Math.round((q.price_per_unit - dollars) * 100);
    document.getElementById('price-dollars').value = Math.min(5, dollars);
    document.getElementById('price-cents').value = cents;

    if (q.ai_narrative) {
      document.getElementById('narrative-text').textContent = q.ai_narrative;
      document.getElementById('narrative-section').style.display = 'block';
    }

    // Restore polygon on map
    if (q.polygon_geojson && map && draw) {
      draw.deleteAll();
      const feature = { type: 'Feature', geometry: q.polygon_geojson, properties: {} };
      draw.add(feature);
      drawnFeature = feature;
      drawnType = q.polygon_geojson.type === 'LineString' ? 'line' : 'polygon';
      feature._rawType = drawnType === 'line' ? 'line' : 'area';

      if (q.lat && q.lng) {
        map.flyTo({ center: [q.lng, q.lat], zoom: 18 });
        lastLat = q.lat; lastLng = q.lng;
      }
    }

    if (q.address) {
      lastAddress = q.address;
      document.getElementById('address-display').textContent = q.address.split(',').slice(0,2).join(',');
    }

    updateCalc();
    showTab('quote');
    showToast('Quote loaded!');
  } catch {
    showToast('Failed to load quote');
  }
}

async function deleteQuote(id) {
  if (!confirm('Delete this quote?')) return;
  try {
    await fetch(`/api/quotes/${id}`, { method: 'DELETE' });
    showToast('Deleted');
    loadSaved();
    loadSavedCount();
  } catch {
    showToast('Delete failed');
  }
}

// ══════════════════════════════════════════
//  PRINT / SHARE / EXPORT
// ══════════════════════════════════════════
function printQuote() {
  const client = document.getElementById('client-name').value || 'Client';
  const projType = document.getElementById('project-type').value.replace(/-/g, ' ');
  const area = getDisplayMeasurement();
  const unit = unitLabel(document.getElementById('measure-type').value);
  const qty = parseInt(document.getElementById('qty').value) || 1;
  const price = getPrice();
  const total = area * qty * price;
  const notes = document.getElementById('notes').value;
  const narrative = document.getElementById('narrative-text').textContent;
  const addr = lastAddress;
  const today = new Date().toLocaleDateString();

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Quote - ${client}</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  body{font-family:'DM Sans',sans-serif;padding:40px;color:#0D1F33;max-width:640px;margin:0 auto}
  h1{font-family:'Bebas Neue',sans-serif;font-size:40px;letter-spacing:4px;color:#1C3A5E;margin-bottom:2px}
  .sub{color:#6B8FAD;font-size:13px;margin-bottom:30px}
  .row{display:flex;gap:24px;margin-bottom:18px}
  .block{flex:1}
  .lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;margin-bottom:3px}
  .val{font-size:16px;font-weight:600;text-transform:capitalize}
  .total-box{background:#1C3A5E;color:white;padding:20px 24px;border-radius:12px;margin:24px 0;display:flex;justify-content:space-between;align-items:center}
  .t-lbl{font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:.7}
  .t-val{font-family:'Bebas Neue',sans-serif;font-size:44px;color:#E8A020}
  .narrative{background:#EDF3FA;border-radius:8px;padding:16px;font-size:13px;line-height:1.6;margin-bottom:20px;color:#2B4B6F}
  .footer{font-size:11px;color:#9ab;margin-top:30px;text-align:center}
  @media print{button{display:none!important}}
</style></head><body>
<h1>QUOTE<span style="color:#E8A020">machine</span></h1>
<div class="sub">Estimate generated ${today}</div>
<div class="row">
  <div class="block"><div class="lbl">Client</div><div class="val">${client}</div></div>
  <div class="block"><div class="lbl">Project Type</div><div class="val">${projType}</div></div>
</div>
${addr ? `<div class="row"><div class="block"><div class="lbl">Location</div><div class="val" style="text-transform:none">${addr}</div></div></div>` : ''}
<div class="row">
  <div class="block"><div class="lbl">Measurement</div><div class="val">${(area*qty).toLocaleString(undefined,{maximumFractionDigits:1})} ${unit}${qty>1?' ('+qty+'x)':''}</div></div>
  <div class="block"><div class="lbl">Rate</div><div class="val">$${price.toFixed(2)} / ${unit}</div></div>
</div>
${notes ? `<div class="row"><div class="block"><div class="lbl">Notes</div><div class="val" style="font-weight:400">${notes}</div></div></div>` : ''}
${narrative && !narrative.includes('Generating') ? `<div class="lbl" style="margin-bottom:8px">Scope of Work</div><div class="narrative">${narrative}</div>` : ''}
<div class="total-box">
  <div><div class="t-lbl">Estimated Total</div></div>
  <div class="t-val">$${total.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
</div>
<div class="footer">This is an estimate only. Final pricing subject to on-site inspection.</div>
<br><button onclick="window.print()" style="padding:12px 24px;background:#1C3A5E;color:white;border:none;border-radius:8px;font-size:15px;cursor:pointer">🖨️ Print / Save PDF</button>
</body></html>`);
  win.document.close();
}

function buildShareText(q) {
  if (q) {
    return `📋 QUOTE machine Estimate
Client: ${q.client_name}
Type: ${q.project_type.replace(/-/g,' ')}
Area: ${parseFloat(q.area).toLocaleString(undefined,{maximumFractionDigits:1})} ${unitLabel(q.unit)}${q.qty>1?' × '+q.qty:''}
Rate: $${parseFloat(q.price_per_unit).toFixed(2)}/${unitLabel(q.unit)}
${q.address ? 'Address: '+q.address : ''}
──────────────────
TOTAL: $${parseFloat(q.total).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
${q.notes ? '\nNotes: '+q.notes : ''}
Date: ${new Date(q.created_at).toLocaleDateString()}`;
  }

  const client = document.getElementById('client-name').value || 'Client';
  const projType = document.getElementById('project-type').value.replace(/-/g,' ');
  const area = getDisplayMeasurement();
  const unit = unitLabel(document.getElementById('measure-type').value);
  const qty = parseInt(document.getElementById('qty').value) || 1;
  const price = getPrice();
  const total = area * qty * price;
  const notes = document.getElementById('notes').value;

  return `📋 QUOTE machine Estimate
Client: ${client}
Type: ${projType}
Area: ${(area*qty).toLocaleString(undefined,{maximumFractionDigits:1})} ${unit}${qty>1?' × '+qty:''}
Rate: $${price.toFixed(2)}/${unit}
${lastAddress ? 'Address: '+lastAddress : ''}
──────────────────
TOTAL: $${total.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
${notes ? '\nNotes: '+notes : ''}
Date: ${new Date().toLocaleDateString()}`;
}

function openShareModal(q) {
  document.getElementById('share-text').value = buildShareText(q || null);
  openModal('share-modal');
}

function shareQuoteObj(q) { openShareModal(q); }

function copyShare() {
  const text = document.getElementById('share-text').value;
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied! 📋');
    closeModal('share-modal');
  });
}

function smsShare() {
  const text = encodeURIComponent(document.getElementById('share-text').value);
  window.open('sms:?body=' + text);
}

function emailShare() {
  const text = encodeURIComponent(document.getElementById('share-text').value);
  const subj = encodeURIComponent('Quote Estimate - QUOTE machine');
  window.open(`mailto:?subject=${subj}&body=${text}`);
}

async function exportAll() {
  try {
    const res = await fetch('/api/quotes?limit=500');
    const data = await res.json();
    const text = (data.quotes || []).map(q => buildShareText(q)).join('\n\n══════════════\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `quotes-export-${Date.now()}.txt`;
    a.click();
    showToast('Exported!');
  } catch {
    showToast('Export failed');
  }
}

// ══════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════
async function loadStats() {
  const container = document.getElementById('stats-content');
  try {
    const s = await fetch('/api/stats').then(r => r.json());
    const fmtUSD = v => '$' + parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

    let typeRows = (s.by_type || []).map(t => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--surface2)">
        <div style="font-size:13px;font-weight:600;text-transform:capitalize">${t.project_type.replace(/-/g,' ')}</div>
        <div style="text-align:right">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:18px;color:var(--accent)">${fmtUSD(t.revenue)}</div>
          <div style="font-size:10px;color:var(--text-lt)">${t.count} quote${t.count!=1?'s':''}</div>
        </div>
      </div>`).join('');

    container.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${s.total_quotes}</div><div class="stat-lbl">Total Quotes</div></div>
        <div class="stat-card"><div class="stat-val">${fmtUSD(s.total_value)}</div><div class="stat-lbl">Total Value</div></div>
        <div class="stat-card"><div class="stat-val">${fmtUSD(s.avg_quote)}</div><div class="stat-lbl">Avg Quote</div></div>
        <div class="stat-card"><div class="stat-val">${s.this_month}</div><div class="stat-lbl">This Month</div></div>
      </div>
      ${typeRows ? `<div class="section-title">By Project Type</div><div>${typeRows}</div>` : ''}
    `;
  } catch {
    container.innerHTML = '<div class="empty-state">Failed to load stats.</div>';
  }
}

// ══════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════
function showTab(tab) {
  ['quote','saved','stats'].forEach(t => {
    document.getElementById(`tab-${t}`).style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    btn.classList.toggle('active', ['quote','saved','stats'][i] === tab);
  });
  if (tab === 'saved') loadSaved();
  if (tab === 'stats') loadStats();
}

function showView(tab) { showTab(tab); }

function newQuote() {
  document.getElementById('client-name').value = '';
  document.getElementById('notes').value = '';
  document.getElementById('manual-area').value = '';
  document.getElementById('qty').value = '1';
  document.getElementById('price-dollars').value = '0';
  document.getElementById('price-cents').value = '5';
  document.getElementById('markup').value = '0';
  document.getElementById('narrative-section').style.display = 'none';
  document.getElementById('ai-price-banner').style.display = 'none';
  clearDrawing();
  showToast('New quote started!');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// Close modals on backdrop click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

// ── Panel drag (resize bottom panel)
function initPanelDrag() {
  const handle = document.getElementById('panel-drag');
  const panel = document.getElementById('bottom-panel');
  let startY, startH;

  handle.addEventListener('touchstart', e => {
    isDragging = true;
    startY = e.touches[0].clientY;
    startH = panel.offsetHeight;
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (!isDragging) return;
    const delta = startY - e.touches[0].clientY;
    const newH = Math.max(PANEL_MIN_HEIGHT, Math.min(window.innerHeight * 0.8, startH + delta));
    panel.style.maxHeight = newH + 'px';
  }, { passive: true });

  document.addEventListener('touchend', () => { isDragging = false; });
}
