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
let recognition = null;
let recording = false;
let finalTranscript = '';

let audioCtx = null;
let analyser = null;
let micStream = null;
let waveformRAF = null;

if (SR) {
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTranscript += chunk + ' ';
      else interim += chunk;
    }
    transcriptEl.textContent = (finalTranscript + interim).trim();
    submitBtn.classList.toggle('hidden', !transcriptEl.textContent);
  };

  recognition.onend = () => {
    if (recording) {
      try { recognition.start(); } catch {}
    }
  };

  recognition.onerror = (e) => {
    statusEl.textContent = `[ MIC ERROR · ${(e.error || 'unknown').toUpperCase()} ] type below to continue`;
    statusEl.classList.add('error');
    fallbackEl.classList.remove('hidden');
    submitBtn.classList.remove('hidden');
    stopRecording();
  };
} else {
  micBtn.classList.add('hidden');
  transcriptEl.classList.add('hidden');
  fallbackEl.classList.remove('hidden');
  submitBtn.classList.remove('hidden');
  statusEl.textContent = '[ NO MIC SUPPORT ] type to transmit';
  meterEl.textContent = 'INPUT · TEXT';
}

async function startWaveform() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    drawWaveform();
  } catch {
    // user denied mic; recognition may still be in textarea fallback. silent.
  }
}

function stopWaveform() {
  if (waveformRAF) cancelAnimationFrame(waveformRAF);
  waveformRAF = null;
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  micStream = null;
  if (audioCtx?.state !== 'closed') audioCtx?.close();
  audioCtx = null;
  analyser = null;
  // clear canvas to baseline
  const ctx = waveformEl.getContext('2d');
  const w = waveformEl.width = waveformEl.clientWidth * (window.devicePixelRatio || 1);
  const h = waveformEl.height;
  ctx.clearRect(0, 0, w, h);
}

function drawWaveform() {
  if (!analyser) return;
  const ctx = waveformEl.getContext('2d');
  waveformEl.width  = waveformEl.clientWidth * (window.devicePixelRatio || 1);
  const W = waveformEl.width;
  const H = waveformEl.height;
  const buf = new Uint8Array(analyser.fftSize);

  const tick = () => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
    ctx.clearRect(0, 0, W, H);

    // baseline trace (faint amber line)
    ctx.strokeStyle = 'rgba(255, 176, 0, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    // live waveform
    ctx.strokeStyle = '#FFB000';
    ctx.lineWidth = 1.6 * (window.devicePixelRatio || 1);
    ctx.beginPath();
    const slice = W / buf.length;
    let x = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      peak = Math.max(peak, Math.abs(v));
      const y = H / 2 + v * (H / 2 - 4);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += slice;
    }
    ctx.stroke();

    // dB-ish meter readout (cosmetic)
    const db = Math.round(20 * Math.log10(peak + 1e-3));
    meterEl.textContent = `LVL ${db.toString().padStart(3, ' ')}dB`;

    waveformRAF = requestAnimationFrame(tick);
  };
  tick();
}

function startRecording() {
  if (!recognition) return;
  finalTranscript = '';
  transcriptEl.textContent = '';
  recording = true;
  micBtn.classList.add('recording');
  micLabel.textContent = 'RELEASE TO STOP';
  statusEl.textContent = '[ TX ] capture in progress…';
  statusEl.classList.remove('error');
  setStatus('live');
  try { recognition.start(); } catch {}
  startWaveform();
}

function stopRecording() {
  if (!recognition && !recording) return;
  recording = false;
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
