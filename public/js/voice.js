'use strict';

/* ───────────────────────────────────────────────────────────
   pquote · Field Transmission
   Voice quote flow client
─────────────────────────────────────────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const screens = {
  mic:    $('#screen-mic'),
  result: $('#screen-result'),
};

const STATUS = {
  idle:     { state: 'idle',     text: 'OFFLINE' },
  live:     { state: 'live',     text: 'ON AIR' },
  parsing:  { state: 'parsing',  text: 'PARSING' },
  received: { state: 'received', text: 'RECEIVED' },
  error:    { state: 'idle',     text: 'ERROR' },
};

function setStatus(name) {
  const s = STATUS[name] || STATUS.idle;
  $('#status-strip .status-dot').dataset.state = s.state;
  $('#status-text').textContent = s.text;
}

function show(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

const INDUSTRIES = [
  'pressure-washing',
  'striping',
  'roofing',
  'painting',
  'sealcoating',
  'concrete-cleaning',
  'window-cleaning',
  'custom',
];

/* ───── Operator ID (cosmetic) ───── */
(async () => {
  try {
    const r = await fetch('/api/auth/check', { credentials: 'same-origin' });
    if (r.ok) {
      const j = await r.json();
      if (j?.userName) $('#op-id').textContent = j.userName.toUpperCase();
      else if (j?.userId) $('#op-id').textContent = String(j.userId).split('@')[0].toUpperCase();
    }
  } catch {}
})();

/* ═══════════════════════════════════════════════════════════
   SCREEN 1 — Mic capture
═══════════════════════════════════════════════════════════ */

const micBtn       = $('#mic-btn');
const micLabel     = $('#mic-label');
const submitBtn    = $('#submit-btn');
const transcriptEl = $('#transcript');
const fallbackEl   = $('#transcript-fallback');
const statusEl     = $('#mic-status');
const meterEl      = $('#readout-meter');
const waveformEl   = $('#waveform');

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const IS_IOS_CHROME = IS_IOS && /CriOS\//.test(navigator.userAgent);
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

let recognition = null;
let recording = false;
let starting = false; // guards against double-start during async permission warmup
let finalTranscript = '';
let waveformRAF = null;

function buildRecognition() {
  const r = new SR();
  // iOS Safari is broken with continuous=true (stops after first utterance and
  // can't auto-restart outside a user gesture). Use single-shot mode there.
  // On other browsers use continuous mode for natural multi-sentence dictation.
  r.continuous = !(IS_IOS || IS_SAFARI);
  r.interimResults = true;
  r.lang = 'en-US';

  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTranscript += chunk + ' ';
      else interim += chunk;
    }
    transcriptEl.textContent = (finalTranscript + interim).trim();
    submitBtn.classList.toggle('hidden', !transcriptEl.textContent);
  };

  r.onend = () => {
    // On iOS/Safari (single-shot), one tap = one utterance. Auto-stop UI.
    // On Chrome (continuous), browser may stop mid-session — auto-restart while still recording.
    if (recording && !(IS_IOS || IS_SAFARI)) {
      try { r.start(); } catch {}
    } else if (recording) {
      // iOS/Safari ended naturally — flip UI back to idle but keep transcript
      stopRecording();
    }
  };

  r.onerror = (e) => {
    const code = (e.error || 'unknown').toUpperCase();
    let hint = 'tap mic again or type below';
    if (code === 'NOT-ALLOWED' || code === 'SERVICE-NOT-ALLOWED') {
      hint = 'enable mic in Settings → Safari → Microphone, then refresh';
    } else if (code === 'NO-SPEECH') {
      hint = "didn't catch anything — tap mic and try again";
    } else if (code === 'AUDIO-CAPTURE') {
      hint = 'no microphone detected';
    }
    showMicError(`${code} · ${hint}`);
    fallbackEl.classList.remove('hidden');
    submitBtn.classList.remove('hidden');
    stopRecording();
  };

  return r;
}

if (SR) {
  recognition = buildRecognition();
} else {
  micBtn.classList.add('hidden');
  transcriptEl.classList.add('hidden');
  fallbackEl.classList.remove('hidden');
  submitBtn.classList.remove('hidden');
  statusEl.textContent = '[ NO MIC SUPPORT ] type to transmit · upgrade to iOS 14.5+ or Chrome';
  meterEl.textContent = 'INPUT · TEXT';
}

function showMicError(msg) {
  statusEl.textContent = `[ ERROR ] ${msg}`;
  statusEl.classList.add('error');
}

/* ───── Faux oscilloscope ─────
   We can't read real mic levels because iOS only grants one mic stream per
   tab and SpeechRecognition is using it. Draw a synthetic but believable
   waveform — looks alive without competing for the mic.
*/
function startWaveform() {
  const ctx = waveformEl.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  let t = 0;

  const tick = () => {
    if (!recording) return;
    waveformEl.width = waveformEl.clientWidth * dpr;
    const W = waveformEl.width;
    const H = waveformEl.height;
    ctx.clearRect(0, 0, W, H);

    // baseline
    ctx.strokeStyle = 'rgba(255, 176, 0, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    // synthetic waveform — sum of two sines + noise jitter
    ctx.strokeStyle = '#FFB000';
    ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath();
    const points = 180;
    const amp = H * 0.32;
    for (let i = 0; i <= points; i++) {
      const x = (i / points) * W;
      const phase = t + i * 0.18;
      const wave =
        Math.sin(phase) * 0.6 +
        Math.sin(phase * 2.3) * 0.25 +
        (Math.random() - 0.5) * 0.35;
      const y = H / 2 + wave * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    t += 0.22;

    // cosmetic dB readout
    meterEl.textContent = `LVL ${(-20 + Math.round(Math.random() * 14)).toString().padStart(3, ' ')}dB`;

    waveformRAF = requestAnimationFrame(tick);
  };
  tick();
}

function stopWaveform() {
  if (waveformRAF) cancelAnimationFrame(waveformRAF);
  waveformRAF = null;
  const ctx = waveformEl.getContext('2d');
  const W = waveformEl.width = waveformEl.clientWidth * (window.devicePixelRatio || 1);
  const H = waveformEl.height;
  ctx.clearRect(0, 0, W, H);
}

async function startRecording() {
  if (starting || recording) return;
  if (!recognition) {
    showMicError('speech recognition not available in this browser');
    return;
  }
  starting = true;

  // Immediate visual feedback so the user knows the tap registered, even
  // before the async mic-permission warmup runs.
  micBtn.classList.add('recording');
  micLabel.textContent = IS_IOS ? 'REQUESTING MIC…' : (IS_SAFARI ? 'LISTENING — TAP TO STOP' : 'TAP TO STOP');
  statusEl.textContent = '[ INIT ] preparing…';
  statusEl.classList.remove('error');
  setStatus('live');

  // iOS warmup: SpeechRecognition on WKWebView (iOS Safari + iOS Chrome /
  // Edge / Firefox, all forced onto WebKit by Apple) silently no-ops if mic
  // permission hasn't been primed via the standard mediaDevices API first.
  // Request the stream, immediately release it so SpeechRecognition can
  // take exclusive ownership of the mic.
  if (IS_IOS) {
    if (!navigator.mediaDevices?.getUserMedia) {
      showMicError('mic access unavailable — try Safari');
      stopRecording();
      starting = false;
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch (err) {
      const code = (err.name || 'UNKNOWN').toUpperCase();
      let msg;
      if (code === 'NOTALLOWEDERROR' || code === 'PERMISSIONDENIEDERROR') {
        msg = IS_IOS_CHROME
          ? 'denied — Settings → Chrome → Microphone, then refresh'
          : 'denied — Settings → Safari → Microphone, then refresh';
      } else if (code === 'NOTFOUNDERROR' || code === 'DEVICESNOTFOUNDERROR') {
        msg = 'no microphone detected';
      } else if (code === 'NOTSUPPORTEDERROR') {
        msg = 'mic API not supported · try Safari';
      } else {
        msg = `${code} · ${err.message || 'mic warmup failed'}`;
      }
      showMicError(msg);
      stopRecording();
      starting = false;
      return;
    }
  }

  finalTranscript = '';
  transcriptEl.textContent = '';
  recording = true;
  micLabel.textContent = IS_IOS || IS_SAFARI ? 'LISTENING — TAP TO STOP' : 'TAP TO STOP';
  statusEl.textContent = '[ TX ] speak now…';

  try {
    recognition.start();
  } catch (err) {
    // Sometimes throws InvalidStateError if a previous session is still tearing
    // down. Rebuild the recognizer and retry once.
    try {
      recognition = buildRecognition();
      recognition.start();
    } catch (e2) {
      showMicError(`recognition.start failed · ${e2.name || e2.message || 'unknown'}`);
      stopRecording();
      starting = false;
      return;
    }
  }
  startWaveform();
  starting = false;
}

function stopRecording() {
  if (!recording && !recognition) return;
  recording = false;
  starting = false;
  micBtn.classList.remove('recording');
  micLabel.textContent = 'PRESS TO TX';
  setStatus('idle');
  try { recognition?.stop(); } catch {}
  stopWaveform();
  meterEl.textContent = '— — —';
}

micBtn?.addEventListener('click', () => {
  if (recording) stopRecording();
  else startRecording();
});

submitBtn.addEventListener('click', async () => {
  const transcript = (transcriptEl.textContent.trim() || fallbackEl.value.trim());
  if (!transcript) {
    statusEl.textContent = '[ EMPTY ] speak or type something first';
    statusEl.classList.add('error');
    return;
  }
  stopRecording();
  submitBtn.disabled = true;
  submitBtn.querySelector('span').textContent = 'PARSING';
  setStatus('parsing');
  statusEl.classList.remove('error');
  statusEl.textContent = '[ UPLINK ] Q is parsing…';

  try {
    const res = await fetch('/api/voice/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        transcript,
        prior_context: window._voiceState?.prior_context || null,
      }),
    });
    if (!res.ok) {
      const err = await safeJson(res);
      throw new Error(err?.error || `analyze ${res.status}`);
    }
    const data = await res.json();
    const prior = window._voiceState || {};
    window._voiceState = {
      ...prior,
      transcript: prior.transcript ? `${prior.transcript}\n\n${transcript}` : transcript,
      analyze: data,
      prior_context: null,
    };
    setStatus('received');
    renderResult(data);
    show('result');
  } catch (err) {
    statusEl.textContent = `[ ERROR ] ${err.message}`;
    statusEl.classList.add('error');
    submitBtn.disabled = false;
    submitBtn.querySelector('span').textContent = 'TRANSMIT';
    setStatus('error');
  }
});

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

/* ═══════════════════════════════════════════════════════════
   SCREEN 2 — Log entry render
═══════════════════════════════════════════════════════════ */

function renderResult(analyze) {
  const state = window._voiceState;
  state.industry = (analyze.inferred_industry || 'custom').toLowerCase();
  state.parsed_job = analyze.parsed_job || {};
  state.gap_answers = state.gap_answers || {};
  state.selected_addons = state.selected_addons || {};
  state.price = null;

  const conf = Math.round((analyze.confidence ?? 0) * 100);
  const stamp = new Date().toISOString().replace('T', ' · ').slice(0, 19) + 'Z';
  const entryId = state.analyze_id || ('TX-' + Math.random().toString(36).slice(2, 8).toUpperCase());
  state.analyze_id = entryId;

  const card = $('#result-card');
  card.innerHTML = `
    <div class="log-head">
      <div>
        <div class="log-head-title"><em>Q</em> · log entry</div>
      </div>
      <div class="log-head-meta">
        <span class="meta-id">${escapeHtml(entryId)}</span>
        <span>${escapeHtml(stamp)}</span>
      </div>
    </div>

    <section class="log-section">
      <div class="log-label">Trade · Channel</div>
      <div class="industry-row">
        <select id="industry-chip" class="industry-chip">
          ${[...new Set([state.industry, ...INDUSTRIES])].map(i =>
            `<option value="${escapeAttr(i)}" ${i === state.industry ? 'selected' : ''}>${escapeHtml(i.replace(/-/g, ' '))}</option>`
          ).join('')}
        </select>
        <span class="confidence-tag">CONF · <span class="conf-val">${conf}%</span></span>
      </div>
    </section>

    <section class="log-section">
      <div class="log-label">Job brief</div>
      <div class="brief">${formatJobSummary(state.parsed_job)}</div>
    </section>

    ${analyze.missing_fields?.length ? `
      <section class="log-section">
        <div class="log-label">Q noticed gaps · tap to answer</div>
        <div class="pills" id="gap-pills">
          ${analyze.missing_fields.map(f => `
            <button type="button" class="pill" data-gap="${escapeAttr(f.key)}" data-prompt="${escapeAttr(f.prompt)}">
              + ${escapeHtml(f.prompt)}
            </button>
          `).join('')}
        </div>
      </section>
    ` : ''}

    ${analyze.suggested_addons?.length ? `
      <section class="log-section">
        <div class="log-label">Common add-ons · tap to include</div>
        <div class="pills" id="addon-pills">
          ${analyze.suggested_addons.map(a => `
            <button type="button" class="pill" data-addon="${escapeAttr(a.key)}" data-label="${escapeAttr(a.label)}">
              + ${escapeHtml(a.label)}
            </button>
          `).join('')}
        </div>
      </section>
    ` : ''}

    <section class="log-section">
      <div class="log-label">Quote · USD</div>
      <div id="price-section" class="price-block">
        <div class="price-loading">Q is calibrating</div>
      </div>
    </section>

    <div class="log-actions">
      <button type="button" id="save-btn" class="act-btn primary" disabled>
        ▸ FILE QUOTE
      </button>
      <button type="button" id="talk-again-btn" class="act-btn">
        ◉ TRANSMIT AGAIN
      </button>
      <button type="button" id="full-review-btn" class="act-btn ghost">
        Open in detailed editor →
      </button>
    </div>
  `;

  $('#industry-chip').addEventListener('change', (e) => {
    state.industry = e.target.value;
    fetchPrice();
  });

  $$('[data-gap]', card).forEach(btn => btn.addEventListener('click', () => expandGapPill(btn)));
  $$('[data-addon]', card).forEach(btn => btn.addEventListener('click', () => toggleAddon(btn)));

  $('#talk-again-btn').addEventListener('click', talkAgain);
  $('#save-btn').addEventListener('click', saveQuote);
  $('#full-review-btn').addEventListener('click', editInFullReview);

  fetchPrice();
}

function formatJobSummary(job) {
  const parts = [];
  if (job.area) parts.push(`<strong>${escapeHtml(String(job.area))}</strong> ${escapeHtml(job.unit || 'sqft')}`);
  if (job.location) parts.push(escapeHtml(job.location));
  if (job.scope_notes) parts.push(escapeHtml(job.scope_notes));
  if (!parts.length) return '<em>no details parsed yet — tap a gap below</em>';
  return parts.join('<span class="brief-divider">·</span>');
}

function expandGapPill(btn) {
  if (btn.classList.contains('expanded')) return;
  const key = btn.dataset.gap;
  const prompt = btn.dataset.prompt;
  btn.classList.add('expanded');
  btn.innerHTML = `
    <label>${escapeHtml(prompt)}</label>
    <input type="text" data-gap-input="${escapeAttr(key)}" placeholder="type answer…" autocomplete="off" />
  `;
  const input = btn.querySelector('input');
  input.focus();
  input.addEventListener('blur', () => {
    const v = input.value.trim();
    if (v) {
      window._voiceState.gap_answers[key] = v;
      fetchPrice();
    }
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
}

function toggleAddon(btn) {
  const key = btn.dataset.addon;
  const state = window._voiceState;
  state.selected_addons[key] = !state.selected_addons[key];
  btn.classList.toggle('selected', !!state.selected_addons[key]);
  fetchPrice();
}

/* ───── Price fetch with race protection ───── */
let priceFetchSeq = 0;

async function fetchPrice() {
  const section = $('#price-section');
  if (!section) return;
  const state = window._voiceState;

  const enrichedJob = { ...state.parsed_job };
  for (const [key, value] of Object.entries(state.gap_answers || {})) {
    if (key === 'area' || /sq.?ft|square|footage/i.test(key)) {
      const num = parseFloat(value);
      if (!Number.isNaN(num)) enrichedJob.area = num;
    } else {
      enrichedJob.scope_notes = `${enrichedJob.scope_notes || ''} | ${key}: ${value}`.trim().replace(/^\|\s*/, '');
    }
  }
  const addons = Object.entries(state.selected_addons || {}).filter(([, v]) => v).map(([k]) => k);

  const seq = ++priceFetchSeq;
  section.innerHTML = '<div class="price-loading">Q is calibrating</div>';

  try {
    const res = await fetch('/api/voice/price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ industry: state.industry, parsed_job: enrichedJob, addons }),
    });
    if (!res.ok) {
      const err = await safeJson(res);
      throw new Error(err?.error || `price ${res.status}`);
    }
    const data = await res.json();
    if (seq !== priceFetchSeq) return;

    state.price = data;
    state.enriched_job = enrichedJob;
    state.final_addons = addons;
    state.user_price = Math.round(data.suggested_price);

    section.innerHTML = `
      <div class="price-input-wrap">
        <span class="price-currency">$</span>
        <input type="number" id="price-input" class="price-input" value="${state.user_price}" min="0" step="1" inputmode="numeric" />
      </div>
      <div class="price-meta">
        <span>your price</span>
        <span class="price-range">Q range · $${Math.round(data.range.low)}–$${Math.round(data.range.high)}</span>
      </div>
      <details class="price-reasoning">
        <summary>▾ why this number</summary>
        <p>${escapeHtml(data.reasoning || '')}</p>
      </details>
    `;
    $('#save-btn').disabled = false;
    $('#price-input').addEventListener('input', (e) => {
      state.user_price = parseFloat(e.target.value) || 0;
    });
  } catch (err) {
    if (seq !== priceFetchSeq) return;
    section.innerHTML = `
      <div class="price-loading" style="color:var(--sig-red)">[ ERROR ] ${escapeHtml(err.message)}</div>
      <button type="button" class="act-btn" id="retry-price" style="margin-top:10px">↻ RETRY</button>
    `;
    $('#retry-price')?.addEventListener('click', fetchPrice);
  }
}

/* ───── Talk to Q again ───── */
function talkAgain() {
  const state = window._voiceState;
  finalTranscript = '';
  transcriptEl.textContent = '';
  fallbackEl.value = '';
  submitBtn.disabled = false;
  submitBtn.querySelector('span').textContent = 'TRANSMIT';
  submitBtn.classList.add('hidden');
  statusEl.textContent = '';
  statusEl.classList.remove('error');
  setStatus('idle');
  state.prior_context = {
    inferred_industry: state.industry,
    parsed_job: state.enriched_job || state.parsed_job,
    addons: state.final_addons || [],
  };
  show('mic');
}

/* ───── Save handoff ───── */
async function saveQuote() {
  const state = window._voiceState;
  const price = Number.isFinite(state.user_price) ? state.user_price : Math.round(state.price?.suggested_price || 0);
  if (!price || price <= 0) {
    flashError('set a price first');
    return;
  }

  const clientName = await prompt2('Client name for this quote?');
  if (!clientName) return;

  const job = state.enriched_job || state.parsed_job;
  const body = {
    client_name: clientName,
    project_type: state.industry || 'custom',
    area: job.area || 0,
    unit: job.unit || 'sqft',
    price_per_unit: job.area > 0 ? +(price / job.area).toFixed(4) : 0,
    total: price,
    notes: job.scope_notes || '',
    address: job.location || '',
    qty: 1,
    source: 'voice',
    transcript: state.transcript,
    inferred_industry: state.industry,
  };

  const saveBtn = $('#save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = '↑ FILING…';

  try {
    const res = await fetch('/api/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      // Voice is the open marketing flow; saving is the conversion gate.
      // Stash the draft so the user can come back and finish after sign-in.
      stashDraftAndPromptSignIn(body);
      return;
    }
    if (!res.ok) {
      const err = await safeJson(res);
      throw new Error(err?.error || `save ${res.status}`);
    }
    const data = await res.json();
    window.location.href = `/app?id=${encodeURIComponent(data.id)}`;
  } catch (err) {
    flashError(`save failed · ${err.message}`);
    saveBtn.disabled = false;
    saveBtn.textContent = '▸ FILE QUOTE';
  }
}

function stashDraftAndPromptSignIn(quoteBody) {
  try {
    sessionStorage.setItem('voice_pending_save', JSON.stringify({
      body: quoteBody,
      state: window._voiceState || {},
      at: Date.now(),
    }));
  } catch {}
  const actions = document.querySelector('.log-actions');
  if (!actions) {
    window.location.href = '/app';
    return;
  }
  actions.innerHTML = `
    <div style="
      padding: 16px;
      border: 1px dashed var(--amber);
      border-radius: var(--rad-md);
      background: rgba(255,176,0,.06);
      color: var(--paper);
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 12px;
    ">
      <div style="
        font-family: var(--sans);
        font-size: 11px;
        letter-spacing: .25em;
        text-transform: uppercase;
        color: var(--amber);
        margin-bottom: 8px;
      ">[ Sign in to file ]</div>
      Your quote is ready. Sign in or sign up to save it — first one's on the house.
    </div>
    <a href="/app" class="act-btn primary" style="text-decoration:none">▸ SIGN IN TO SAVE</a>
    <button type="button" class="act-btn ghost" id="back-to-edit">← keep editing</button>
  `;
  document.getElementById('back-to-edit')?.addEventListener('click', () => {
    // Re-render the original action bar by simulating a fresh price fetch result —
    // simplest is just to reload the result card with the existing state.
    const state = window._voiceState;
    if (state?.analyze) renderResult(state.analyze);
  });
}

/* ───── Restore a pending voice draft after sign-in ───── */
(function restorePendingDraft() {
  try {
    const raw = sessionStorage.getItem('voice_pending_save');
    if (!raw) return;
    const stash = JSON.parse(raw);
    // Only restore if recent (1 hour) and we're freshly authenticated
    if (!stash || Date.now() - (stash.at || 0) > 3600 * 1000) {
      sessionStorage.removeItem('voice_pending_save');
      return;
    }
    fetch('/api/auth/check', { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!j?.userId && !j?.userName) return;
        // We're signed in and have a draft — show a restore banner up top
        showRestoreBanner(stash);
      })
      .catch(() => {});
  } catch {}
})();

function showRestoreBanner(stash) {
  const banner = document.createElement('div');
  banner.style.cssText = `
    position: sticky; top: 60px; z-index: 40;
    margin: 12px 22px 0;
    padding: 12px 16px;
    background: var(--bg-elev-2);
    border: 1px solid var(--amber);
    border-radius: var(--rad-md);
    font-family: var(--mono);
    font-size: 12.5px;
    color: var(--ink);
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  `;
  banner.innerHTML = `
    <span style="color: var(--amber); letter-spacing: .2em; text-transform: uppercase; font-size: 10.5px;">[ DRAFT FOUND ]</span>
    <span style="flex: 1;">A quote you started earlier is still here.</span>
    <button type="button" class="act-btn primary" style="padding: 8px 14px; font-size: 11px;" id="restore-yes">▸ FILE IT NOW</button>
    <button type="button" class="act-btn ghost" style="padding: 8px 12px; font-size: 11px;" id="restore-no">discard</button>
  `;
  document.body.insertBefore(banner, document.body.firstChild.nextSibling);

  document.getElementById('restore-yes').addEventListener('click', async () => {
    const btn = document.getElementById('restore-yes');
    btn.disabled = true;
    btn.textContent = 'FILING…';
    try {
      const res = await fetch('/api/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(stash.body),
      });
      if (!res.ok) throw new Error(`save ${res.status}`);
      const data = await res.json();
      sessionStorage.removeItem('voice_pending_save');
      window.location.href = `/app?id=${encodeURIComponent(data.id)}`;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = `failed · retry`;
      btn.style.color = 'var(--sig-red)';
    }
  });
  document.getElementById('restore-no').addEventListener('click', () => {
    sessionStorage.removeItem('voice_pending_save');
    banner.remove();
  });
}

function editInFullReview() {
  try {
    sessionStorage.setItem('voice_draft', JSON.stringify(window._voiceState || {}));
  } catch {}
  window.location.href = '/app?from=voice';
}

/* ───── Tiny helpers ───── */
function flashError(msg) {
  const el = $('#price-section');
  if (!el) return;
  const old = el.innerHTML;
  el.innerHTML = `<div class="price-loading" style="color:var(--sig-red)">[ ! ] ${escapeHtml(msg)}</div>`;
  setTimeout(() => { el.innerHTML = old; }, 1800);
}

// Use window.prompt for v1 — friction is acceptable for a single string.
// Wrapped so we can swap to a styled modal later without touching saveQuote.
function prompt2(question, def = '') {
  const v = window.prompt(question, def);
  return v == null ? null : v.trim();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
