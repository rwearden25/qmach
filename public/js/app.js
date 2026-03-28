// ═══════════════════════════════════════
//  QUOTE machine — Wizard UX (Phase 1)
//  Step flow: Address → Service → Measure → Price → Review
// ═══════════════════════════════════════

// ── Constants
const JOB_TYPES = [
  { id: 'pressure-washing', label: 'Pressure Washing', icon: '💦', unit: 'sqft', range: '$0.08–$0.35/sf' },
  { id: 'parking-lot-striping', label: 'Lot Striping', icon: '🅿️', unit: 'linft', range: '$0.15–$0.50/lf' },
  { id: 'sealcoating', label: 'Sealcoating', icon: '🛣️', unit: 'sqft', range: '$0.10–$0.25/sf' },
  { id: 'painting', label: 'Painting / Coating', icon: '🎨', unit: 'sqft', range: '$1.50–$4.00/sf' },
  { id: 'roofing', label: 'Roofing', icon: '🏠', unit: 'sqft', range: '$3.50–$8.00/sf' },
  { id: 'concrete', label: 'Concrete', icon: '🧱', unit: 'sqft', range: '$4.00–$12.00/sf' },
  { id: 'landscaping', label: 'Landscaping', icon: '🌿', unit: 'sqft', range: '$2.00–$6.00/sf' },
  { id: 'custom', label: 'Other / Custom', icon: '📋', unit: 'sqft', range: 'Your rate' }
];
const UNIT_LABELS = { sqft: 'sq ft', linft: 'lin ft', sqyd: 'sq yd', acre: 'acres' };
const UNIT_SHORT = { sqft: 'sf', linft: 'lf', sqyd: 'sy', acre: 'ac' };
const QUICK_PRICES = {
  'pressure-washing': [0.08, 0.12, 0.18, 0.25, 0.35],
  'parking-lot-striping': [0.15, 0.25, 0.35, 0.50],
  'sealcoating': [0.10, 0.15, 0.20, 0.25],
  'painting': [1.50, 2.00, 3.00, 4.00],
  'roofing': [3.50, 5.00, 6.50, 8.00],
  'concrete': [4.00, 6.00, 8.00, 12.00],
  'landscaping': [2.00, 3.00, 4.00, 6.00],
  'custom': [1.00, 5.00, 10.00, 25.00]
};
const STEPS = ['address', 'service', 'measure', 'price', 'review'];

// ── State
let authToken = sessionStorage.getItem('qmach_token') || '';
let mapboxToken = '';
let step = 0;
let items = [];          // completed line items [{service, area, unit, price}]
let current = { service: null, area: '', unit: 'sqft', price: '' };
let address = '';
let clientName = '';
let lastLat = null, lastLng = null;
let editingQuoteId = null;
let chatHistory = [];
let aiPriceData = null;
let debounceTimer = null;

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
  try {
    const r = await fetch('/api/auth/check', { headers: authToken ? { 'x-auth-token': authToken } : {} });
    const d = await r.json();
    if (d.valid) { hideLogin(); return true; }
  } catch {}
  showLogin();
  return false;
}

async function doLogin() {
  const btn = el('login-btn'), pw = el('login-password'), err = el('login-error');
  if (!pw.value.trim()) { err.textContent = 'Enter a password'; return; }
  btn.disabled = true; btn.textContent = 'Signing in...'; err.textContent = '';
  try {
    const r = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value.trim() }) });
    const d = await r.json();
    if (d.success) { authToken = d.token; sessionStorage.setItem('qmach_token', authToken); hideLogin(); bootApp(); }
    else { err.textContent = 'Wrong password'; pw.value = ''; pw.focus(); }
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
  document.querySelectorAll('.htab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Step nav
  on('btn-continue', onContinue);
  on('btn-back', () => goStep(step - 1));

  // Progress dot clicks
  document.querySelectorAll('.pdot').forEach(dot => {
    dot.addEventListener('click', () => {
      const s = parseInt(dot.dataset.step);
      if (s < step) goStep(s);
    });
  });

  // Address autocomplete
  const addrInput = el('inp-address');
  if (addrInput) {
    addrInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const q = addrInput.value.trim();
      if (q.length < 3) { clearAddrAutocomplete(); return; }
      debounceTimer = setTimeout(() => fetchAddrSuggestions(q), 300);
    });
    addrInput.addEventListener('keydown', e => { if (e.key === 'Escape') clearAddrAutocomplete(); });
    document.addEventListener('click', e => {
      if (!addrInput.contains(e.target) && !el('addr-autocomplete')?.contains(e.target)) clearAddrAutocomplete();
    });
  }

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

  // Map trigger (Phase 2 placeholder)
  on('btn-open-map', () => toast('Map drawing coming in Phase 2'));

  // AI price
  on('btn-ai-price', aiSuggestPrice);
  on('ai-price-dismiss', () => closeModal('ai-price-modal'));
  on('ai-price-apply', applyAiPrice);

  // Review actions
  on('btn-add-another', addAnother);
  on('btn-save-share', saveAndShare);
  on('btn-pdf', () => generatePDF());
  on('btn-ai-narrative', generateNarrative);
  on('btn-new-quote', resetQuote);

  // Share sheet
  on('share-sms', () => { closeSheet(); smsShare(); });
  on('share-email', () => { closeSheet(); emailShare(); });
  on('share-copy', () => { closeSheet(); copyShare(); });
  on('share-pdf', () => { closeSheet(); generatePDF(); });
  on('share-done', closeSheet);
  el('share-sheet')?.addEventListener('click', e => { if (e.target.id === 'share-sheet') closeSheet(); });

  // Saved tab
  el('search-quotes')?.addEventListener('input', loadSaved);
  on('btn-export', exportAll);

  // AI chat
  on('btn-ai-chat', openChat);
  on('ai-panel-close', closeChat);
  on('ai-overlay', closeChat);
  on('chat-send', sendChat);
  el('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  // PWA install
  setupInstallBanner();

  // Load mapbox token for geocoding
  try {
    const cfg = await authFetch('/api/config').then(r => r.json());
    mapboxToken = cfg.mapboxToken || '';
  } catch {}

  // Start at step 0
  goStep(0);
}

// ═══════════════════════════════════════
//  WIZARD NAVIGATION
// ═══════════════════════════════════════
function goStep(s) {
  if (s < 0 || s >= STEPS.length) return;
  step = s;

  // Show/hide steps
  document.querySelectorAll('.step').forEach((el, i) => {
    el.classList.toggle('hidden', i !== s);
    if (i === s) el.style.animation = 'none';
    if (i === s) { void el.offsetHeight; el.style.animation = ''; } // retrigger animation
  });

  // Update progress dots
  document.querySelectorAll('.pdot').forEach((dot, i) => {
    dot.classList.remove('active', 'completed');
    if (i < s) dot.classList.add('completed');
    else if (i === s) dot.classList.add('active');
  });
  document.querySelectorAll('.pline').forEach((line, i) => {
    line.classList.toggle('filled', i < s);
  });

  // Bottom action bar
  const bottomAction = el('bottom-action');
  const btnContinue = el('btn-continue');
  const btnBack = el('btn-back');

  if (s === 1 || s === 4) {
    // Service step: auto-advance, no continue. Review: has its own buttons.
    bottomAction.classList.add('hidden');
  } else {
    bottomAction.classList.remove('hidden');
    btnBack.classList.toggle('hidden', s === 0);

    if (s === 3) {
      btnContinue.textContent = 'Review Quote →';
      btnContinue.className = 'btn-primary green';
    } else {
      btnContinue.textContent = 'Continue →';
      btnContinue.className = 'btn-primary';
    }
  }

  updateContinueBtn();

  // Step-specific setup
  if (s === 2) setupMeasureStep();
  if (s === 3) setupPriceStep();
  if (s === 4) renderReview();
}

function onContinue() {
  if (step === 3) {
    // Finish current item and go to review
    items.push({ ...current });
    current = { service: null, area: '', unit: 'sqft', price: '' };
    goStep(4);
  } else if (step < STEPS.length - 1) {
    goStep(step + 1);
  }
}

function addAnother() {
  // Loop back to service selection for next item
  goStep(1);
}

function canContinue() {
  switch (step) {
    case 0: return (el('inp-address')?.value.trim().length > 3);
    case 2: return parseFloat(el('inp-area')?.value) > 0;
    case 3: return parseFloat(el('inp-price')?.value) > 0;
    default: return true;
  }
}

function updateContinueBtn() {
  const btn = el('btn-continue');
  if (btn) btn.disabled = !canContinue();
}

// ═══════════════════════════════════════
//  VIEW SWITCHING (tabs)
// ═══════════════════════════════════════
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  el('view-' + view)?.classList.add('active');
  document.querySelectorAll('.htab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'saved') loadSaved();
  if (view === 'stats') loadStats();
}

// ═══════════════════════════════════════
//  STEP 1: SERVICE LIST
// ═══════════════════════════════════════
function renderServiceList() {
  const list = el('service-list');
  if (!list) return;
  list.innerHTML = JOB_TYPES.map(job => `
    <button class="svc-row" data-id="${job.id}">
      <span class="svc-icon">${job.icon}</span>
      <div class="svc-info">
        <div class="svc-name">${job.label}</div>
        <div class="svc-range">${job.range}</div>
      </div>
      <span class="svc-arrow">›</span>
    </button>
  `).join('');

  list.querySelectorAll('.svc-row').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.id;
      const job = JOB_TYPES.find(j => j.id === id);
      current.service = id;
      current.unit = job?.unit || 'sqft';

      // Highlight
      list.querySelectorAll('.svc-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');

      // Auto-advance after 280ms
      setTimeout(() => goStep(2), 280);
    });
  });
}

// ═══════════════════════════════════════
//  STEP 2: MEASURE
// ═══════════════════════════════════════
function setupMeasureStep() {
  const unitSel = el('inp-unit');
  if (unitSel && current.unit) unitSel.value = current.unit;
  const areaInp = el('inp-area');
  if (areaInp) { areaInp.value = current.area || ''; areaInp.focus(); }
  onMeasureChange();
}

function onMeasureChange() {
  current.area = el('inp-area')?.value || '';
  current.unit = el('inp-unit')?.value || 'sqft';

  // Conversion chips
  const chips = el('conversion-chips');
  const v = parseFloat(current.area);
  if (chips && v > 0 && current.unit === 'sqft') {
    chips.innerHTML = `
      <span class="conv-chip">${(v / 9).toFixed(1)} <span style="color:var(--text-lt)">sq yd</span></span>
      <span class="conv-chip">${(v / 43560).toFixed(4)} <span style="color:var(--text-lt)">acres</span></span>
    `;
  } else if (chips) {
    chips.innerHTML = '';
  }
  updateContinueBtn();
}

// ═══════════════════════════════════════
//  STEP 3: PRICE
// ═══════════════════════════════════════
function setupPriceStep() {
  const svc = JOB_TYPES.find(j => j.id === current.service);
  const ctx = el('price-context');
  if (ctx && svc) {
    ctx.innerHTML = `
      <span class="pc-icon">${svc.icon}</span>
      <span class="pc-name">${svc.label}</span>
      <span class="pc-area">${fmtNum(current.area)} ${UNIT_SHORT[current.unit] || 'sf'}</span>
    `;
  }

  const lbl = el('price-label');
  if (lbl) lbl.textContent = `$ per ${UNIT_LABELS[current.unit] || 'unit'}`;

  // Quick prices
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

  const priceInp = el('inp-price');
  if (priceInp) { priceInp.value = current.price || ''; priceInp.focus(); }
  onPriceChange();
}

function onPriceChange() {
  current.price = el('inp-price')?.value || '';
  const area = parseFloat(current.area) || 0;
  const price = parseFloat(current.price) || 0;
  const total = area * price;

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

  // Update quick price highlights
  el('quick-prices')?.querySelectorAll('.qp-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.price === current.price);
  });

  updateContinueBtn();
}

// ═══════════════════════════════════════
//  STEP 4: REVIEW
// ═══════════════════════════════════════
function renderReview() {
  const allItems = [...items];
  // If current has data but wasn't pushed yet (editing), include it
  if (current.service && !allItems.find(i => i === current)) {
    // current was already pushed in onContinue, but check just in case
  }

  const grandTotal = allItems.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);

  el('review-total').textContent = '$' + fmtMoney(grandTotal);
  el('review-count').textContent = allItems.length + ' service' + (allItems.length !== 1 ? 's' : '');

  // Build summary card
  const card = el('review-card');
  if (!card) return;

  address = el('inp-address')?.value || '';
  clientName = el('inp-client')?.value || '';

  let html = '';
  html += rcRow('Client', clientName || '—', 0);
  html += rcRow('Address', address, 0);

  allItems.forEach((item, idx) => {
    const svc = JOB_TYPES.find(j => j.id === item.service);
    const sub = (parseFloat(item.area) || 0) * (parseFloat(item.price) || 0);
    html += `<div class="rc-item">
      <div class="rc-item-header">
        <div class="rc-item-name"><span>${svc?.icon || '📋'}</span> ${svc?.label || item.service}</div>
        <span class="rc-item-sub">$${fmtMoney(sub)}</span>
      </div>
      <div class="rc-item-detail">${fmtNum(item.area)} ${UNIT_LABELS[item.unit]} × $${item.price}/${UNIT_SHORT[item.unit]}</div>
    </div>`;
  });

  card.innerHTML = html;

  // Wire edit clicks on client/address rows
  card.querySelectorAll('.rc-row').forEach(row => {
    row.addEventListener('click', () => goStep(parseInt(row.dataset.step)));
  });
}

function rcRow(label, value, stepIdx) {
  return `<div class="rc-row" data-step="${stepIdx}">
    <span class="rc-label">${label}</span>
    <div><span class="rc-value">${esc(value)}</span><span class="rc-edit">✏️</span></div>
  </div>`;
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
        clearAddrAutocomplete();
        updateContinueBtn();
      });
      list.appendChild(item);
    });
  } catch {}
}

function clearAddrAutocomplete() {
  const list = el('addr-autocomplete');
  if (list) list.innerHTML = '';
}

function geolocateUser() {
  if (!navigator.geolocation) { toast('GPS not available'); return; }
  toast('Getting location...');
  navigator.geolocation.getCurrentPosition(async pos => {
    lastLat = pos.coords.latitude; lastLng = pos.coords.longitude;
    // Reverse geocode
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
      updateContinueBtn();
      toast('Location set 📍');
    }
  }, () => toast('Location denied'));
}

function openExternal(type) {
  const addr = el('inp-address')?.value || '';
  const lat = lastLat, lng = lastLng;
  const q = addr || (lat && lng ? `${lat},${lng}` : '');
  if (!q) { toast('Enter an address first'); return; }
  const urls = {
    maps: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
    earth: `https://earth.google.com/web/search/${encodeURIComponent(q)}`,
    street: lat && lng
      ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
  };
  window.open(urls[type], '_blank');
}

// ═══════════════════════════════════════
//  SAVE / LOAD
// ═══════════════════════════════════════
async function saveAndShare() {
  address = el('inp-address')?.value || '';
  clientName = el('inp-client')?.value || '';
  if (!clientName) { toast('Enter a client name'); goStep(0); return; }

  const allItems = [...items];
  const grandTotal = allItems.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  const primary = allItems[0] || {};
  const narrative = el('narrative-box')?.textContent || '';

  const payload = {
    client_name: clientName,
    project_type: primary.service || 'custom',
    area: parseFloat(primary.area) || 0,
    unit: primary.unit || 'sqft',
    price_per_unit: parseFloat(primary.price) || 0,
    total: grandTotal,
    qty: 1,
    notes: el('inp-notes')?.value || '',
    address: address,
    lat: lastLat, lng: lastLng,
    polygon_geojson: null,
    ai_narrative: (narrative && !narrative.includes('Writing')) ? narrative : '',
    line_items: allItems.map(i => ({
      type: i.service, area: parseFloat(i.area) || 0, unit: i.unit,
      price: parseFloat(i.price) || 0, qty: 1,
      label: JOB_TYPES.find(j => j.id === i.service)?.label || i.service,
      subtotal: (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0)
    })),
    markup: 0
  };

  try {
    let res;
    if (editingQuoteId) {
      res = await authFetch(`/api/quotes/${editingQuoteId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
    } else {
      res = await authFetch('/api/quotes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
    }
    if (!res.ok) throw new Error();
    editingQuoteId = null;
    toast('Saved! 💾');
    setTimeout(() => openSheet(), 300);
  } catch { toast('Save failed — check connection'); }
}

async function loadSaved() {
  const search = el('search-quotes')?.value || '';
  const container = el('saved-list');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">Loading...</div>';
  try {
    const res = await authFetch(`/api/quotes?search=${encodeURIComponent(search)}&limit=30`);
    const data = await res.json();
    renderSavedList(data.quotes || []);
  } catch {
    container.innerHTML = '<div class="empty-state">Failed to load.</div>';
  }
}

function renderSavedList(quotes) {
  const container = el('saved-list');
  if (!quotes.length) { container.innerHTML = '<div class="empty-state">No quotes yet.</div>'; return; }
  window._savedQuotes = {};
  quotes.forEach(q => { window._savedQuotes[q.id] = q; });

  container.innerHTML = quotes.map(q => {
    let itemsText = '';
    try {
      const li = JSON.parse(q.line_items || '[]');
      itemsText = li.map(i => (i.label || i.type || '').replace(/-/g, ' ')).join(' + ');
    } catch {}
    if (!itemsText) itemsText = (q.project_type || '').replace(/-/g, ' ');

    return `<div class="quote-card">
      <div class="qc-header">
        <div>
          <div class="qc-client">${esc(q.client_name)}</div>
          <div class="qc-meta">${itemsText}</div>
          <div class="qc-meta">${new Date(q.created_at).toLocaleDateString()}</div>
        </div>
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

  container.querySelectorAll('.mini-btn.edit').forEach(b => b.addEventListener('click', () => editQuote(b.dataset.id)));
  container.querySelectorAll('.mini-btn.load').forEach(b => b.addEventListener('click', () => loadQuote(b.dataset.id)));
  container.querySelectorAll('.mini-btn.share').forEach(b => b.addEventListener('click', () => {
    const q = window._savedQuotes[b.dataset.id];
    if (q) { buildShareTextFromQuote(q); openSheet(); }
  }));
  container.querySelectorAll('.mini-btn.del').forEach(b => b.addEventListener('click', () => deleteQuote(b.dataset.id)));
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
      // Put last item as "current", rest as completed
      lineItems.forEach((li, idx) => {
        const item = { service: li.type, area: String(li.area || 0), unit: li.unit || 'sqft', price: String(li.price || 0) };
        if (idx < lineItems.length - 1) items.push(item);
        else current = item;
      });
    } else {
      current = {
        service: q.project_type || 'custom',
        area: String(q.area || 0),
        unit: q.unit || 'sqft',
        price: String(q.price_per_unit || 0)
      };
    }

    if (q.ai_narrative) {
      el('narrative-box').textContent = q.ai_narrative;
      el('narrative-box').classList.remove('hidden');
    }

    switchView('quote');
    // Go to review with all items loaded
    if (current.service) items.push({ ...current });
    current = { service: null, area: '', unit: 'sqft', price: '' };
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
    a.download = 'quotes-' + Date.now() + '.txt';
    a.click(); toast('Exported!');
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
  if (!clientName) { toast('Enter a client name'); return; }
  const box = el('narrative-box');
  box.classList.remove('hidden');
  box.textContent = '✍️ Writing...';

  const allItems = [...items];
  const grandTotal = allItems.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  const primary = allItems[0] || {};
  const itemsSummary = allItems.map(i => {
    const label = JOB_TYPES.find(j => j.id === i.service)?.label || i.service;
    return `${label}: ${fmtNum(i.area)} ${UNIT_LABELS[i.unit]} × $${parseFloat(i.price).toFixed(2)} = $${fmtMoney((parseFloat(i.area) || 0) * (parseFloat(i.price) || 0))}`;
  }).join('\n');

  try {
    const res = await authFetch('/api/ai/generate-narrative', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        project_type: allItems.map(i => JOB_TYPES.find(j => j.id === i.service)?.label || i.service).join(' + '),
        area: primary.area || '0', unit: UNIT_LABELS[primary.unit] || 'sq ft',
        price_per_unit: primary.price || '0', total: fmtMoney(grandTotal),
        notes: (el('inp-notes')?.value || '') + '\n\nLine items:\n' + itemsSummary,
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
  el('ai-panel').classList.add('open');
  el('ai-overlay').classList.add('open');
  if (!chatHistory.length) addChatMsg('ai', 'Hi! Ask me anything about pricing, measurements, or job scoping 💡');
  setTimeout(() => el('chat-input')?.focus(), 300);
}
function closeChat() {
  el('ai-panel').classList.remove('open');
  el('ai-overlay').classList.remove('open');
}
async function sendChat() {
  const input = el('chat-input');
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
          project_type: current.service,
          area: current.area, unit: UNIT_LABELS[current.unit],
          price: current.price, address: el('inp-address')?.value || ''
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
function addChatMsg(role, text, typing = false) {
  const c = el('chat-messages'); if (!c) return '';
  const id = 'msg-' + Date.now();
  const div = document.createElement('div');
  div.id = id; div.className = `chat-msg ${role}${typing ? ' typing' : ''}`;
  div.textContent = text; c.appendChild(div); c.scrollTop = c.scrollHeight; return id;
}
function removeMsg(id) { document.getElementById(id)?.remove(); }

// ═══════════════════════════════════════
//  PDF
// ═══════════════════════════════════════
function generatePDF() {
  const allItems = [...items];
  const grandTotal = allItems.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  clientName = el('inp-client')?.value || 'Client';
  address = el('inp-address')?.value || '';
  const notes = el('inp-notes')?.value || '';
  const narrative = el('narrative-box')?.textContent || '';
  const today = new Date().toLocaleDateString();

  const itemRows = allItems.map(i => {
    const label = JOB_TYPES.find(j => j.id === i.service)?.label || i.service;
    const sub = (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0);
    return `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;font-weight:600">${label}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;text-align:right">${fmtNum(i.area)} ${UNIT_LABELS[i.unit]}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;text-align:right">$${parseFloat(i.price).toFixed(2)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #E8EEF4;text-align:right;font-weight:700">$${fmtMoney(sub)}</td>
    </tr>`;
  }).join('');

  const win = window.open('', '_blank');
  if (!win) { toast('Allow popups to print'); return; }
  win.document.write(`<!DOCTYPE html><html><head><title>Quote — ${clientName}</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{font-family:'DM Sans',sans-serif;padding:40px;color:#0D2137;max-width:700px;margin:0 auto}
table{width:100%;border-collapse:collapse;margin:16px 0}
th{text-align:left;padding:8px;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;border-bottom:2px solid #1C3A5E}
th:nth-child(n+2){text-align:right}
.total-row{background:#0D2137;color:white;padding:16px 20px;border-radius:10px;display:flex;justify-content:space-between;align-items:center;margin:20px 0}
.total-val{font-family:'Bebas Neue',sans-serif;font-size:42px;color:#E8A020}
.narrative{background:#F4F7FA;border-radius:8px;padding:16px;font-size:13px;line-height:1.8;margin:16px 0;white-space:pre-wrap}
@media print{.no-print{display:none!important}}</style></head><body>
<h1 style="font-family:'Bebas Neue',sans-serif;font-size:42px;letter-spacing:4px;color:#1C3A5E;margin:0">QUOTE<span style="color:#E8A020">machine</span></h1>
<div style="color:#6B8FAD;font-size:13px;margin-bottom:24px">Estimate · ${today}</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
  <div><div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;margin-bottom:3px">Client</div><div style="font-size:15px;font-weight:600">${clientName}</div></div>
  ${address ? `<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;margin-bottom:3px">Location</div><div style="font-size:13px">${address}</div></div>` : ''}
</div>
<table><thead><tr><th>Service</th><th>Area</th><th>Rate</th><th>Subtotal</th></tr></thead><tbody>${itemRows}</tbody></table>
<div class="total-row"><div><div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.6);font-weight:700">Estimated Total</div></div><div class="total-val">$${fmtMoney(grandTotal)}</div></div>
${notes ? `<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;margin-bottom:6px">Notes</div><div style="font-size:13px;line-height:1.6;margin-bottom:16px">${notes}</div>` : ''}
${narrative && !narrative.includes('Writing') ? `<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#6B8FAD;font-weight:700;margin-bottom:6px">Scope of Work</div><div class="narrative">${narrative}</div>` : ''}
<div style="font-size:11px;color:#9ab;margin-top:28px;text-align:center">This is an estimate. Final pricing subject to on-site inspection.</div>
<br><button class="no-print" onclick="window.print()" style="padding:12px 28px;background:#0D2137;color:white;border:none;border-radius:8px;font-size:15px;cursor:pointer">🖨️ Print / Save as PDF</button>
</body></html>`);
  win.document.close();
}

// ═══════════════════════════════════════
//  SHARE
// ═══════════════════════════════════════
function openSheet() { el('share-sheet')?.classList.add('open'); }
function closeSheet() { el('share-sheet')?.classList.remove('open'); }

function buildShareText() {
  const allItems = [...items];
  const grandTotal = allItems.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  clientName = el('inp-client')?.value || 'Client';
  address = el('inp-address')?.value || '';
  const itemsText = allItems.map(i => {
    const label = JOB_TYPES.find(j => j.id === i.service)?.label || i.service;
    return `  • ${label}: ${fmtNum(i.area)} ${UNIT_LABELS[i.unit]} × $${parseFloat(i.price).toFixed(2)} = $${fmtMoney((parseFloat(i.area) || 0) * (parseFloat(i.price) || 0))}`;
  }).join('\n');
  return `📋 QUOTE machine\nClient: ${clientName}\n${address ? 'Location: ' + address + '\n' : ''}Items:\n${itemsText}\n──────────\nTOTAL: $${fmtMoney(grandTotal)}\nDate: ${new Date().toLocaleDateString()}`;
}

function buildShareTextFromQuote(q) {
  let itemsText = '';
  try {
    const li = JSON.parse(q.line_items || '[]');
    itemsText = li.map(i => `  • ${i.label || i.type}: ${fmtNum(i.area)} ${UNIT_LABELS[i.unit] || i.unit} × $${parseFloat(i.price).toFixed(2)} = $${fmtMoney(i.subtotal || (i.area * i.price))}`).join('\n');
  } catch {}
  return `📋 QUOTE machine\nClient: ${q.client_name}\n${q.address ? 'Location: ' + q.address + '\n' : ''}Items:\n${itemsText}\n──────────\nTOTAL: $${fmtMoney(q.total)}\nDate: ${new Date(q.created_at).toLocaleDateString()}`;
}

function copyShare() {
  navigator.clipboard.writeText(buildShareText()).then(() => toast('Copied! 📋')).catch(() => toast('Copy failed'));
}
function smsShare() { window.open('sms:?body=' + encodeURIComponent(buildShareText())); }
function emailShare() { window.open(`mailto:?subject=${encodeURIComponent('Quote Estimate')}&body=${encodeURIComponent(buildShareText())}`); }

// ═══════════════════════════════════════
//  STATS
// ═══════════════════════════════════════
async function loadStats() {
  const container = el('stats-content');
  try {
    const s = await authFetch('/api/stats').then(r => r.json());
    const mu = v => '$' + parseFloat(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const rows = (s.by_type || []).map(t => `
      <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--surface2)">
        <div style="font-size:13px;font-weight:600;text-transform:capitalize">${(t.project_type || '').replace(/-/g, ' ')}</div>
        <div style="text-align:right">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:18px;color:var(--accent)">${mu(t.revenue)}</div>
          <div style="font-size:10px;color:var(--text-lt)">${t.count} quote${t.count != 1 ? 's' : ''}</div>
        </div>
      </div>`).join('');

    container.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${s.total_quotes}</div><div class="stat-lbl">Quotes</div></div>
        <div class="stat-card"><div class="stat-val">${mu(s.total_value)}</div><div class="stat-lbl">Total Value</div></div>
        <div class="stat-card"><div class="stat-val">${mu(s.avg_quote)}</div><div class="stat-lbl">Avg Quote</div></div>
        <div class="stat-card"><div class="stat-val">${s.this_month}</div><div class="stat-lbl">This Month</div></div>
      </div>
      ${rows ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--text-lt);margin:12px 0 6px">By Job Type</div><div>${rows}</div>` : ''}`;
  } catch { container.innerHTML = '<div class="empty-state">Failed to load stats.</div>'; }
}

// ═══════════════════════════════════════
//  RESET
// ═══════════════════════════════════════
function resetQuote() {
  step = 0; items = [];
  current = { service: null, area: '', unit: 'sqft', price: '' };
  editingQuoteId = null;
  el('inp-address').value = '';
  el('inp-client').value = '';
  el('inp-notes').value = '';
  el('inp-area').value = '';
  el('inp-price').value = '';
  el('narrative-box').classList.add('hidden');
  el('narrative-box').textContent = '';
  // Deselect service
  document.querySelectorAll('.svc-row').forEach(r => r.classList.remove('selected'));
  goStep(0);
  toast('New quote started');
}

// ═══════════════════════════════════════
//  UI HELPERS
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
//  PWA INSTALL
// ═══════════════════════════════════════
function setupInstallBanner() {
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferredPrompt = e;
    if (sessionStorage.getItem('qmach_install_dismissed')) return;
    el('install-banner').style.display = 'flex';
  });
  on('install-btn', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    el('install-banner').style.display = 'none';
  });
  on('install-dismiss', () => {
    el('install-banner').style.display = 'none';
    sessionStorage.setItem('qmach_install_dismissed', '1');
  });
  window.addEventListener('appinstalled', () => {
    el('install-banner').style.display = 'none';
    deferredPrompt = null;
  });
}
