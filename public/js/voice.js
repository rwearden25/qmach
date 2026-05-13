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
  idle:     { state: 'idle',     text: 'Ready' },
  live:     { state: 'live',     text: 'Listening…' },
  parsing:  { state: 'parsing',  text: 'Building quote…' },
  received: { state: 'received', text: 'Done' },
  error:    { state: 'idle',     text: 'Something went wrong' },
};

function setStatus(name) {
  const s = STATUS[name] || STATUS.idle;
  $('#status-strip .status-dot').dataset.state = s.state;
  $('#status-text').textContent = s.text;
}

function show(name, opts = {}) {
  const previous = document.querySelector('.screen.active')?.id;
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  // The sticky action dock only belongs on the result screen
  const dock = document.getElementById('action-dock');
  if (dock) dock.classList.toggle('hidden', name !== 'result');
  // Step indicator
  const step1 = document.getElementById('step-1');
  const step2 = document.getElementById('step-2');
  if (step1 && step2) {
    step1.classList.toggle('active', name === 'mic');
    step1.classList.toggle('done', name === 'result');
    step2.classList.toggle('active', name === 'result');
  }
  window.scrollTo({ top: 0, behavior: 'instant' });

  // History integration: push a state when going forward (mic → result) so
  // iOS swipe-back / browser back lands on the mic screen instead of leaving
  // /voice entirely. opts.fromPop = true means we're already responding to a
  // popstate event and shouldn't push again.
  if (!opts.fromPop) {
    const goingForward = previous === 'screen-mic' && name === 'result';
    const goingBack    = previous === 'screen-result' && name === 'mic';
    if (goingForward) {
      try { history.pushState({ screen: 'result' }, '', '#review'); } catch {}
    } else if (goingBack) {
      // Coming back via in-page button (talkAgain) — pop the result entry off
      // so the browser back stack stays clean.
      if (history.state?.screen === 'result') {
        try { history.back(); } catch {}
      }
    }
  }
}

window.addEventListener('popstate', (e) => {
  // Modal close on back: if the modal is open, just hide it; the popstate
  // already removed the #preview history entry, so don't re-pop.
  const modal = document.getElementById('preview-modal');
  if (modal && !modal.classList.contains('hidden')) {
    modal.classList.add('hidden');
    document.getElementById('copy-toast')?.classList.add('hidden');
    return;
  }
  // Map any other popstate to the right screen.
  if (e.state?.screen === 'result' && screens.result) {
    show('result', { fromPop: true });
  } else if (screens.mic) {
    show('mic', { fromPop: true });
  }
});

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

/* ───── Auth-aware save button label ───── */
let IS_AUTHED = false;
(async () => {
  try {
    const r = await fetch('/api/auth/check', { credentials: 'same-origin' });
    if (r.ok) {
      const j = await r.json();
      IS_AUTHED = !!(j?.userId || j?.userName);
    }
  } catch {}
  // Update save button label based on auth state
  const saveLabel = document.querySelector('#save-btn .dock-btn-label');
  if (saveLabel) saveLabel.textContent = IS_AUTHED ? 'Save quote' : 'Sign in to save';
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
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

let recognition = null;
let recording = false;
let finalTranscript = '';
let waveformRAF = null;

// ── Turnstile (captcha for guest voice analyses). Renders once the CF script
// loads AND /api/config has returned a sitekey. Token is read at submit time
// and cleared on success/error so each analysis requires a fresh challenge.
// The `window._turnstileReady` flag is set by the inline shim in <head> when
// CF's async script loads — we self-queue via window._turnstileQueue if we
// get here first. Render is idempotent and safe to call repeatedly.
let turnstileSiteKey = '';
let voiceTurnstileWidgetId = null;
let voiceTurnstileToken = '';
function renderVoiceTurnstile() {
  if (!window._turnstileReady || !window.turnstile) {
    (window._turnstileQueue = window._turnstileQueue || []).push(renderVoiceTurnstile);
    return;
  }
  if (!turnstileSiteKey) return;
  const host = document.getElementById('voice-turnstile');
  if (!host) return;
  if (voiceTurnstileWidgetId !== null) return;
  try {
    voiceTurnstileWidgetId = window.turnstile.render(host, {
      sitekey: turnstileSiteKey,
      theme: 'auto',
      size: 'flexible',
      callback:           (token) => { voiceTurnstileToken = token; },
      'expired-callback': () => { voiceTurnstileToken = ''; },
      'error-callback':   () => { voiceTurnstileToken = ''; },
    });
  } catch (e) { console.warn('Turnstile render failed:', e); }
}
function resetVoiceTurnstile() {
  voiceTurnstileToken = '';
  if (voiceTurnstileWidgetId !== null && window.turnstile) {
    try { window.turnstile.reset(voiceTurnstileWidgetId); } catch {}
  }
}
// Kick off config fetch immediately — the captcha widget can render before
// the user finishes recording. /api/config is in the auth-middleware open list.
(async () => {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    if (cfg.turnstileSiteKey) {
      turnstileSiteKey = cfg.turnstileSiteKey;
      renderVoiceTurnstile();
    }
  } catch { /* server unreachable — voice page still works, captcha just won't gate */ }
})();

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
      const captured = (transcriptEl.textContent || '').trim();
      stopRecording();
      if (!captured) {
        statusEl.textContent = '[ NO SPEECH ] tap mic to retry, or type below';
        fallbackEl.classList.remove('hidden');
        submitBtn.classList.remove('hidden');
      }
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

/* ───── Universal: textarea is always wired for submit visibility ─────
   On iOS this is the primary input path; on non-iOS it's a fallback that
   stays usable alongside SR.
*/
fallbackEl.addEventListener('input', () => {
  submitBtn.classList.toggle('hidden', !fallbackEl.value.trim());
});

if (IS_IOS) {
  // Skip the Web Speech API entirely on iOS. WKWebView's SpeechRecognition
  // is too unreliable across iOS Safari / Chrome / Edge / Firefox (Apple
  // forces them all onto WKWebView). Use the iOS keyboard's built-in
  // dictation 🎙 instead — it's an OS-level feature that works in every
  // iOS browser.
  transcriptEl.classList.add('hidden');
  fallbackEl.classList.remove('hidden');
  document.getElementById('keyboard-tip')?.classList.remove('hidden');
  fallbackEl.placeholder = 'Tap, then use the 🎙 on your keyboard to dictate — or type.';
  meterEl.textContent = '';
  micLabel.textContent = 'Tap to talk';
  statusEl.textContent = 'Tap mic to open the keyboard';

  // Visual feedback tied to keyboard open/close
  fallbackEl.addEventListener('focus', () => {
    setStatus('live');
    statusEl.textContent = 'Tap the 🎙 on your keyboard to dictate';
    statusEl.classList.remove('error');
    micBtn.classList.add('recording');
    micLabel.textContent = 'Listening…';
  });
  fallbackEl.addEventListener('blur', () => {
    setStatus('idle');
    micBtn.classList.remove('recording');
    micLabel.textContent = 'Tap to talk';
    statusEl.textContent = fallbackEl.value.trim()
      ? `${fallbackEl.value.trim().length} characters · tap "Get my quote"`
      : 'Tap mic to open the keyboard';
  });
} else if (SR) {
  recognition = buildRecognition();
} else {
  // Non-iOS browser without Web Speech API (Firefox desktop, etc.) —
  // textarea is the only input.
  micBtn.classList.add('hidden');
  transcriptEl.classList.add('hidden');
  fallbackEl.classList.remove('hidden');
  submitBtn.classList.remove('hidden');
  statusEl.textContent = 'Type the job below';
  meterEl.textContent = '';
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

function startRecording() {
  if (!recognition) {
    showMicError('speech recognition unavailable in this browser');
    return;
  }
  finalTranscript = '';
  transcriptEl.textContent = '';
  recording = true;
  micBtn.classList.add('recording');
  micLabel.textContent = 'Tap to stop';
  statusEl.textContent = 'Listening — speak naturally';
  statusEl.classList.remove('error');
  setStatus('live');
  try {
    recognition.start();
  } catch (err) {
    // Sometimes throws InvalidStateError if a previous session is still tearing
    // down. Rebuild the recognizer and retry once.
    try {
      recognition = buildRecognition();
      recognition.start();
    } catch (e2) {
      showMicError(`couldn't start mic · ${e2.message || e2.name || 'unknown'}`);
      stopRecording();
      return;
    }
  }
  startWaveform();
}

function stopRecording() {
  if (!recording && !recognition) return;
  recording = false;
  micBtn.classList.remove('recording');
  micLabel.textContent = 'Tap to talk';
  setStatus('idle');
  try { recognition?.stop(); } catch {}
  stopWaveform();
  meterEl.textContent = '— — —';
}

micBtn?.addEventListener('click', () => {
  if (IS_IOS) {
    // Focus the textarea so iOS opens the keyboard with its built-in
    // dictation 🎙 button. The keyboard mic is OS-level and works in every
    // iOS browser — far more reliable than WKWebView's SpeechRecognition.
    fallbackEl.focus();
    return;
  }
  if (recording) stopRecording();
  else startRecording();
});

submitBtn.addEventListener('click', async () => {
  const transcript = (transcriptEl.textContent.trim() || fallbackEl.value.trim());
  if (!transcript) {
    statusEl.textContent = 'Tell us about the job first';
    statusEl.classList.add('error');
    return;
  }
  stopRecording();
  submitBtn.disabled = true;
  submitBtn.querySelector('span').textContent = 'Building…';
  setStatus('parsing');
  statusEl.classList.remove('error');
  statusEl.textContent = 'Building your quote — one moment…';

  // If the captcha is configured server-side, require a token before we burn
  // anything else. The widget callback populates voiceTurnstileToken; if the
  // user hasn't completed it, abort with a friendly nudge.
  if (turnstileSiteKey && !voiceTurnstileToken) {
    setStatus('error');
    statusEl.classList.add('error');
    statusEl.textContent = 'Please complete the captcha before submitting.';
    submitBtn.disabled = false;
    submitBtn.querySelector('span').textContent = 'Get my quote';
    return;
  }

  try {
    const res = await fetch('/api/voice/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        transcript,
        prior_context: window._voiceState?.prior_context || null,
        turnstile_token: voiceTurnstileToken,
      }),
    });
    if (res.status === 400) {
      const err = await safeJson(res);
      if (err?.error === 'captcha_failed') {
        setStatus('error');
        statusEl.classList.add('error');
        statusEl.textContent = err.message || 'Captcha check failed — please retry.';
        resetVoiceTurnstile();
        submitBtn.disabled = false;
        submitBtn.querySelector('span').textContent = 'Get my quote';
        return;
      }
    }
    if (res.status === 403) {
      const err = await safeJson(res);
      if (err?.error === 'guest_limit_reached') {
        showGuestLimitReached(err);
        submitBtn.disabled = false;
        submitBtn.querySelector('span').textContent = 'Get my quote';
        setStatus('idle');
        return;
      }
    }
    if (res.status === 503) {
      const err = await safeJson(res);
      if (err?.error === 'daily_cap_reached') {
        showDailyCapReached(err);
        submitBtn.disabled = false;
        submitBtn.querySelector('span').textContent = 'Get my quote';
        setStatus('idle');
        return;
      }
    }
    if (!res.ok) {
      const err = await safeJson(res);
      throw new Error(err?.error || `analyze ${res.status}`);
    }
    const data = await res.json();
    // Surface remaining guest quota (set by server only for unauthenticated calls)
    if (data.__guest) {
      window._voiceState = { ...(window._voiceState || {}), guest: data.__guest };
    }
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
    // Captcha tokens are single-use. Reset so "Talk to Q again" requires a
    // fresh challenge — Q will route through this same handler on its next
    // turn and the new token will be picked up at submit time.
    resetVoiceTurnstile();
  } catch (err) {
    statusEl.textContent = `Couldn't build the quote — ${err.message}`;
    statusEl.classList.add('error');
    submitBtn.disabled = false;
    submitBtn.querySelector('span').textContent = 'Get my quote';
    setStatus('error');
    resetVoiceTurnstile();
  }
});

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

/* ───── Daily cap reached: friendly "try later" message ───── */
function showDailyCapReached(payload) {
  const promptWrap = document.querySelector('.prompt-wrap');
  if (!promptWrap) {
    alert(payload?.message || 'At capacity for today — try again tomorrow.');
    return;
  }
  promptWrap.innerHTML = `
    <p class="prompt-eyebrow">At capacity</p>
    <h1 class="prompt-line">Back <em>tomorrow</em>.</h1>
    <p class="prompt-help">${escapeHtml(payload?.message || 'Voice quotes are at daily capacity. Try again tomorrow, or sign in for priority access.')}</p>
    <div class="examples" style="border-left-color: var(--amber)">
      <div class="examples-label">In the meantime</div>
      <ul class="examples-list">
        <li>Already have an account? Signed-in users get priority.</li>
        <li>Use the satellite measure tool at <a href="/app" style="color:var(--amber);font-weight:700">/app</a></li>
      </ul>
    </div>
  `;
  document.querySelector('.mic-stage')?.classList.add('hidden');
  document.querySelector('.readout')?.classList.add('hidden');
}

/* ───── Guest-limit reached: full-bleed sign-up nudge ───── */
function showGuestLimitReached(payload) {
  // Replace Screen 1's prompt area with a clear next-step CTA
  const promptWrap = document.querySelector('.prompt-wrap');
  if (!promptWrap) {
    alert(payload?.message || 'Free quote limit reached. Sign up to keep going.');
    return;
  }
  promptWrap.innerHTML = `
    <p class="prompt-eyebrow">Free quotes used</p>
    <h1 class="prompt-line">You're <em>done</em> for today.</h1>
    <p class="prompt-help">${escapeHtml(payload?.message || 'Sign up for pquote to keep quoting — first account is free.')}</p>
    <div class="examples" style="border-left-color: var(--amber)">
      <div class="examples-label">Free with an account</div>
      <ul class="examples-list">
        <li>Unlimited voice quotes</li>
        <li>Save and resend any quote</li>
        <li>Q learns your pricing over time</li>
      </ul>
      <div style="margin-top: 14px; display: flex; gap: 10px; flex-wrap: wrap;">
        <a href="/app" style="
          flex: 1; min-width: 140px;
          display: inline-flex; align-items: center; justify-content: center;
          padding: 14px 18px;
          font-family: var(--sans); font-size: 14px; font-weight: 700;
          letter-spacing: .02em;
          background: linear-gradient(180deg, var(--amber-soft), var(--amber));
          color: #FFFFFF; border: 1px solid var(--amber);
          border-radius: var(--rad-md); text-decoration: none;
          box-shadow: var(--shadow-amber);
        ">Sign up — free</a>
        <a href="/app" style="
          flex: 1; min-width: 140px;
          display: inline-flex; align-items: center; justify-content: center;
          padding: 14px 18px;
          font-family: var(--sans); font-size: 14px; font-weight: 700;
          background: transparent; color: var(--amber); border: 1px solid var(--amber);
          border-radius: var(--rad-md); text-decoration: none;
        ">Sign in</a>
      </div>
    </div>
  `;
  // Hide the mic stage and the readout — they're not actionable now
  document.querySelector('.mic-stage')?.classList.add('hidden');
  document.querySelector('.readout')?.classList.add('hidden');
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

  const guest = state.guest;
  const guestBanner = (guest && guest.remaining >= 0 && guest.remaining < guest.limit) ? `
    <div class="guest-hint">
      <span class="guest-hint-icon" aria-hidden="true">★</span>
      <span class="guest-hint-text">
        ${guest.remaining > 0
          ? `<strong>${guest.remaining} free quote${guest.remaining === 1 ? '' : 's'} left</strong> · <a href="/app">Sign up</a> for unlimited</span>`
          : `<strong>This is your last free quote</strong> · <a href="/app">Sign up</a> to keep going</span>`}
      </span>
    </div>
  ` : '';

  const card = $('#result-card');
  card.innerHTML = `
    ${guestBanner}
    <div class="log-head">
      <div>
        <div class="log-head-eyebrow">Step 2 of 2</div>
        <div class="log-head-title">Your <em>quote</em></div>
      </div>
      <div class="log-head-meta">
        <span class="meta-id">${escapeHtml(entryId)}</span>
        <span>${escapeHtml(stamp)}</span>
      </div>
    </div>

    <!-- Price first — the answer they came for -->
    <section class="log-section price-headline">
      <div class="log-label">Your price</div>
      <div id="price-section" class="price-block">
        <div class="price-loading">Calculating</div>
      </div>
    </section>

    <section class="log-section">
      <div class="log-label">Type of job</div>
      <div class="industry-row">
        <select id="industry-chip" class="industry-chip" aria-label="Job type">
          ${[...new Set([state.industry, ...INDUSTRIES])].map(i =>
            `<option value="${escapeAttr(i)}" ${i === state.industry ? 'selected' : ''}>${escapeHtml(i.replace(/-/g, ' '))}</option>`
          ).join('')}
        </select>
        <span class="confidence-tag" title="How confident Q is about the trade">${conf}% match</span>
      </div>
    </section>

    <section class="log-section">
      <div class="log-label">What we heard</div>
      <div class="brief">${formatJobSummary(state.parsed_job)}</div>
    </section>

    ${(analyze.missing_fields?.length || analyze.suggested_addons?.length) ? `
      <details class="log-section disclosure" ${(analyze.missing_fields?.length ? 'open' : '')}>
        <summary class="disclosure-summary">
          <span class="disclosure-title">Improve this quote</span>
          <span class="disclosure-count">${(analyze.missing_fields?.length || 0) + (analyze.suggested_addons?.length || 0)} suggestion${((analyze.missing_fields?.length || 0) + (analyze.suggested_addons?.length || 0)) === 1 ? '' : 's'}</span>
          <span class="disclosure-chev" aria-hidden="true">▾</span>
        </summary>

        ${analyze.missing_fields?.length ? `
          <div class="disclosure-block">
            <div class="disclosure-label">Add details</div>
            <div class="pills" id="gap-pills">
              ${analyze.missing_fields.map(f => `
                <button type="button" class="pill" data-gap="${escapeAttr(f.key)}" data-prompt="${escapeAttr(f.prompt)}">
                  ${escapeHtml(f.prompt)}
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}

        ${analyze.suggested_addons?.length ? `
          <div class="disclosure-block">
            <div class="disclosure-label">Add-ons you might want</div>
            <div class="pills" id="addon-pills">
              ${analyze.suggested_addons.map(a => `
                <button type="button" class="pill" data-addon="${escapeAttr(a.key)}" data-label="${escapeAttr(a.label)}">
                  + ${escapeHtml(a.label)}
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </details>
    ` : ''}

    <section class="log-section">
      <div class="log-label">Who is this for?</div>
      <div class="client-row">
        <input type="text"
          id="client-name-input"
          class="client-input"
          placeholder="Client name (required)"
          value="${escapeAttr(state.client_name || '')}"
          autocomplete="off"
          autocapitalize="words" />
        <input type="text"
          id="provider-name-input"
          class="client-input"
          placeholder="Your name or business (optional)"
          value="${escapeAttr(state.provider_name || '')}"
          autocomplete="off"
          autocapitalize="words" />
      </div>
    </section>

    <div class="quick-links">
      <button type="button" id="talk-again-btn" class="quick-link">＋ Add more details</button>
      <button type="button" id="full-review-btn" class="quick-link">More options →</button>
    </div>
  `;

  $('#industry-chip').addEventListener('change', (e) => {
    state.industry = e.target.value;
    fetchPrice();
  });

  $$('[data-gap]', card).forEach(btn => btn.addEventListener('click', () => expandGapPill(btn)));
  $$('[data-addon]', card).forEach(btn => btn.addEventListener('click', () => toggleAddon(btn)));

  $('#client-name-input').addEventListener('input', (e) => {
    state.client_name = e.target.value.trim();
    refreshDockState();
  });
  $('#provider-name-input').addEventListener('input', (e) => {
    state.provider_name = e.target.value.trim();
  });

  $('#talk-again-btn').addEventListener('click', talkAgain);
  $('#full-review-btn').addEventListener('click', editInFullReview);

  // Reveal sticky bottom dock and wire its buttons
  const dock = $('#action-dock');
  dock.classList.remove('hidden');
  $('#save-btn').onclick = saveQuote;
  $('#download-btn').onclick = downloadQuote;
  refreshDockState();

  fetchPrice();
}

function refreshDockState() {
  const state = window._voiceState || {};
  const hasPrice = !!state.price;
  const hasClient = !!(state.client_name && state.client_name.trim());
  const ready = hasPrice && hasClient;
  const saveBtn = $('#save-btn');
  const downloadBtn = $('#download-btn');
  if (saveBtn) saveBtn.disabled = !ready;
  if (downloadBtn) downloadBtn.disabled = !ready;
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
    <input type="text" data-gap-input="${escapeAttr(key)}" placeholder="Type your answer" autocomplete="off" />
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
  section.innerHTML = '<div class="price-loading">Calculating</div>';

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
        <input type="number" id="price-input" class="price-input" value="${state.user_price}" min="0" step="1" inputmode="numeric" aria-label="Your price in dollars" />
      </div>
      <div class="price-meta">
        <span class="price-meta-label">Tap to edit</span>
        <span class="price-range">Suggested range · $${Math.round(data.range.low).toLocaleString()}–$${Math.round(data.range.high).toLocaleString()}</span>
      </div>
      <details class="price-reasoning">
        <summary>Why this number?</summary>
        <p>${escapeHtml(data.reasoning || '')}</p>
      </details>
    `;
    refreshDockState();
    $('#price-input').addEventListener('input', (e) => {
      state.user_price = parseFloat(e.target.value) || 0;
    });
  } catch (err) {
    if (seq !== priceFetchSeq) return;
    section.innerHTML = `
      <div class="price-loading" style="color:var(--sig-red)">Couldn't get a price · ${escapeHtml(err.message)}</div>
      <button type="button" class="quick-link" id="retry-price" style="margin-top:10px">↻ Try again</button>
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
  submitBtn.querySelector('span').textContent = 'Get my quote';
  submitBtn.classList.add('hidden');
  if (IS_IOS) {
    statusEl.textContent = 'Tap mic to open the keyboard';
  } else {
    statusEl.textContent = '';
  }
  statusEl.classList.remove('error');
  setStatus('idle');
  // Capture context the new analyze call needs to merge against, then reset
  // round-specific UI state so old gap answers and addon toggles don't carry
  // forward onto a re-parsed job that may have a different shape.
  state.prior_context = {
    inferred_industry: state.industry,
    parsed_job: state.enriched_job || state.parsed_job,
    addons: state.final_addons || [],
  };
  state.gap_answers = {};
  state.selected_addons = {};
  // Also clear cached enriched_job / final_addons. If round N's fetchPrice
  // failed (its catch branch never updates these), a later talkAgain would
  // pick state.enriched_job over the freshly parsed_job and leak stale
  // scope_notes into prior_context.
  state.enriched_job = null;
  state.final_addons = null;
  // On non-iOS, re-hide the fallback textarea so the user lands cleanly on
  // the SR-driven mic screen. (On iOS the textarea is the primary input and
  // stays visible.)
  if (!IS_IOS) fallbackEl.classList.add('hidden');
  show('mic');
}

/* ───── Build the quote body that goes to /api/quotes ───── */
function buildQuoteBody() {
  const state = window._voiceState;
  const price = Number.isFinite(state.user_price) ? state.user_price : Math.round(state.price?.suggested_price || 0);
  const job = state.enriched_job || state.parsed_job || {};
  return {
    client_name: state.client_name || 'Voice Quote',
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
}

/* ───── Save to account ───── */
async function saveQuote() {
  const state = window._voiceState;
  const price = Number.isFinite(state.user_price) ? state.user_price : Math.round(state.price?.suggested_price || 0);
  if (!price || price <= 0) { flashError('set a price first'); return; }
  if (!state.client_name) { focusClientInput('Add a client name to save'); return; }

  const body = buildQuoteBody();
  const saveBtn = $('#save-btn');
  saveBtn.disabled = true;
  const label = saveBtn.querySelector('.dock-btn-label');
  const oldLabel = label.textContent;
  label.textContent = 'Saving…';

  try {
    const res = await fetch('/api/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      stashDraftAndPromptSignIn(body);
      label.textContent = oldLabel;
      saveBtn.disabled = false;
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
    label.textContent = oldLabel;
    saveBtn.disabled = false;
  }
}

/* ───── Quote summary builder (shared by preview + print + SMS) ───── */
function buildQuoteSummary() {
  const state = window._voiceState;
  const price = Number.isFinite(state.user_price) ? state.user_price : Math.round(state.price?.suggested_price || 0);
  const job = state.enriched_job || state.parsed_job || {};
  const industryLabel = (state.industry || 'service').replace(/-/g, ' ');
  const detailParts = [];
  if (job.area) detailParts.push(`${Number(job.area).toLocaleString()} ${job.unit || 'sqft'}`);
  if (job.location) detailParts.push(job.location);
  if (job.scope_notes) detailParts.push(job.scope_notes);
  const detail = detailParts.join(' · ') || '—';
  const addons = (state.final_addons && state.final_addons.length)
    ? state.final_addons.map(k => k.replace(/_/g, ' '))
    : [];
  const dateStr = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const id = state.analyze_id || ('TX-' + Math.random().toString(36).slice(2, 8).toUpperCase());
  state.analyze_id = id;
  return { price, job, industryLabel, detail, addons, dateStr, id, state };
}

/* ───── Show preview modal (replaces immediate window.print) ───── */
function downloadQuote() {
  const state = window._voiceState;
  const price = Number.isFinite(state.user_price) ? state.user_price : Math.round(state.price?.suggested_price || 0);
  if (!price || price <= 0) { flashError('set a price first'); return; }
  if (!state.client_name) { focusClientInput('Add a client name to download'); return; }
  openPreview();
}

function openPreview() {
  const s = buildQuoteSummary();
  const dollars = (n) => '$' + Math.round(n).toLocaleString();

  // Render line-by-line preview
  const card = document.getElementById('preview-card');
  card.innerHTML = `
    <div class="preview-section">
      <div class="preview-key">Prepared for</div>
      <div class="preview-val">${escapeHtml(s.state.client_name)}</div>
    </div>
    ${s.state.provider_name ? `
      <div class="preview-section">
        <div class="preview-key">From</div>
        <div class="preview-val">${escapeHtml(s.state.provider_name)}</div>
      </div>
    ` : ''}
    <div class="preview-section">
      <div class="preview-key">Service</div>
      <div class="preview-line">
        <span class="preview-line-label">${escapeHtml(s.industryLabel)} — ${escapeHtml(s.detail)}</span>
        <span class="preview-line-amount">${dollars(s.price)}</span>
      </div>
      ${s.addons.length ? `
        <div class="preview-line">
          <span class="preview-line-label" style="font-size:13px;color:var(--ink-soft)">Includes: ${escapeHtml(s.addons.join(', '))}</span>
          <span class="preview-line-amount" style="font-size:13px;color:var(--ink-soft)">included</span>
        </div>
      ` : ''}
    </div>
    <div class="preview-total">
      <span class="preview-total-label">Total</span>
      <span class="preview-total-amount">${dollars(s.price)}</span>
    </div>
    <div class="preview-section" style="margin-top:14px;font-size:12px;color:var(--muted)">
      <div>Quote ${escapeHtml(s.id)} · ${escapeHtml(s.dateStr)}</div>
      <div style="margin-top:4px">Valid 30 days from issue. Final invoice may adjust if scope changes on site.</div>
    </div>
  `;

  // Show modal
  const modal = document.getElementById('preview-modal');
  modal.classList.remove('hidden');
  // Push history state so iOS swipe-back closes the modal first
  try { history.pushState({ modal: 'preview' }, '', '#preview'); } catch {}
}

function closePreview() {
  const modal = document.getElementById('preview-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  // Hide the toast in case it was visible
  document.getElementById('copy-toast')?.classList.add('hidden');
  // Pop our history state if it's still on top
  if (history.state?.modal === 'preview') {
    try { history.back(); } catch {}
  }
}

/* ───── Build SMS-friendly text from current state ───── */
function buildSmsText() {
  const s = buildQuoteSummary();
  const dollars = (n) => '$' + Math.round(n).toLocaleString();
  const lines = [];
  lines.push(`Quote from ${s.state.provider_name || 'pquote.ai'}`);
  lines.push(`For: ${s.state.client_name}`);
  lines.push(`Date: ${s.dateStr}`);
  lines.push('');
  lines.push(`Service: ${s.industryLabel}`);
  if (s.detail && s.detail !== '—') lines.push(`Details: ${s.detail}`);
  if (s.addons.length) lines.push(`Includes: ${s.addons.join(', ')}`);
  lines.push('');
  lines.push(`TOTAL: ${dollars(s.price)}`);
  lines.push('');
  lines.push(`Quote ${s.id} · valid 30 days`);
  lines.push(`Reply to accept.`);
  return lines.join('\n');
}

/* ───── Share or copy the SMS-friendly quote text ─────
   Prefers Web Share API on mobile (Android Chrome / iOS Safari 12.1+
   surface a native share sheet → WhatsApp / SMS / Mail / etc). Falls back
   to clipboard when Web Share isn't available (most desktops).
*/
async function copyAsSmsText() {
  const text = buildSmsText();
  const state = window._voiceState;
  const title = `Quote for ${state?.client_name || 'you'}`;

  // Web Share API path (mobile-native)
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return; // share sheet handled it
    } catch (err) {
      // User canceled or share failed — fall through to clipboard
      if (err?.name === 'AbortError') return;
    }
  }

  // Clipboard fallback
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showCopyToast();
  } catch (err) {
    showCopyToast('Copy failed — try again');
  }
}

/* Update the share-button label based on capability so users know what
   tapping it will do — "Share quote" on mobile (share sheet) vs "Copy
   as text" on desktop (clipboard). */
(function adaptShareLabel() {
  if (!navigator.share) return;
  const label = document.getElementById('copy-btn-label');
  const sub = document.getElementById('copy-btn-sub');
  if (label) label.textContent = 'Share quote';
  if (sub) sub.textContent = 'send via SMS, email, or app';
})();

function showCopyToast(message = 'Copied to clipboard ✓') {
  const toast = document.getElementById('copy-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(window._copyToastTimer);
  window._copyToastTimer = setTimeout(() => toast.classList.add('hidden'), 1800);
}

/* ───── Real PDF generation via jsPDF (no print-dialog detour) ─────
   On every browser including iOS Safari, this builds a PDF blob in memory
   and triggers a direct download via <a download>. iOS surfaces it as
   "Save to Files" / Share sheet without going through the print preview.
   Falls back to window.print() if jsPDF didn't load (CSP block, network).
*/
function saveAsPdf() {
  const s = buildQuoteSummary();
  const dollars = (n) => '$' + Math.round(n).toLocaleString();

  // jsPDF UMD attaches to window.jspdf
  const jsPDFCtor = window.jspdf?.jsPDF;
  if (!jsPDFCtor) {
    // CDN didn't load — fall back to print path
    return saveAsPdfPrintFallback(s, dollars);
  }

  const doc = new jsPDFCtor({ unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const M = 56; // margin

  // ── Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(28);
  doc.setTextColor(26);
  doc.text('pquote', M, 80);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('FIELD QUOTE', M, 96);

  doc.setFontSize(10);
  doc.setTextColor(80);
  doc.text(`Quote ${s.id}`, W - M, 80, { align: 'right' });
  doc.text(s.dateStr, W - M, 96, { align: 'right' });

  // Header divider
  doc.setDrawColor(26);
  doc.setLineWidth(2);
  doc.line(M, 116, W - M, 116);

  // ── Parties
  let y = 152;
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('PREPARED FOR', M, y);
  doc.text('FROM', W / 2 + 24, y);
  y += 18;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(26);
  doc.text(String(s.state.client_name || '—'), M, y);
  doc.text(String(s.state.provider_name || 'Independent contractor'), W / 2 + 24, y);

  // ── Divider
  y += 36;
  doc.setDrawColor(220);
  doc.setLineWidth(1);
  doc.line(M, y, W - M, y);

  // ── Line item table header
  y += 28;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text('SERVICE', M, y);
  doc.text('DETAIL', M + 140, y);
  doc.text('AMOUNT', W - M, y, { align: 'right' });

  y += 6;
  doc.setDrawColor(220);
  doc.line(M, y, W - M, y);

  // ── Line item row
  y += 24;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(26);
  doc.text(s.industryLabel, M, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(60);
  // Wrap detail text to fit column width
  const detailLines = doc.splitTextToSize(s.detail || '—', W - M - (M + 140) - 100);
  doc.text(detailLines, M + 140, y);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(26);
  doc.text(dollars(s.price), W - M, y, { align: 'right' });

  // Move y down by however many lines the detail wrapped to
  y += Math.max(detailLines.length, 1) * 14;

  // Add-ons sub-line
  if (s.addons.length) {
    y += 6;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(120);
    const addonsText = `Includes: ${s.addons.join(', ')}`;
    const addonsLines = doc.splitTextToSize(addonsText, W - M - (M + 140) - 100);
    doc.text(addonsLines, M + 140, y);
    y += addonsLines.length * 12;
  }

  // ── Total
  y += 28;
  doc.setDrawColor(26);
  doc.setLineWidth(2);
  doc.line(M, y, W - M, y);

  y += 32;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(120);
  doc.text('TOTAL', W - M - 120, y, { align: 'right' });

  doc.setFontSize(28);
  doc.setTextColor(26);
  doc.text(dollars(s.price), W - M, y, { align: 'right' });

  // ── Terms
  y += 60;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100);
  const terms = doc.splitTextToSize(
    'Quote valid 30 days from issue. Pricing reflects scope as described. Final invoice may adjust if scope changes on site.',
    W - 2 * M
  );
  doc.text(terms, M, y);

  // ── Footer
  doc.setFontSize(8);
  doc.setTextColor(150);
  doc.text('Generated via pquote.ai · Voice quote', M, doc.internal.pageSize.getHeight() - 36);
  doc.text(s.id, W - M, doc.internal.pageSize.getHeight() - 36, { align: 'right' });

  // Trigger download
  const filename = `quote-${(s.state.client_name || 'voice')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)}-${s.id}.pdf`;

  try {
    // jsPDF's save() handles cross-browser download trigger including iOS Safari
    doc.save(filename);
    closePreview();
  } catch (err) {
    saveAsPdfPrintFallback(s, dollars);
  }
}

/* Print fallback if jsPDF is unavailable (CDN block, etc.) */
function saveAsPdfPrintFallback(s, dollars) {
  const addonsLine = s.addons.length
    ? `<br><span style="color:#777;font-size:12px">includes: ${escapeHtml(s.addons.join(', '))}</span>`
    : '';
  $('#pq-id').textContent = s.id;
  $('#pq-id-footer').textContent = s.id;
  $('#pq-date').textContent = s.dateStr;
  $('#pq-client').textContent = s.state.client_name;
  $('#pq-provider').textContent = s.state.provider_name || 'Independent contractor';
  $('#pq-total').textContent = dollars(s.price);
  $('#pq-lines').innerHTML = `
    <tr>
      <td><strong>${escapeHtml(s.industryLabel)}</strong></td>
      <td>${escapeHtml(s.detail)}${addonsLine}</td>
      <td class="pq-amt">${dollars(s.price)}</td>
    </tr>
  `;
  closePreview();
  setTimeout(() => window.print(), 200);
}

/* ───── Wire modal close + actions on first load ───── */
(function wirePreviewModal() {
  const modal = document.getElementById('preview-modal');
  if (!modal) return;
  modal.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); closePreview(); });
  });
  document.getElementById('preview-copy-btn')?.addEventListener('click', copyAsSmsText);
  document.getElementById('preview-pdf-btn')?.addEventListener('click', saveAsPdf);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closePreview();
  });
})();

function focusClientInput(msg) {
  flashError(msg);
  const input = $('#client-name-input');
  if (input) {
    input.focus();
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  // Insert an inline panel above the dock — replaces the previous full-bleed
  // takeover and keeps the result card visible.
  let panel = document.getElementById('signin-prompt');
  if (panel) panel.remove();
  panel = document.createElement('div');
  panel.id = 'signin-prompt';
  panel.className = 'signin-prompt';
  panel.innerHTML = `
    <div class="signin-prompt-eyebrow">Sign in to save</div>
    Your quote is ready and held. Sign in or create an account to save it — your first one's free.
    <div class="signin-prompt-actions">
      <a href="/app">Sign in or sign up</a>
      <button type="button" class="ghost" id="signin-dismiss">Not now</button>
    </div>
  `;
  // Insert into the result card right before the dock so it sits in flow.
  const card = $('#result-card');
  card?.parentNode?.insertBefore(panel, $('#action-dock'));
  document.getElementById('signin-dismiss')?.addEventListener('click', () => panel.remove());
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
    <span style="color: var(--amber); letter-spacing: .12em; text-transform: uppercase; font-size: 11px; font-weight: 700;">Draft found</span>
    <span style="flex: 1;">A quote you started earlier is still here.</span>
    <button type="button" class="act-btn primary" style="padding: 10px 16px; font-size: 12px;" id="restore-yes">Save it now</button>
    <button type="button" class="act-btn ghost" style="padding: 10px 14px; font-size: 12px;" id="restore-no">Discard</button>
  `;
  // Sit between the frame header and the first active screen so it appears
  // immediately under the sticky header without shoving the layout around.
  const header = document.querySelector('.frame-header');
  if (header && header.parentNode) {
    header.parentNode.insertBefore(banner, header.nextSibling);
  } else {
    document.body.prepend(banner);
  }

  document.getElementById('restore-yes').addEventListener('click', async () => {
    const btn = document.getElementById('restore-yes');
    btn.disabled = true;
    btn.textContent = 'Saving…';
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
