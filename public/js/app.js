// ═══════════════════════════════════════
//  pquote — Phase 1+2 (all bugs fixed)
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
let currentUserId = '';
let mapboxToken = '';
let pzipEnabled = false;
let billingConfigured = false; // set by fetchPublicConfigPreLogin() pre-signup
let step = 0;
let items = [];                // completed line items [{service, area, unit, price}]
let current = { service: null, area: '', unit: 'sqft', price: '' };
let address = '', clientName = '', lastLat = null, lastLng = null;
let editingQuoteId = null, chatHistory = [], aiPriceData = null, debounceTimer = null;
let map = null, mapReady = false, drawPoints = [];
let drawnPolygonGeoJSON = null, drawnAreaSqMeters = 0;
let targetMarker = null; // mapbox pin at the geocoded address — tells the user *which house* on dense residential blocks

// ═══════════════════════════════════════
//  SUPABASE (Google OAuth)
// ═══════════════════════════════════════
const SUPABASE_URL = 'https://ywqidkugtavzqqhehppg.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3cWlka3VndGF2enFxaGVocHBnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4MDI2NjMsImV4cCI6MjA5MDM3ODY2M30.ULTGwCFcukaU2SuKeM9OtdOI5pFV3wln_mz1zvRVQiQ';
let supabaseClient = null;

function getSupabase() {
  if (!supabaseClient && window.supabase?.createClient) {
    try { supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON); } catch {}
  }
  return supabaseClient;
}

async function googleSignIn() {
  const sb = getSupabase();
  if (!sb) { toast('Google sign-in unavailable — try refreshing'); return; }
  const btn = el('btn-google');
  if (btn) { btn.disabled = true; btn.textContent = 'Redirecting...'; }
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/app' }
    });
    if (error) throw error;
  } catch (err) {
    console.error('Google sign-in error:', err);
    toast('Google sign-in failed');
    if (btn) { btn.disabled = false; btn.innerHTML = 'Sign in with Google'; }
  }
}

async function handleOAuthCallback() {
  const sb = getSupabase();
  if (!sb) return false;
  try {
    // Race against a 8-second timeout
    const sessionPromise = sb.auth.getSession();
    const timeoutPromise = new Promise(r => setTimeout(() => r({ data: { session: null } }), 8000));
    const { data: { session } } = await Promise.race([sessionPromise, timeoutPromise]);
    if (!session) return false;

    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: session.access_token,
        email: session.user?.email,
        name: session.user?.user_metadata?.full_name || session.user?.email
      })
    });
    const data = await res.json();
    if (data.success) {
      authToken = data.token;
      currentUserId = data.userId || '';
      sessionStorage.setItem('qmach_token', authToken);
      if (data.userName) sessionStorage.setItem('qmach_user_name', data.userName);
      if (window.location.hash) history.replaceState(null, '', window.location.pathname);
      return true;
    }
  } catch (err) {
    console.error('OAuth callback error:', err);
  }
  return false;
}

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
    if (d.valid) {
      currentUserId = d.userId || '';
      if (d.userName) sessionStorage.setItem('qmach_user_name', d.userName);
      hideLogin();
      return true;
    }
  } catch {}
  showLogin(); return false;
}

async function doLogin() {
  const btn = el('login-btn'), emailInput = el('login-email'), pw = el('login-password'), err = el('login-error');
  const email = (emailInput?.value || '').trim();
  const password = pw?.value || '';
  if (!email) { err.textContent = 'Enter your email'; emailInput?.focus(); return; }
  if (!password) { err.textContent = 'Enter your password'; pw?.focus(); return; }
  btn.disabled = true; btn.textContent = 'Signing in...'; err.textContent = '';
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.success) {
      authToken = d.token;
      currentUserId = d.userId || '';
      sessionStorage.setItem('qmach_token', authToken);
      if (d.userName) sessionStorage.setItem('qmach_user_name', d.userName);
      hideLogin(); bootApp();
    } else {
      err.textContent = d.error || 'Wrong email or password';
      pw.value = ''; pw.focus();
    }
  } catch { err.textContent = 'Connection error'; }
  btn.disabled = false; btn.textContent = 'Sign In';
}

async function doSignup() {
  const btn = el('signup-btn');
  const first = el('signup-first'), last = el('signup-last');
  const emailInput = el('signup-email'), pw = el('signup-password'), err = el('signup-error');
  const firstName = (first?.value || '').trim();
  const lastName  = (last?.value  || '').trim();
  const email     = (emailInput?.value || '').trim();
  const password  = pw?.value || '';

  if (!firstName) { err.textContent = 'Enter your first name'; first?.focus(); return; }
  if (!lastName)  { err.textContent = 'Enter your last name';  last?.focus();  return; }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Enter a valid email'; emailInput?.focus(); return; }
  if (password.length < 8 || password.length > 72
      || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    err.textContent = 'Password must be 8–72 chars with an uppercase letter, a number, and a special character';
    pw?.focus();
    return;
  }

  // Plan choice — radio defaults to 'pro' when picker is visible (billing
  // configured), and is irrelevant otherwise.
  const selectedPlan = document.querySelector('input[name="signup-plan"]:checked')?.value || 'free';
  const wantsPro = selectedPlan === 'pro' && billingConfigured;

  btn.disabled = true;
  btn.textContent = wantsPro ? 'Creating account…' : 'Creating...';
  err.textContent = '';
  try {
    const r = await fetch('/api/auth/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ first_name: firstName, last_name: lastName, email, password })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.success) {
      err.textContent = d.error || 'Signup failed';
      btn.disabled = false; btn.textContent = 'Create Account';
      return;
    }

    authToken = d.token;
    currentUserId = d.userId || '';
    sessionStorage.setItem('qmach_token', authToken);
    if (d.userName) sessionStorage.setItem('qmach_user_name', d.userName);

    if (wantsPro) {
      // Chain straight to Stripe Checkout. return_to='app' lands the user
      // in /app?subscribed=1 after pay, not the standalone billing receipt.
      btn.textContent = 'Opening checkout…';
      try {
        const cr = await fetch('/api/billing/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-auth-token': authToken },
          body: JSON.stringify({ return_to: 'app' }),
        });
        const cd = await cr.json().catch(() => ({}));
        if (cr.ok && cd.url) {
          location.href = cd.url; // hand off to Stripe — no need to clear UI
          return;
        }
        // Checkout failed but account is created. Drop into the app and
        // surface a soft nudge — they can upgrade later from /billing.
        err.textContent = 'Account created. Couldn’t open checkout — you can upgrade from /billing.';
        hideLogin(); bootApp();
      } catch {
        err.textContent = 'Account created, but checkout connection failed. Upgrade from /billing when ready.';
        hideLogin(); bootApp();
      }
      return;
    }

    // Free signup — straight into the app.
    hideLogin(); bootApp();
  } catch {
    err.textContent = 'Connection error';
    btn.disabled = false; btn.textContent = 'Create Account';
  }
}

function showSignup() {
  el('auth-signin')?.classList.add('hidden');
  el('auth-signup')?.classList.remove('hidden');
  el('signup-first')?.focus();
  syncSignupPlanPicker();
}

// Reveal the plan picker only when Stripe is wired server-side. Called from
// showSignup() and from fetchPublicConfigPreLogin() once config arrives.
function syncSignupPlanPicker() {
  const picker = el('signup-plan-picker');
  if (!picker) return;
  picker.classList.toggle('hidden', !billingConfigured);
}

// Pre-login fetch of /api/config — populates billingConfigured (and could
// populate other public fields in the future) so the signup form can show
// the right options before the user authenticates.
async function fetchPublicConfigPreLogin() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) return;
    const cfg = await r.json();
    billingConfigured = !!cfg.billingConfigured;
    syncSignupPlanPicker();
  } catch { /* server unreachable — picker stays hidden, user gets free signup */ }
}
function showSignin() {
  el('auth-signup')?.classList.add('hidden');
  el('auth-signin')?.classList.remove('hidden');
  el('login-email')?.focus();
}

async function doLogout() {
  // Kill the server-side session first — if we cleared the token locally
  // before telling the server, a stolen copy would stay valid until the
  // 24h TTL expired. Best-effort; a dead network shouldn't block logout.
  if (authToken) {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-auth-token': authToken }
      });
    } catch {}
  }
  const sb = getSupabase();
  if (sb) { try { await sb.auth.signOut(); } catch {} }
  try { clearDraft(); } catch {}
  sessionStorage.removeItem('qmach_token');
  sessionStorage.removeItem('qmach_user_name');
  authToken = '';
  currentUserId = '';
  chatHistory = [];
  // Send the user to the home page (landing) on sign-out instead of the
  // in-app login form. Cleaner mental model: signing out = leaving the app.
  // The landing page has a "Sign in" link if they want to come back.
  window.location.href = '/';
}

// ═══════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // Non-blocking — picker will reveal as soon as config returns.
  fetchPublicConfigPreLogin();
  on('login-btn', doLogin);
  on('btn-google', googleSignIn);
  on('signup-btn', doSignup);
  el('show-signup')?.addEventListener('click', e => { e.preventDefault(); showSignup(); });
  el('show-signin')?.addEventListener('click', e => { e.preventDefault(); showSignin(); });
  el('login-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') el('login-password')?.focus(); });
  el('login-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  ['signup-first','signup-last','signup-email'].forEach(id =>
    el(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const order=['signup-first','signup-last','signup-email','signup-password']; const next=order[order.indexOf(id)+1]; el(next)?.focus(); } })
  );
  el('signup-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSignup(); });

  // Only check for OAuth callback when URL has auth tokens (returning from Google)
  const hasOAuthTokens = window.location.hash && window.location.hash.includes('access_token');
  if (hasOAuthTokens) {
    const oauthSuccess = await handleOAuthCallback();
    if (oauthSuccess) { hideLogin(); bootApp(); return; }
  }

  if (await checkAuth()) bootApp();
});

async function bootApp() {
  el('app-shell').classList.remove('hidden');
  renderServiceList();

  // Signup → Pro return path: Stripe sent the user to /app?subscribed=1.
  // Show a welcoming toast and clear the param so a refresh doesn't repeat
  // it. (Webhook updates users.plan to 'pro' in the background — the
  // setupBillingPill() call below will reflect that within a few seconds.)
  if (new URLSearchParams(location.search).get('subscribed') === '1') {
    toast('Welcome to Pro 🎉 Your subscription is active.');
    history.replaceState(null, '', location.pathname);
  }

  // Header tabs
  document.querySelectorAll('.htab').forEach(btn =>
    btn.addEventListener('click', () => switchView(btn.dataset.view))
  );
  setupSettingsMenu();

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
      updateContinueBtn();
      saveDraft();
      clearTimeout(debounceTimer);
      const q = addrInput.value.trim();
      if (q.length < 3) { clearAddrAC(); return; }
      debounceTimer = setTimeout(() => fetchAddrSuggestions(q), 300);
    });
    addrInput.addEventListener('keydown', e => { if (e.key === 'Escape') clearAddrAC(); });
    document.addEventListener('click', e => {
      if (!addrInput.contains(e.target) && !el('addr-autocomplete')?.contains(e.target)) clearAddrAC();
    });
    // Geocode on blur if the user typed an address but never clicked a
    // suggestion — otherwise lastLat/lng stay stale from a previous query
    // and the quote gets saved with the wrong coordinates.
    addrInput.addEventListener('blur', () => {
      const q = addrInput.value.trim();
      if (q.length < 5) return;
      // If we already have coords and the input hasn't changed substantively,
      // no need to re-geocode.
      if (lastLat && lastLng && addrInput.dataset.geocodedFor === q) return;
      geocodeAddressToCoords(q);
    });
  }

  // ── FIX: Client input also triggers Continue check + client autocomplete
  const clientInput = el('inp-client');
  if (clientInput) {
    clientInput.addEventListener('input', () => {
      updateContinueBtn();
      showClientAC(clientInput.value.trim());
      saveDraft();
    });
    clientInput.addEventListener('keydown', e => { if (e.key === 'Escape') { const l = el('client-autocomplete'); if (l) l.innerHTML = ''; } });
    document.addEventListener('click', e => {
      if (!clientInput.contains(e.target) && !el('client-autocomplete')?.contains(e.target)) {
        const l = el('client-autocomplete'); if (l) l.innerHTML = '';
      }
    });
  }

  // Quick buttons
  on('btn-gps', geolocateUser);
  on('btn-gmaps', () => openExternal('maps'));
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

  // Tax selector — remember last rate
  const taxSel = el('inp-tax');
  if (taxSel) {
    taxSel.value = getTaxRate();
    taxSel.addEventListener('change', () => {
      saveTaxRate(parseFloat(taxSel.value) || 0);
      updateTaxSummary();
      haptic(8);
    });
  }

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

  // Collapsible headers on the review step — inline onclick= is blocked by
  // Helmet's script-src-attr 'none', so wire listeners here instead.
  document.querySelectorAll('.collapse-header').forEach(h => {
    h.addEventListener('click', () => toggleSection(h));
  });

  setupInstallBanner();
  setupTipsStrip();
  setupAiHint();
  setupBillingPill();

  try {
    const cfg = await authFetch('/api/config').then(r => r.json());
    mapboxToken = cfg.mapboxToken || '';
    pzipEnabled = !!cfg.pzipEnabled;
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

  // Check for saved draft
  const draft = loadDraft();
  if (draft && (draft.items?.length > 0 || draft.step > 0 || draft.address || draft.clientName)) {
    if (confirm('You have an unsaved quote in progress. Resume where you left off?')) {
      restoreDraft(draft);
    } else {
      clearDraft();
      goStep(0);
    }
  } else {
    goStep(0);
  }
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
    setTimeout(() => {
      map.flyTo({ center: [lastLng, lastLat], zoom: 19, speed: 2 });
      setTargetMarker(lastLng, lastLat);
    }, 100);
  }
}

// Drops (or repositions) a single pin at the geocoded target address. Without
// this, opening the map on a residential cul-de-sac centered the
// view across five candidate houses with no indication which one was the
// quote target. The marker is intentionally bright (Mapbox default red) so
// it shows up against any roof color in satellite-streets-v12 imagery.
function setTargetMarker(lng, lat) {
  if (!map || !mapReady) return;
  if (targetMarker) {
    targetMarker.setLngLat([lng, lat]);
    return;
  }
  // mapboxgl global is loaded by the same script tag that loads the
  // satellite tiles, so it's available by the time setTargetMarker runs.
  if (typeof mapboxgl === 'undefined') return;
  targetMarker = new mapboxgl.Marker({ color: '#E03131' }) // strong red, max contrast on green/gray rooftops
    .setLngLat([lng, lat])
    .addTo(map);
}
function clearTargetMarker() {
  if (targetMarker) { try { targetMarker.remove(); } catch {} targetMarker = null; }
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
    if (lastLat && lastLng) {
      map.flyTo({ center: [lastLng, lastLat], zoom: 19 });
      // Drop the target-address pin once the map is actually ready. The
      // openMapOverlay() call also tries this, but on first open the map
      // hasn't loaded yet and setTargetMarker bails — this is the catch-up.
      setTargetMarker(lastLng, lastLat);
    }
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
  haptic(20);
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

  // Auto-save draft
  saveDraft();
}

function onContinue() {
  if (step === 3) {
    // Finish current item → push to items → go to review
    if (current.service && current.price) savePrice(current.service, current.price);
    // Bundle the drawn polygon (if any) with the line item so multi-service
    // quotes don't all share one polygon from whichever service drew last.
    items.push({ ...current, polygon: drawnPolygonGeoJSON });
    current = { service: null, area: '', unit: 'sqft', price: '' };
    drawnPolygonGeoJSON = null;
    drawnAreaSqMeters = 0;
    haptic(15);
    goStep(4);
  } else if (step < 4) {
    haptic(8);
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
      const serviceChanged = current.service !== id;
      current.service = id;
      current.unit = job?.unit || 'sqft';
      // Pre-fill remembered price — but only if service changed or no price set
      if (serviceChanged || !current.price) {
        const remembered = getSavedPrice(id);
        if (remembered) current.price = remembered;
      }
      list.querySelectorAll('.svc-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      haptic(12);
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
  saveDraft();
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
        haptic(8);
        onPriceChange();
      });
    });
  }

  const pi = el('inp-price');
  if (pi) {
    // Use remembered price if available and no price set yet
    if (!current.price && current.service) {
      const remembered = getSavedPrice(current.service);
      if (remembered) current.price = remembered;
    }
    pi.value = current.price || '';
    pi.focus();
  }
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
  saveDraft();
}

// ═══════════════════════════════════════
//  STEP 4: REVIEW
// ═══════════════════════════════════════
function renderReview() {
  // Reset collapse sections — open all except those with data-default="closed"
  document.querySelectorAll('#step-4 .collapse-section').forEach(s => {
    if (s.dataset.default !== 'closed') s.classList.add('open');
  });

  const all = [...items];
  const subtotal = all.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);

  // Tax rate on the select is authoritative here — set by resetQuote (user default)
  // on new quotes and by loadQuote (saved rate) on loads. Do not overwrite it.
  const { rate, taxAmount, total } = calcTax(subtotal);

  el('review-total').textContent = '$' + fmtMoney(total);
  el('review-count').textContent = all.length + ' service' + (all.length !== 1 ? 's' : '') + (rate > 0 ? ` + ${rate}% tax` : '');

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
    // svc.label/icon come from the hardcoded JOB_TYPES table — safe. The
    // fallbacks (item.service, item.price) originate from saved quote rows
    // and could in theory contain HTML if crafted via the API directly, so
    // they go through esc() before landing in innerHTML.
    html += `<div class="rc-item" style="cursor:pointer" data-item-idx="${idx}">
      <div class="rc-item-header">
        <div class="rc-item-name"><span>${svc?.icon || '📋'}</span> ${svc?.label || esc(item.service)}</div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="rc-item-sub">$${fmtMoney(sub)}</span>
          <span class="rc-edit" data-edit-idx="${idx}" style="cursor:pointer;font-size:14px">✏️</span>
          ${all.length > 1 ? `<span data-remove-idx="${idx}" style="cursor:pointer;font-size:14px;color:#DC2626">✕</span>` : ''}
        </div>
      </div>
      <div class="rc-item-detail">${fmtNum(item.area)} ${UNIT_LABELS[item.unit] || ''} × $${esc(item.price)}/${UNIT_SHORT[item.unit] || ''}</div>
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

  updateTaxSummary();
}

function updateTaxSummary() {
  const all = [...items];
  const subtotal = all.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  const { rate, taxAmount, total } = calcTax(subtotal);

  // Update hero total
  el('review-total').textContent = '$' + fmtMoney(total);
  el('review-count').textContent = all.length + ' service' + (all.length !== 1 ? 's' : '') + (rate > 0 ? ` + ${rate}% tax` : '');

  // Update tax breakdown
  const summary = el('tax-summary');
  if (summary) {
    if (rate > 0) {
      summary.innerHTML = `
        <div class="tax-line"><span>Subtotal</span><span>$${fmtMoney(subtotal)}</span></div>
        <div class="tax-line"><span>Tax (${rate}%)</span><span>$${fmtMoney(taxAmount)}</span></div>
        <div class="tax-line total"><span>Total</span><span>$${fmtMoney(total)}</span></div>`;
    } else {
      summary.innerHTML = '';
    }
  }
}

function rcRow(label, value, stepIdx) {
  return `<div class="rc-row" data-step="${stepIdx}">
    <span class="rc-label">${label}</span>
    <div><span class="rc-value">${esc(value)}</span><span class="rc-edit">✏️</span></div>
  </div>`;
}

function editItem(idx) {
  if (idx < 0 || idx >= items.length) return;
  const item = items[idx];
  // Pull scalar fields into current (strip polygon so it doesn't get
  // re-pushed on top of the explicit bundling in onContinue).
  current = { service: item.service, area: item.area, unit: item.unit, price: item.price };
  drawnPolygonGeoJSON = item.polygon || null;
  drawnAreaSqMeters = drawnPolygonGeoJSON ? polygonToSqm(drawnPolygonGeoJSON) : 0;
  items.splice(idx, 1);
  // Refresh the measure-result display so Step 2 shows the restored polygon
  // instead of whatever the previous edit left behind.
  if (drawnAreaSqMeters > 0) {
    const sqft = drawnAreaSqMeters * 10.7639;
    el('mr-value').textContent = fmtNum(sqft);
    el('mr-unit').textContent = 'sq ft';
  }
  goStep(1);
}

function polygonToSqm(poly) {
  if (!poly?.coordinates?.[0]) return 0;
  try { return polygonAreaSqMeters(poly.coordinates[0]); } catch { return 0; }
}

function parseGeoJSON(v) {
  if (!v) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
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
        const input = el('inp-address');
        input.value = f.place_name;
        input.dataset.geocodedFor = f.place_name;
        lastLat = f.center[1]; lastLng = f.center[0];
        clearAddrAC();
        updateContinueBtn();
      });
      list.appendChild(item);
    });
  } catch {}
}

function clearAddrAC() { const l = el('addr-autocomplete'); if (l) l.innerHTML = ''; }

async function geocodeAddressToCoords(q) {
  if (!mapboxToken || !q) return;
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&limit=1&country=US`;
    const data = await fetch(url).then(r => r.json());
    const f = data.features?.[0];
    if (f && Array.isArray(f.center)) {
      lastLng = f.center[0];
      lastLat = f.center[1];
      const input = el('inp-address');
      if (input) input.dataset.geocodedFor = q;
    }
  } catch {}
}

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
  // Prefer coordinates over the address string. Mapbox geocodes US addresses
  // to rooftop accuracy; passing the precise coords to Google Maps drops a
  // pin EXACTLY on the house, instead of letting Google re-geocode the
  // address and potentially land the pin in the middle of the cul-de-sac
  // (which was the previous behavior — bad UX on dense residential blocks).
  const addr = el('inp-address')?.value || '';
  const haveCoords = !!(lastLat && lastLng);
  const coordsStr  = haveCoords ? `${lastLat},${lastLng}` : '';
  const q = coordsStr || addr;
  if (!q) { toast('Enter an address first'); return; }
  const urls = {
    maps:   `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
    street: haveCoords
      ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lastLat},${lastLng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
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

  const subtotal = all.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  const { rate, taxAmount, total: gt } = calcTax(subtotal);
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
    // Top-level polygon kept for legacy single-service reads; mirrors the
    // first line item's polygon. The per-item polygon below is the truth.
    polygon_geojson: all[0]?.polygon || null,
    ai_narrative: (narrative && !narrative.includes('Writing')) ? narrative : '',
    line_items: all.map(i => ({
      type: i.service,
      area: parseFloat(i.area) || 0,
      unit: i.unit,
      price: parseFloat(i.price) || 0,
      qty: 1,
      label: JOB_TYPES.find(j => j.id === i.service)?.label || i.service,
      subtotal: (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0),
      polygon: i.polygon || null
    })),
    markup: 0,
    tax_rate: rate
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
    // Save client to memory for future autocomplete
    saveClient(clientName, address, lastLat, lastLng);
    // Clear draft — quote is saved
    clearDraft();
    // Show success animation, then share sheet
    showSuccess(() => openSheet());
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
        <div class="qc-meta">${esc(itemsText)}</div>
        <div class="qc-meta">${new Date(q.created_at).toLocaleDateString()}</div></div>
        <div class="qc-total">$${fmtMoney(q.total)}</div>
      </div>
      ${q.address ? `<div class="qc-meta">📍 ${esc(q.address.split(',').slice(0, 2).join(','))}</div>` : ''}
      <div class="qc-actions">
        <button class="mini-btn edit" data-id="${q.id}">✏️ Edit</button>
        <button class="mini-btn load" data-id="${q.id}">Load</button>
        <button class="mini-btn share" data-id="${q.id}">Share</button>
        ${pzipEnabled ? `<button class="mini-btn pzip" data-id="${q.id}">📤 Send to pzip</button>` : ''}
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
  c.querySelectorAll('.mini-btn.pzip').forEach(b => b.addEventListener('click', () => sendQuoteToPzip(b.dataset.id, b)));
  c.querySelectorAll('.mini-btn.del').forEach(b => b.addEventListener('click', () => deleteQuote(b.dataset.id)));
}

async function sendQuoteToPzip(id, btn) {
  const orig = btn ? btn.textContent : '';
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    const res = await authFetch(`/api/quotes/${id}/send-to-pzip`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Send failed');
    // Three response shapes from pzip:
    //   refreshed:true  → existing draft was updated in place (same id/link)
    //   duplicate:true  → finalized invoice (sent/paid/void) — pzip refused to mutate
    //   neither         → fresh invoice created
    const msg = data.refreshed
      ? `Invoice ${data.invoice_num} refreshed on pzip ↻`
      : data.duplicate
      ? `Already finalized (invoice ${data.invoice_num}) — pzip kept it as-is`
      : `Sent to pzip as ${data.invoice_num} ✓`;
    toast(msg);
    if (data.view_url && confirm(msg + '\n\nOpen the invoice now?')) {
      window.open(data.view_url, '_blank');
    }
  } catch (e) {
    toast('Send failed: ' + (e.message || 'unknown'));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
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

    // Legacy quotes carry polygon at the top level; attribute it to item 0.
    const legacyPoly = parseGeoJSON(q.polygon_geojson);

    if (lineItems.length > 0) {
      lineItems.forEach((li, idx) => {
        items.push({
          service: li.type, area: String(li.area || 0),
          unit: li.unit || 'sqft', price: String(li.price || 0),
          polygon: li.polygon || (idx === 0 ? legacyPoly : null)
        });
      });
    } else {
      items.push({
        service: q.project_type || 'custom', area: String(q.area || 0),
        unit: q.unit || 'sqft', price: String(q.price_per_unit || 0),
        polygon: legacyPoly
      });
    }

    current = { service: null, area: '', unit: 'sqft', price: '' };
    drawnPolygonGeoJSON = null;
    drawnAreaSqMeters = 0;

    // Restore the tax rate this quote was saved with (not the user's current default).
    el('inp-tax').value = q.tax_rate != null ? String(q.tax_rate) : '0';

    if (q.ai_narrative) {
      el('narrative-box').textContent = q.ai_narrative;
      el('narrative-box').classList.remove('hidden');
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
// Pull the user's branding (business name + logo data-URI) once per page
// session and cache it. Free users return null. Server-side has_logo is the
// authoritative signal; we still fetch the binary because jsPDF/popup needs
// it inline.
let _brandingCache = undefined; // undefined = not fetched; null = no branding; object = data
async function getBranding() {
  if (_brandingCache !== undefined) return _brandingCache;
  try {
    const r = await authFetch('/api/account');
    if (!r.ok) { _brandingCache = null; return null; }
    const acct = await r.json();
    if (acct.plan !== 'pro') { _brandingCache = null; return null; }
    let logoDataUri = null;
    if (acct.has_logo) {
      try {
        const lr = await authFetch('/api/account/logo');
        if (lr.ok) {
          const blob = await lr.blob();
          logoDataUri = await new Promise(res => {
            const reader = new FileReader();
            reader.onload = () => res(reader.result);
            reader.onerror = () => res(null);
            reader.readAsDataURL(blob);
          });
        }
      } catch {}
    }
    _brandingCache = {
      business_name: acct.business_name || '',
      logo_data_uri: logoDataUri,
    };
    return _brandingCache;
  } catch { _brandingCache = null; return null; }
}

async function generatePDF() {
  // Open the window SYNCHRONOUSLY in response to the user gesture — if we
  // await first, Chrome/Safari popup-block the later window.open() call.
  // Write a loading placeholder, then await branding, then overwrite with
  // the real document.
  const win = window.open('', '_blank');
  if (!win) { toast('Allow popups to print'); return; }
  try {
    win.document.write('<!DOCTYPE html><html><head><title>Preparing quote…</title><style>body{font-family:system-ui,sans-serif;padding:60px;color:#4E4C46;text-align:center;background:#F2F0EB}</style></head><body><div>Building your quote…</div></body></html>');
  } catch {}

  const branding = await getBranding();
  const all = [...items];
  const subtotal = all.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  const { rate, taxAmount, total: gt } = calcTax(subtotal);
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

  const taxHtml = rate > 0 ? `
    <div style="display:flex;justify-content:space-between;padding:6px 20px;font-size:14px;color:#4E4C46;font-family:'DM Mono',monospace">
      <span>Subtotal</span><span>$${fmtMoney(subtotal)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:6px 20px;font-size:14px;color:#4E4C46;font-family:'DM Mono',monospace">
      <span>Tax (${rate}%)</span><span>$${fmtMoney(taxAmount)}</span></div>` : '';

  // Branded header for Pro users with a logo or business name on file;
  // falls back to the pquote wordmark for everyone else.
  const hasBrand = !!(branding && (branding.logo_data_uri || branding.business_name));
  const headerHtml = hasBrand
    ? `<div style="display:flex;align-items:center;gap:18px;margin-bottom:6px">
         ${branding.logo_data_uri
           ? `<img src="${branding.logo_data_uri}" alt="" style="max-height:64px;max-width:160px;object-fit:contain">`
           : ''}
         ${branding.business_name
           ? `<h1 style="font-family:'Playfair Display',serif;font-size:30px;font-weight:700;color:#2A2824;margin:0;letter-spacing:-.5px">${branding.business_name}</h1>`
           : ''}
       </div>
       <div style="color:#4E4C46;font-size:12px;margin-bottom:24px;font-family:'DM Mono',monospace;letter-spacing:.5px">
         Estimate · ${today} · <span style="color:#8A877E">prepared via pquote.ai</span>
       </div>`
    : `<h1 style="font-family:'Playfair Display',serif;font-size:36px;font-weight:700;color:#2A2824;margin:0">p<span style="color:#3A5E30">quote</span></h1>
       <div style="color:#4E4C46;font-size:13px;margin-bottom:24px;font-family:'DM Mono',monospace">Estimate · ${today}</div>`;

  // Reset the placeholder before writing the real document.
  try { win.document.open(); } catch {}
  win.document.write(`<!DOCTYPE html><html><head><title>Quote — ${clientName}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700;800&family=Nunito:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{font-family:'Nunito',sans-serif;padding:40px;color:#2A2824;max-width:700px;margin:0 auto;background:#F2F0EB}
table{width:100%;border-collapse:collapse;margin:16px 0}
th{text-align:left;padding:8px;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#4E4C46;font-weight:500;border-bottom:2px solid #2A2824;font-family:'DM Mono',monospace}
th:nth-child(n+2){text-align:right}
.total-box{background:#2A2824;color:white;padding:16px 20px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin:8px 0 20px}
.total-val{font-family:'Playfair Display',serif;font-size:42px;font-weight:800;color:#E0EDDA}
.narr{background:#E4E2DA;border-radius:8px;padding:16px;font-size:13px;line-height:1.8;margin:16px 0;white-space:pre-wrap}
.lbl{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#4E4C46;font-weight:500;margin-bottom:3px;font-family:'DM Mono',monospace}
.disc{font-size:9px;color:#A8A49A;line-height:1.5;margin-top:20px;padding:10px 12px;background:#E4E2DA;border-radius:6px;font-family:'DM Mono',monospace}
@media print{.noprint{display:none!important}body{background:white}}</style></head><body>
${headerHtml}
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
  <div><div class="lbl">Client</div><div style="font-size:15px;font-weight:600">${clientName}</div></div>
  ${address ? `<div><div class="lbl">Location</div><div style="font-size:13px">${address}</div></div>` : ''}
</div>
<table><thead><tr><th>Service</th><th>Area</th><th>Rate</th><th>Subtotal</th></tr></thead><tbody>${rows}</tbody></table>
${taxHtml}
<div class="total-box"><div class="lbl" style="color:rgba(255,255,255,.5)">Estimated Total${rate > 0 ? ' (incl. tax)' : ''}</div><div class="total-val">$${fmtMoney(gt)}</div></div>
${notes ? `<div class="lbl" style="margin-bottom:6px">Notes</div><div style="font-size:13px;line-height:1.6;margin-bottom:16px">${notes}</div>` : ''}
${narrative && !narrative.includes('Writing') ? `<div class="lbl" style="margin-bottom:6px">Scope of Work</div><div class="narr">${narrative}</div>` : ''}
<div class="disc">${DISCLAIMER}</div>
<br><button class="noprint" id="print-btn" style="padding:12px 28px;background:#3A5E30;color:white;border:none;border-radius:6px;font-size:15px;cursor:pointer;font-family:'DM Mono',monospace">🖨️ Print / Save as PDF</button></body></html>`);
  win.document.close();
  // Inline onclick="" would be blocked by the opener's CSP (script-src-attr 'none').
  // Attach the listener from the parent frame instead — same-origin so this works.
  try {
    const printBtn = win.document.getElementById('print-btn');
    if (printBtn) printBtn.addEventListener('click', () => win.print());
  } catch {}
}

// ═══════════════════════════════════════
//  SHARE
// ═══════════════════════════════════════
function openSheet() { el('share-sheet')?.classList.add('open'); }
function closeSheet() { el('share-sheet')?.classList.remove('open'); }

function buildShareText() {
  const all = [...items];
  const subtotal = all.reduce((s, i) => s + (parseFloat(i.area) || 0) * (parseFloat(i.price) || 0), 0);
  const { rate, taxAmount, total: gt } = calcTax(subtotal);
  clientName = el('inp-client')?.value || 'Client';
  address = el('inp-address')?.value || '';
  const it = all.map(i => {
    const l = JOB_TYPES.find(j => j.id === i.service)?.label || i.service;
    return `  • ${l}: ${fmtNum(i.area)} ${UNIT_LABELS[i.unit]} × $${parseFloat(i.price).toFixed(2)} = $${fmtMoney((parseFloat(i.area) || 0) * (parseFloat(i.price) || 0))}`;
  }).join('\n');
  const taxLine = rate > 0 ? `Subtotal: $${fmtMoney(subtotal)}\nTax (${rate}%): $${fmtMoney(taxAmount)}\n` : '';
  return `📋 pquote\nClient: ${clientName}\n${address ? 'Location: ' + address + '\n' : ''}Items:\n${it}\n──────────\n${taxLine}TOTAL: $${fmtMoney(gt)}\nDate: ${new Date().toLocaleDateString()}\n\n⚠️ ${DISCLAIMER}`;
}

function buildShareTextFromQuote(q) {
  let it = '';
  try {
    const li = JSON.parse(q.line_items || '[]');
    it = li.map(i => `  • ${i.label || i.type}: ${fmtNum(i.area)} ${UNIT_LABELS[i.unit] || i.unit} × $${parseFloat(i.price).toFixed(2)} = $${fmtMoney(i.subtotal || (i.area * i.price))}`).join('\n');
  } catch {}
  return `📋 pquote\nClient: ${q.client_name}\n${q.address ? 'Location: ' + q.address + '\n' : ''}Items:\n${it}\n──────────\nTOTAL: $${fmtMoney(q.total)}\nDate: ${new Date(q.created_at).toLocaleDateString()}\n\n⚠️ ${DISCLAIMER}`;
}

function copyShare() { navigator.clipboard.writeText(buildShareText()).then(() => toast('Copied! 📋')).catch(() => toast('Copy failed')); }
// Same-window navigation (not window.open) so the OS handler is invoked
// directly — window.open on sms:/mailto: URIs spawns a blank popup on
// desktop and sometimes on mobile.
function smsShare()   { window.location.href = 'sms:?body=' + encodeURIComponent(buildShareText()); }
function emailShare() { window.location.href = `mailto:?subject=${encodeURIComponent('Quote Estimate')}&body=${encodeURIComponent(buildShareText())}`; }

// ═══════════════════════════════════════
//  STATS
// ═══════════════════════════════════════
async function loadStats() {
  const c = el('stats-content');
  try {
    const s = await authFetch('/api/stats').then(r => r.json());
    const mu = v => '$' + parseFloat(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const rows = (s.by_type || []).map(t =>
      `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--bg2)">
        <div style="font-size:13px;font-weight:600;text-transform:capitalize">${(t.project_type || '').replace(/-/g, ' ')}</div>
        <div style="text-align:right"><div style="font-family:'Playfair Display',serif;font-size:18px;font-weight:700;color:var(--accent)">${mu(t.revenue)}</div>
        <div style="font-size:10px;color:var(--muted)">${t.count} quote${t.count != 1 ? 's' : ''}</div></div></div>`
    ).join('');
    c.innerHTML = `<div class="stat-grid">
      <div class="stat-card"><div class="stat-val">${s.total_quotes}</div><div class="stat-lbl">Quotes</div></div>
      <div class="stat-card"><div class="stat-val">${mu(s.total_value)}</div><div class="stat-lbl">Total Value</div></div>
      <div class="stat-card"><div class="stat-val">${mu(s.avg_quote)}</div><div class="stat-lbl">Avg Quote</div></div>
      <div class="stat-card"><div class="stat-val">${s.this_month}</div><div class="stat-lbl">This Month</div></div></div>
      ${rows ? `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin:12px 0 6px">By Job Type</div><div>${rows}</div>` : ''}`;
  } catch { c.innerHTML = '<div class="empty-state">Failed to load stats.</div>'; }
}

// ═══════════════════════════════════════
//  RESET
// ═══════════════════════════════════════
function resetQuote() {
  step = 0; items = [];
  current = { service: null, area: '', unit: 'sqft', price: '' };
  editingQuoteId = null;
  chatHistory = [];
  drawnAreaSqMeters = 0; drawnPolygonGeoJSON = null; drawPoints = [];
  el('inp-address').value = ''; el('inp-client').value = '';
  el('inp-notes').value = ''; el('inp-area').value = ''; el('inp-price').value = '';
  el('inp-tax').value = String(getTaxRate());
  el('narrative-box').classList.add('hidden'); el('narrative-box').textContent = '';
  el('map-result').classList.add('hidden'); el('btn-open-map').classList.remove('hidden');
  document.querySelectorAll('.svc-row').forEach(r => r.classList.remove('selected'));
  clearDraft();
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
function toggleSection(headerBtn) {
  const section = headerBtn.closest('.collapse-section');
  if (section) { section.classList.toggle('open'); haptic(6); }
}
function toast(msg) {
  const t = el('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
function fmtNum(n) { return parseFloat(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
function fmtMoney(n) { return parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ═══════════════════════════════════════
//  HAPTIC FEEDBACK
// ═══════════════════════════════════════
function haptic(ms) { try { navigator.vibrate(ms || 12); } catch {} }

// ═══════════════════════════════════════
//  PRICE MEMORY (localStorage)
// ═══════════════════════════════════════
function getSavedPrice(serviceId) {
  try { const d = JSON.parse(localStorage.getItem('pquote_prices') || '{}'); return d[serviceId] || ''; } catch { return ''; }
}
function savePrice(serviceId, price) {
  try {
    const d = JSON.parse(localStorage.getItem('pquote_prices') || '{}');
    d[serviceId] = price;
    localStorage.setItem('pquote_prices', JSON.stringify(d));
  } catch {}
}

// ═══════════════════════════════════════
//  TAX MEMORY (localStorage)
// ═══════════════════════════════════════
function getTaxRate() {
  try { return parseFloat(localStorage.getItem('pquote_tax') || '0') || 0; } catch { return 0; }
}
function saveTaxRate(rate) {
  try { localStorage.setItem('pquote_tax', String(rate)); } catch {}
}
function calcTax(subtotal) {
  const rate = parseFloat(el('inp-tax')?.value) || 0;
  return { rate, taxAmount: subtotal * rate / 100, total: subtotal * (1 + rate / 100) };
}

// ═══════════════════════════════════════
//  DISCLAIMER
// ═══════════════════════════════════════
const DISCLAIMER = 'This quote is an estimate only and does not constitute a contract or guarantee of final pricing. Actual costs may vary based on site conditions, material availability, and scope changes. Tax calculations are approximate. pquote and its operators are not liable for pricing errors, tax miscalculations, or damages arising from reliance on this estimate.';

// ═══════════════════════════════════════
//  CLIENT MEMORY (localStorage)
// ═══════════════════════════════════════
function getRecentClients() {
  try { return JSON.parse(localStorage.getItem('pquote_clients') || '[]'); } catch { return []; }
}
function saveClient(name, addr, lat, lng) {
  if (!name) return;
  try {
    let clients = getRecentClients();
    // Remove duplicate
    clients = clients.filter(c => c.name.toLowerCase() !== name.toLowerCase());
    // Add to front
    clients.unshift({ name, address: addr || '', lat: lat || null, lng: lng || null });
    // Keep max 30
    if (clients.length > 30) clients = clients.slice(0, 30);
    localStorage.setItem('pquote_clients', JSON.stringify(clients));
  } catch {}
}
function showClientAC(query) {
  const list = el('client-autocomplete');
  if (!list) return;
  if (!query || query.length < 1) { list.innerHTML = ''; return; }
  const q = query.toLowerCase();
  const matches = getRecentClients().filter(c => c.name.toLowerCase().includes(q)).slice(0, 5);
  if (!matches.length) { list.innerHTML = ''; return; }
  list.innerHTML = matches.map(c =>
    `<div class="ac-item" data-name="${esc(c.name)}" data-addr="${esc(c.address)}" data-lat="${c.lat || ''}" data-lng="${c.lng || ''}">
      <strong>${esc(c.name)}</strong>${c.address ? `<br><span style="font-size:12px;color:var(--muted)">${esc(c.address.split(',').slice(0,2).join(','))}</span>` : ''}
    </div>`
  ).join('');
  list.querySelectorAll('.ac-item').forEach(item => {
    item.addEventListener('click', () => {
      el('inp-client').value = item.dataset.name;
      if (item.dataset.addr) {
        el('inp-address').value = item.dataset.addr;
        lastLat = parseFloat(item.dataset.lat) || null;
        lastLng = parseFloat(item.dataset.lng) || null;
      }
      list.innerHTML = '';
      updateContinueBtn();
      haptic(8);
      toast(`${item.dataset.name} loaded`);
    });
  });
}

// ═══════════════════════════════════════
//  AUTO-SAVE DRAFT (localStorage, per-user)
// ═══════════════════════════════════════
function draftKey() {
  // Scope drafts to the signed-in user so a shared device doesn't
  // offer one user's in-progress quote to the next one who signs in.
  return 'pquote_draft_' + (currentUserId || 'anon');
}
function saveDraft() {
  if (!currentUserId) return;
  try {
    const draft = {
      step, items: [...items], current: { ...current },
      address: el('inp-address')?.value || '',
      clientName: el('inp-client')?.value || '',
      lastLat, lastLng, editingQuoteId,
      notes: el('inp-notes')?.value || '',
      ts: Date.now()
    };
    localStorage.setItem(draftKey(), JSON.stringify(draft));
  } catch {}
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(draftKey());
    if (!raw) return null;
    const d = JSON.parse(raw);
    // Expire drafts older than 24 hours
    if (Date.now() - d.ts > 86400000) { clearDraft(); return null; }
    return d;
  } catch { return null; }
}
function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch {}
}
function restoreDraft(d) {
  if (!d) return;
  items = d.items || [];
  current = d.current || { service: null, area: '', unit: 'sqft', price: '' };
  lastLat = d.lastLat; lastLng = d.lastLng;
  editingQuoteId = d.editingQuoteId || null;
  if (d.address) el('inp-address').value = d.address;
  if (d.clientName) el('inp-client').value = d.clientName;
  if (d.notes) el('inp-notes').value = d.notes;
  goStep(d.step || 0);
  toast('Draft restored 📝');
}

// ═══════════════════════════════════════
//  SUCCESS ANIMATION
// ═══════════════════════════════════════
function showSuccess(callback) {
  const overlay = el('success-overlay');
  if (!overlay) { if (callback) callback(); return; }
  overlay.classList.remove('hidden', 'hiding');
  haptic(30);
  setTimeout(() => {
    overlay.classList.add('hiding');
    setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.classList.remove('hiding');
      if (callback) callback();
    }, 400);
  }, 1200);
}

// ═══════════════════════════════════════
//  ONBOARDING TIPS (first-run, per-user)
// ═══════════════════════════════════════
function tipsKey() { return 'pquote_tips_dismissed_' + (currentUserId || 'anon'); }

function setupTipsStrip() {
  const strip = el('tips-strip');
  if (!strip) return;
  // Hide if this user has already dismissed it.
  if (currentUserId && localStorage.getItem(tipsKey())) return;
  strip.classList.remove('hidden');
  el('tips-close')?.addEventListener('click', () => {
    strip.classList.add('hidden');
    try { if (currentUserId) localStorage.setItem(tipsKey(), '1'); } catch {}
    haptic(8);
  });
}

// First-run nudge pointing at the 🤖 AI button — surfaces the assistant
// without forcing users to click around hoping to find help.
function aiHintKey() { return 'pquote_ai_hint_dismissed_' + (currentUserId || 'anon'); }
function setupAiHint() {
  const hint = el('ai-hint');
  if (!hint) return;
  if (currentUserId && localStorage.getItem(aiHintKey())) return;

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    hint.classList.add('dismissing');
    setTimeout(() => hint.classList.add('hidden'), 350);
    try { if (currentUserId) localStorage.setItem(aiHintKey(), '1'); } catch {}
  };

  // Delay so the address-step tips strip lands first; the AI hint then
  // rides in as a second, smaller beat.
  setTimeout(() => {
    if (dismissed) return;
    hint.classList.remove('hidden');
    setTimeout(dismiss, 9000);
  }, 2500);

  el('ai-hint-close')?.addEventListener('click', dismiss);
  el('btn-ai-chat')?.addEventListener('click', dismiss);
}

// Plan pill in the header — single source of discovery for /billing. Reads
// /api/billing/status (auth required, already gated by bootApp) and paints
// either "★ Upgrade" (free) or "✓ Pro" (active). Hides itself entirely when
// billing isn't configured server-side (e.g. dev without STRIPE_SECRET_KEY)
// so it doesn't dangle a dead link.
async function setupBillingPill() {
  const pill = el('plan-pill');
  if (!pill) return;
  let data;
  try {
    const r = await authFetch('/api/billing/status');
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }

  if (!data.configured) return;
  if (!data.registered) return;

  if (data.plan === 'pro') {
    pill.className = 'plan-pill is-pro';
    pill.innerHTML = '<span class="pill-glyph" aria-hidden="true">✓</span><span class="pill-label">Pro</span>';
    pill.title = 'Manage your Pro subscription';
  } else {
    pill.className = 'plan-pill is-free';
    pill.innerHTML = '<span class="pill-glyph" aria-hidden="true">★</span><span class="pill-label">Upgrade</span>';
    pill.title = 'Upgrade to pquote Pro — $9.99/month';
  }
  // Also refresh the settings dropdown so its plan badge stays in sync.
  syncSettingsMenuPlan(data);
}

// ═══════════════════════════════════════
//  SETTINGS DROPDOWN
// ═══════════════════════════════════════
// Header hamburger that opens an account menu — user info, plan status,
// billing link, support, sign out. Replaces the standalone logout button.
function setupSettingsMenu() {
  const btn  = el('btn-settings');
  const menu = el('settings-menu');
  const wrap = el('settings-wrap');
  if (!btn || !menu || !wrap) return;

  const close = () => {
    menu.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-hidden', 'true');
  };
  const open = () => {
    menu.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    menu.setAttribute('aria-hidden', 'false');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('open')) close(); else open();
  });
  // Outside-click dismisses. stopPropagation above keeps clicks inside the
  // wrapper from triggering this.
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('open')) return;
    if (!wrap.contains(e.target)) close();
  });
  // Escape key dismisses.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')) close();
  });

  el('settings-signout')?.addEventListener('click', () => {
    close();
    doLogout();
  });

  // Populate user fields from current session state. currentUserId is the
  // user's email for DB-registered accounts ('g:email' for Google OAuth,
  // arbitrary id for env users).
  const nameEl  = el('settings-user-name');
  const emailEl = el('settings-user-email');
  const displayName = sessionStorage.getItem('qmach_user_name') || 'Account';
  const displayId   = currentUserId.startsWith('g:') ? currentUserId.slice(2) : currentUserId;
  if (nameEl)  nameEl.textContent  = displayName;
  if (emailEl) emailEl.textContent = displayId || '—';
}

// Called by setupBillingPill() each time billing status loads. Keeps the
// plan badge + billing-item copy in the dropdown synchronized with the
// header pill so users see consistent state in both surfaces.
function syncSettingsMenuPlan(data) {
  const pv = el('settings-plan-value');
  const bt = el('settings-billing-title');
  const bs = el('settings-billing-sub');
  if (!pv) return;
  if (data?.plan === 'pro') {
    pv.textContent = 'Pro';
    pv.classList.add('is-pro');
    if (bt) bt.textContent = 'Manage subscription';
    if (bs) bs.textContent = 'Update card · view invoices · cancel';
  } else {
    pv.textContent = 'Free';
    pv.classList.remove('is-pro');
    if (bt) bt.textContent = data?.configured ? 'Upgrade to Pro' : 'Billing';
    if (bs) bs.textContent = data?.configured ? '$9.99/mo · unlimited quotes &amp; AI · cancel anytime' : 'Subscription management';
  }
}

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
