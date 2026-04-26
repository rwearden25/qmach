# Voice Quote Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a voice-first 2-screen quote flow on pquote that lets a user speak a job description and get a saveable ballpark quote, with a lightweight SQLite-backed KB that calibrates Q's pricing to the user's past jobs.

**Architecture:** New `/voice` SPA page (separate from the map flow) calls two new endpoints (`/api/voice/analyze`, `/api/voice/price`). Both endpoints inject the user's top-5 past quotes for the inferred industry into Q's prompt as worked examples. Save reuses the existing `POST /api/quotes` endpoint with three new optional fields (`source`, `transcript`, `inferred_industry`).

**Tech Stack:** Node.js + Express, better-sqlite3, `@anthropic-ai/sdk` (`claude-opus-4-7`), Web Speech API for browser-side capture, vanilla JS frontend (matches existing pquote conventions).

**Spec:** `docs/superpowers/specs/2026-04-25-voice-quote-flow-design.md`

**Note on testing:** pquote has no automated test framework (no jest/mocha/vitest). Adding one is out of scope per the spec. Each task ends with explicit verification steps — `curl` for backend, browser check with concrete DOM/UX expectations for frontend, and `sqlite3` queries for DB — followed by a commit. Verification is not optional; do not commit before the verification step passes.

---

## File Structure

**New files:**
- `db/kb.js` — KB query helper (one exported function: `getRecentQuotesForIndustry`)
- `public/voice.html` — voice flow SPA shell
- `public/js/voice.js` — voice flow logic (Web Speech API, screen state, endpoint calls, save handoff)
- `public/css/voice.css` — voice-flow styles

**Modified files:**
- `server.js` — add 3-column migration block, add KB helper import, add `/api/voice/analyze` and `/api/voice/price` routes, add `/voice` static route
- `public/landing.html` — add "Voice Quote" entry-point button in the nav/hero
- `public/index.html` — accept query params `?prefill=<id>` for the "Edit in full review" escape hatch (only if not already supported)

---

## Task 1: DB migration — add `source`, `transcript`, `inferred_industry` columns

**Files:**
- Modify: `server.js:165-194` (migration block)

- [ ] **Step 1: Read the existing migration block** to confirm location and pattern.

Run: open `server.js`, find the `// ── Auto-migrate` block starting at line 165.

- [ ] **Step 2: Add the three new column migrations** to the same `try` block, after the `tax_rate` block. Edit `server.js` around line 191:

```javascript
  if (!cols.includes('source')) {
    db.exec("ALTER TABLE quotes ADD COLUMN source TEXT DEFAULT 'map'");
    console.log('[DB] Added source column — existing quotes default to "map"');
  }
  if (!cols.includes('transcript')) {
    db.exec('ALTER TABLE quotes ADD COLUMN transcript TEXT');
    console.log('[DB] Added transcript column');
  }
  if (!cols.includes('inferred_industry')) {
    db.exec('ALTER TABLE quotes ADD COLUMN inferred_industry TEXT');
    console.log('[DB] Added inferred_industry column');
  }
```

- [ ] **Step 3: Restart the dev server** and confirm the migration logs once.

Run: `npm run dev`
Expected console output (first run only):
```
[DB] Added source column — existing quotes default to "map"
[DB] Added transcript column
[DB] Added inferred_industry column
```
Stop the server.

- [ ] **Step 4: Verify the schema in SQLite directly.**

Run from project root (path adjusted for Windows; use the dev DB at `./data/quotemachine.db`):
```bash
node -e "const db=require('better-sqlite3')('./data/quotemachine.db'); console.log(db.pragma('table_info(quotes)').map(c=>c.name).join(','));"
```
Expected output (substring): `…tax_rate,source,transcript,inferred_industry`

- [ ] **Step 5: Verify existing rows backfilled correctly.**

Run:
```bash
node -e "const db=require('better-sqlite3')('./data/quotemachine.db'); console.log(db.prepare('SELECT COUNT(*) c FROM quotes WHERE source IS NULL').get());"
```
Expected output: `{ c: 0 }` (every existing row has `source='map'` from the column default).

- [ ] **Step 6: Commit.**

```bash
git add server.js
git commit -m "feat(db): add source/transcript/inferred_industry columns for voice quotes"
```

---

## Task 2: KB helper module

**Files:**
- Create: `db/kb.js`

- [ ] **Step 1: Create `db/kb.js`** with the KB query function.

```javascript
const db = require('./database');

// Returns up to `limit` most recent saved quotes for this user matching
// either the chosen project_type OR the inferred_industry from a prior
// voice quote. Used by the voice analyze + price endpoints to inject
// worked examples (calibrated to the user's actual pricing) into Q's prompt.
function getRecentQuotesForIndustry(userId, industry, limit = 5) {
  if (!userId || !industry) return [];
  const rows = db.prepare(`
    SELECT id, project_type, area, unit, total, line_items, notes, created_at
    FROM quotes
    WHERE user_id = ?
      AND (project_type = ? OR inferred_industry = ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, industry, industry, limit);

  return rows.map(r => ({
    id: r.id,
    project_type: r.project_type,
    area: r.area,
    unit: r.unit,
    total: r.total,
    line_items: r.line_items ? safeJsonParse(r.line_items) : null,
    notes: r.notes || '',
    created_at: r.created_at,
  }));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = { getRecentQuotesForIndustry };
```

- [ ] **Step 2: Verify module loads and runs without throwing.**

Run:
```bash
node -e "const k=require('./db/kb'); console.log(JSON.stringify(k.getRecentQuotesForIndustry('default','pressure-washing',5),null,2));"
```
Expected output: `[]` if no matching quotes exist, otherwise an array of up to 5 objects with the listed keys. Either is a pass — the goal is no thrown error and a valid array.

- [ ] **Step 3: Commit.**

```bash
git add db/kb.js
git commit -m "feat(kb): add getRecentQuotesForIndustry helper for voice flow"
```

---

## Task 3: `POST /api/voice/analyze` endpoint

**Files:**
- Modify: `server.js` — insert a new section after the existing AI routes (after line 836, before `/api/ai/chat`, or at the end of the AI block — keep AI routes contiguous)

- [ ] **Step 1: Add the KB import** near the top of `server.js`, after the `db = require('./db/database')` line (around line 11):

```javascript
const { getRecentQuotesForIndustry } = require('./db/kb');
```

- [ ] **Step 2: Add the analyze endpoint.** Insert in the AI ROUTES section (after line 836, the close of `generate-narrative`):

```javascript
// AI: Voice quote — analyze transcript, infer industry, parse job, suggest gaps + add-ons
app.post('/api/voice/analyze', async (req, res) => {
  try {
    const { transcript, prior_context } = req.body;
    if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 3) {
      return res.status(400).json({ error: 'transcript is required (min 3 chars)' });
    }

    // KB lookup uses prior_context industry if continuing, otherwise we have no
    // industry yet — we'll send empty examples and let Q infer cold. After the
    // first analyze, "Talk to Q again" passes prior_context so the next call
    // gets calibration.
    const industry = prior_context?.inferred_industry || null;
    const examples = industry ? getRecentQuotesForIndustry(req.userId, industry, 5) : [];

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 800,
      system: `You are Q, a quoting assistant for trades on pquote.
Your job: extract a structured ballpark quote from a spoken transcript.
Always respond with a JSON object only — no markdown, no commentary.`,
      messages: [{
        role: 'user',
        content: `Voice transcript: """${transcript.trim()}"""

Prior context (if continuing a previous analyze, otherwise null): ${JSON.stringify(prior_context || null)}

User's recent similar jobs (calibration — match this user's pricing patterns when present):
${JSON.stringify(examples, null, 2)}

Task:
1. Infer the trade/industry from the transcript (e.g. "pressure-washing", "striping", "roofing", "painting", "sealcoating", or "custom" if unclear).
2. Extract structured job data (area, unit, location hints, scope notes).
3. List up to 3 missing-info gaps the user should fill in for an accurate quote.
4. Suggest up to 3 common add-ons for this trade.

Return ONLY this JSON:
{
  "inferred_industry": "string",
  "confidence": 0.0,
  "parsed_job": {
    "area": null,
    "unit": "sqft",
    "location": null,
    "scope_notes": "string"
  },
  "missing_fields": [
    { "key": "string", "prompt": "string" }
  ],
  "suggested_addons": [
    { "key": "string", "label": "string", "default_qty": 1 }
  ]
}`
      }]
    });

    const raw = message.content[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw });
    }
    res.json(parsed);
  } catch (err) {
    console.error('AI voice/analyze error:', err);
    res.status(500).json({ error: 'AI analyze request failed' });
  }
});
```

- [ ] **Step 3: Restart dev server** (`npm run dev`).

- [ ] **Step 4: Verify with `curl`.** You'll need a valid session cookie or to temporarily bypass auth — check how existing AI routes are called. The simplest verification: log in via the browser, copy the session cookie, then:

```bash
curl -X POST http://localhost:3000/api/voice/analyze \
  -H "Content-Type: application/json" \
  -H "Cookie: <your-session-cookie>" \
  -d '{"transcript":"I need to pressure wash a two-story house, about 2000 square feet, and the driveway too."}'
```

Expected response: a JSON object with `inferred_industry` ≈ `"pressure-washing"`, `confidence` ≥ 0.6, `parsed_job.area` ≈ 2000, `parsed_job.unit` = `"sqft"`, at least one entry in `missing_fields` or `suggested_addons`. The exact wording will vary by Q.

- [ ] **Step 5: Verify the empty/invalid input rejection.**

```bash
curl -X POST http://localhost:3000/api/voice/analyze \
  -H "Content-Type: application/json" \
  -H "Cookie: <your-session-cookie>" \
  -d '{"transcript":""}'
```
Expected: `{"error":"transcript is required (min 3 chars)"}` with HTTP 400.

- [ ] **Step 6: Commit.**

```bash
git add server.js
git commit -m "feat(api): add POST /api/voice/analyze endpoint"
```

---

## Task 4: `POST /api/voice/price` endpoint

**Files:**
- Modify: `server.js` — insert directly after the analyze endpoint added in Task 3

- [ ] **Step 1: Add the price endpoint.** Insert after the `/api/voice/analyze` block:

```javascript
// AI: Voice quote — suggest price calibrated to user's past jobs
app.post('/api/voice/price', async (req, res) => {
  try {
    const { industry, parsed_job, addons } = req.body;
    if (!industry || !parsed_job) {
      return res.status(400).json({ error: 'industry and parsed_job required' });
    }

    const examples = getRecentQuotesForIndustry(req.userId, industry, 5);

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 400,
      system: `You are Q, a pricing assistant for trades on pquote.
Suggest a fair ballpark price for the job. When the user has past similar quotes,
calibrate to their actual pricing patterns. Otherwise use realistic market rates
(default location: DFW Texas area).
Always respond with a JSON object only — no markdown, no commentary.`,
      messages: [{
        role: 'user',
        content: `Industry: ${industry}
Parsed job: ${JSON.stringify(parsed_job)}
Selected add-ons: ${JSON.stringify(addons || [])}

User's recent similar jobs (calibration signal — their actual prices):
${JSON.stringify(examples, null, 2)}

Return ONLY this JSON:
{
  "suggested_price": 0,
  "range": { "low": 0, "high": 0 },
  "reasoning": "1-2 sentences. Mention if calibrated to user's past jobs."
}`
      }]
    });

    const raw = message.content[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(500).json({ error: 'AI returned invalid JSON', raw });
    }
    res.json(parsed);
  } catch (err) {
    console.error('AI voice/price error:', err);
    res.status(500).json({ error: 'AI price request failed' });
  }
});
```

- [ ] **Step 2: Restart dev server.**

- [ ] **Step 3: Verify with `curl`** (use the same session cookie):

```bash
curl -X POST http://localhost:3000/api/voice/price \
  -H "Content-Type: application/json" \
  -H "Cookie: <your-session-cookie>" \
  -d '{"industry":"pressure-washing","parsed_job":{"area":2000,"unit":"sqft","scope_notes":"2-story house plus driveway"},"addons":["front_walkway"]}'
```

Expected response shape:
```json
{
  "suggested_price": 450,
  "range": { "low": 380, "high": 520 },
  "reasoning": "..."
}
```
The numbers will vary, but `suggested_price` must be a positive number, `range.low <= suggested_price <= range.high`, and `reasoning` must be a non-empty string.

- [ ] **Step 4: Verify the missing-fields rejection.**

```bash
curl -X POST http://localhost:3000/api/voice/price \
  -H "Content-Type: application/json" \
  -H "Cookie: <your-session-cookie>" \
  -d '{"industry":"pressure-washing"}'
```
Expected: `{"error":"industry and parsed_job required"}` with HTTP 400.

- [ ] **Step 5: Commit.**

```bash
git add server.js
git commit -m "feat(api): add POST /api/voice/price endpoint with KB calibration"
```

---

## Task 5: `voice.html` shell + Web Speech API capture (Screen 1)

**Files:**
- Create: `public/voice.html`
- Create: `public/css/voice.css` (stub for now — Task 10 adds the polish pass)
- Create: `public/js/voice.js`

- [ ] **Step 1: Create `public/voice.html`** as a minimal shell containing both screens, with screen 2 hidden initially.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>pquote — Voice Quote</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/css/voice.css">
</head>
<body>
  <header class="voice-header">
    <a href="/" class="back-link">← Back</a>
    <h1>Voice Quote</h1>
  </header>

  <!-- Screen 1: Mic -->
  <section id="screen-mic" class="screen active">
    <p class="prompt">Tell Q about the job.</p>
    <button id="mic-btn" type="button" class="mic-btn">🎙️ Tap to talk</button>
    <div id="transcript" class="transcript" aria-live="polite"></div>
    <textarea id="transcript-fallback" class="hidden" placeholder="Describe the job…"></textarea>
    <button id="submit-btn" type="button" class="primary-btn hidden">Done — Analyze</button>
    <div id="mic-status" class="status"></div>
  </section>

  <!-- Screen 2: Result card (rendered by voice.js after analyze) -->
  <section id="screen-result" class="screen">
    <div id="result-card" class="result-card"></div>
  </section>

  <script src="/js/voice.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `public/css/voice.css`** as a minimal usable stub (Task 10 will polish).

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; background: #F2F0EB; color: #2A2824; padding: 16px; max-width: 640px; margin: 0 auto; }
.voice-header { display: flex; align-items: center; gap: 12px; padding: 12px 0 24px; }
.back-link { text-decoration: none; color: #4E4C46; font-size: 14px; }
h1 { font-size: 22px; font-weight: 700; }
.screen { display: none; }
.screen.active { display: block; }
.prompt { font-size: 18px; margin-bottom: 24px; color: #4E4C46; }
.mic-btn { width: 100%; padding: 32px; font-size: 22px; background: #3A5E30; color: white; border: 0; border-radius: 16px; cursor: pointer; }
.mic-btn.recording { background: #B22222; }
.transcript { margin: 16px 0; padding: 12px; min-height: 80px; background: white; border: 1px solid #C4C0B6; border-radius: 8px; font-size: 16px; line-height: 1.5; }
.transcript:empty::before { content: "Your words will appear here…"; color: #9A968C; }
textarea { width: 100%; min-height: 120px; padding: 12px; font-size: 16px; border: 1px solid #C4C0B6; border-radius: 8px; font-family: inherit; }
.primary-btn { width: 100%; margin-top: 16px; padding: 16px; font-size: 16px; background: #2A2824; color: white; border: 0; border-radius: 8px; cursor: pointer; }
.status { margin-top: 12px; font-size: 13px; color: #4E4C46; min-height: 18px; }
.hidden { display: none !important; }
.result-card { background: white; border: 1px solid #C4C0B6; border-radius: 12px; padding: 16px; }
```

- [ ] **Step 3: Create `public/js/voice.js`** with mic capture (Screen 1 only — Screen 2 is a stub render in this task; full result rendering is Task 6).

```javascript
'use strict';

const $ = (sel) => document.querySelector(sel);
const screens = {
  mic: $('#screen-mic'),
  result: $('#screen-result'),
};
function show(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

const micBtn = $('#mic-btn');
const submitBtn = $('#submit-btn');
const transcriptEl = $('#transcript');
const fallbackEl = $('#transcript-fallback');
const statusEl = $('#mic-status');

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recording = false;
let finalTranscript = '';

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
    if (recording) recognition.start(); // browsers can stop early; restart while recording
  };

  recognition.onerror = (e) => {
    statusEl.textContent = `Mic error: ${e.error}. Tap mic to retry or type below.`;
    fallbackEl.classList.remove('hidden');
    submitBtn.classList.remove('hidden');
    stopRecording();
  };
} else {
  // No Speech API — go straight to textarea fallback
  micBtn.classList.add('hidden');
  transcriptEl.classList.add('hidden');
  fallbackEl.classList.remove('hidden');
  submitBtn.classList.remove('hidden');
  statusEl.textContent = 'Voice input not supported in this browser — type instead.';
}

function startRecording() {
  if (!recognition) return;
  finalTranscript = '';
  transcriptEl.textContent = '';
  recording = true;
  micBtn.classList.add('recording');
  micBtn.textContent = '⏹ Tap to stop';
  statusEl.textContent = 'Listening…';
  recognition.start();
}

function stopRecording() {
  if (!recognition) return;
  recording = false;
  micBtn.classList.remove('recording');
  micBtn.textContent = '🎙️ Tap to talk';
  statusEl.textContent = '';
  try { recognition.stop(); } catch {}
}

micBtn?.addEventListener('click', () => {
  if (recording) stopRecording();
  else startRecording();
});

submitBtn.addEventListener('click', async () => {
  const transcript = (transcriptEl.textContent.trim() || fallbackEl.value.trim());
  if (!transcript) {
    statusEl.textContent = 'Say or type something first.';
    return;
  }
  stopRecording();
  submitBtn.disabled = true;
  submitBtn.textContent = 'Q is thinking…';

  try {
    const res = await fetch('/api/voice/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ transcript }),
    });
    if (!res.ok) throw new Error(`analyze failed (${res.status})`);
    const data = await res.json();
    window._voiceState = { transcript, analyze: data };
    renderResult(data, transcript);
    show('result');
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}. Tap Done to retry.`;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Done — Analyze';
  }
});

// Stub for Task 6 — minimal render so Screen 2 isn't blank during this task's verification.
function renderResult(data, transcript) {
  $('#result-card').innerHTML = `
    <h2>${data.inferred_industry || 'unknown industry'}</h2>
    <p><strong>Confidence:</strong> ${(data.confidence ?? 0).toFixed(2)}</p>
    <pre style="white-space:pre-wrap;font-family:inherit">${JSON.stringify(data, null, 2)}</pre>
    <p style="margin-top:12px;color:#4E4C46;font-size:13px">Transcript: ${transcript}</p>
  `;
}
```

- [ ] **Step 4: Add the static route** so `/voice` serves `voice.html`. Modify `server.js` near the existing route handlers around line 1020 (the `/`, `/app`, `/admin` block):

Find this region:
```javascript
app.get('/app', (req, res) => {
```

Add directly above it (or below, either is fine — keep grouped with the other static page routes):
```javascript
app.get('/voice', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'voice.html'));
});
```

- [ ] **Step 5: Restart dev server, log in, then visit http://localhost:3000/voice.**

Expected behaviors (test in this order):
1. Page loads with header "Voice Quote", a green mic button, and a "← Back" link.
2. **In Chrome (desktop or mobile):** tap the mic button. Browser prompts for mic permission. Allow it. Button turns red, label changes to "⏹ Tap to stop", status shows "Listening…". Say a sentence — words appear live in the transcript box. Tap stop. The "Done — Analyze" button is visible.
3. **In Firefox desktop (no Speech API):** mic button is hidden, textarea is visible with placeholder, "Done — Analyze" is visible.
4. Tap "Done — Analyze". Button text changes to "Q is thinking…". After 2–4 seconds, Screen 2 appears showing the inferred industry, confidence, the raw JSON dump, and the transcript at the bottom.

If any step fails, check the browser console (F12) for errors before continuing.

- [ ] **Step 6: Commit.**

```bash
git add public/voice.html public/css/voice.css public/js/voice.js server.js
git commit -m "feat(voice): scaffold voice flow page with mic capture (Screen 1)"
```

---

## Task 6: Render the result card (Screen 2)

**Files:**
- Modify: `public/js/voice.js` — replace the `renderResult` stub with the full card

- [ ] **Step 1: Replace the `renderResult` function** with the real Screen 2 implementation. Open `public/js/voice.js`, find the stub `renderResult` from Task 5, and replace the entire function with:

```javascript
const INDUSTRIES = ['pressure-washing','striping','roofing','painting','sealcoating','custom'];

function renderResult(analyze, transcript) {
  const state = window._voiceState;
  state.industry = analyze.inferred_industry || 'custom';
  state.parsed_job = analyze.parsed_job || {};
  state.gap_answers = {};        // key -> string answer
  state.selected_addons = {};    // key -> bool
  state.price = null;            // populated by fetchPrice

  const card = $('#result-card');
  card.innerHTML = `
    <div class="industry-row">
      <label class="industry-label">Industry</label>
      <select id="industry-chip" class="industry-chip">
        ${INDUSTRIES.map(i => `<option value="${i}" ${i===state.industry?'selected':''}>${i.replace(/-/g,' ')}</option>`).join('')}
      </select>
    </div>

    <h3 class="card-section-title">Job summary</h3>
    <div class="job-summary">
      ${formatJobSummary(state.parsed_job)}
    </div>

    ${analyze.missing_fields?.length ? `
      <h3 class="card-section-title">Q noticed gaps</h3>
      <div class="pills" id="gap-pills">
        ${analyze.missing_fields.map(f => `
          <button type="button" class="pill" data-gap="${escapeAttr(f.key)}" data-prompt="${escapeAttr(f.prompt)}">
            + ${escapeHtml(f.prompt)}
          </button>
        `).join('')}
      </div>
    ` : ''}

    ${analyze.suggested_addons?.length ? `
      <h3 class="card-section-title">Common add-ons</h3>
      <div class="pills" id="addon-pills">
        ${analyze.suggested_addons.map(a => `
          <button type="button" class="pill" data-addon="${escapeAttr(a.key)}" data-label="${escapeAttr(a.label)}">
            + ${escapeHtml(a.label)}
          </button>
        `).join('')}
      </div>
    ` : ''}

    <h3 class="card-section-title">Price</h3>
    <div id="price-section" class="price-section">
      <div class="price-loading">Q is calculating a price…</div>
    </div>

    <div class="card-actions">
      <button type="button" id="talk-again-btn" class="secondary-btn">🎙️ Talk to Q again</button>
      <button type="button" id="save-btn" class="primary-btn" disabled>Save quote</button>
      <button type="button" id="full-review-btn" class="link-btn">Edit in full review →</button>
    </div>
  `;

  // Wire industry change → re-fetch price
  $('#industry-chip').addEventListener('change', (e) => {
    state.industry = e.target.value;
    fetchPrice();
  });

  // Wire gap pills → expand into inline input
  card.querySelectorAll('[data-gap]').forEach(btn => {
    btn.addEventListener('click', () => expandGapPill(btn));
  });

  // Wire addon pills → toggle selected state, refresh price
  card.querySelectorAll('[data-addon]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.addon;
      state.selected_addons[key] = !state.selected_addons[key];
      btn.classList.toggle('selected', !!state.selected_addons[key]);
      fetchPrice();
    });
  });

  // Talk-again, save, full-review wired in Tasks 8 + 9 (placeholders so the buttons exist)
  $('#talk-again-btn').addEventListener('click', () => alert('Talk again — wired in Task 8'));
  $('#save-btn').addEventListener('click', () => alert('Save — wired in Task 9'));
  $('#full-review-btn').addEventListener('click', () => alert('Full review — wired in Task 9'));

  fetchPrice();
}

function formatJobSummary(job) {
  const parts = [];
  if (job.area) parts.push(`~${job.area} ${job.unit || 'sqft'}`);
  if (job.location) parts.push(job.location);
  if (job.scope_notes) parts.push(job.scope_notes);
  return parts.length ? parts.join(' · ') : '<em>No details parsed yet.</em>';
}

function expandGapPill(btn) {
  const key = btn.dataset.gap;
  const prompt = btn.dataset.prompt;
  if (btn.classList.contains('expanded')) return;
  btn.classList.add('expanded');
  btn.innerHTML = `
    <label>${escapeHtml(prompt)}</label>
    <input type="text" data-gap-input="${escapeAttr(key)}" placeholder="Type answer…" />
  `;
  const input = btn.querySelector('input');
  input.focus();
  input.addEventListener('blur', () => {
    const state = window._voiceState;
    if (input.value.trim()) state.gap_answers[key] = input.value.trim();
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }
```

- [ ] **Step 2: Add a stub `fetchPrice` function** at the bottom of `voice.js` (Task 7 implements the real call):

```javascript
async function fetchPrice() {
  const section = $('#price-section');
  if (!section) return;
  section.innerHTML = '<div class="price-loading">Pricing wired in Task 7.</div>';
}
```

- [ ] **Step 3: Add the supporting CSS** to `public/css/voice.css` (append to end):

```css
.industry-row { margin-bottom: 16px; }
.industry-label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .8px; color: #4E4C46; margin-bottom: 4px; }
.industry-chip { width: 100%; padding: 10px; font-size: 16px; border: 1px solid #C4C0B6; border-radius: 8px; background: white; }
.card-section-title { margin: 20px 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .8px; color: #4E4C46; }
.job-summary { padding: 12px; background: #F2F0EB; border-radius: 8px; font-size: 15px; }
.pills { display: flex; flex-wrap: wrap; gap: 8px; }
.pill { padding: 8px 14px; background: #E0EDDA; border: 1px solid #3A5E30; color: #2E4E24; border-radius: 999px; font-size: 14px; cursor: pointer; }
.pill.selected { background: #3A5E30; color: white; }
.pill.expanded { background: white; border-radius: 8px; padding: 12px; flex-basis: 100%; text-align: left; cursor: default; }
.pill.expanded label { display: block; font-size: 13px; color: #4E4C46; margin-bottom: 4px; }
.pill.expanded input { width: 100%; padding: 8px; font-size: 15px; border: 1px solid #C4C0B6; border-radius: 6px; }
.price-section { padding: 16px; background: #F2F0EB; border-radius: 8px; }
.price-loading { color: #4E4C46; font-style: italic; }
.card-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 24px; }
.secondary-btn { padding: 12px; font-size: 15px; background: white; color: #2A2824; border: 1px solid #C4C0B6; border-radius: 8px; cursor: pointer; }
.link-btn { padding: 8px; font-size: 14px; background: transparent; color: #4E4C46; border: 0; cursor: pointer; text-align: center; }
```

- [ ] **Step 4: Reload `/voice` in the browser** (no server restart needed — only frontend changed; if cached, hard-refresh).

Expected:
1. Speak a job (or type into fallback), tap Done.
2. After analyze, Screen 2 shows: industry dropdown pre-selected to Q's inference, "Job summary" line with parsed details, "Q noticed gaps" pills (if any), "Common add-ons" pills (if any), and a "Price" section reading "Pricing wired in Task 7." Bottom shows three buttons: "Talk to Q again", "Save quote" (disabled), "Edit in full review".
3. Tap an add-on pill — it turns dark green ("selected" class).
4. Tap a gap pill — it expands into a labeled input field. Focus lands in the input.
5. Change the industry dropdown — no error in console (refetch logs "Pricing wired in Task 7.").

- [ ] **Step 5: Commit.**

```bash
git add public/js/voice.js public/css/voice.css
git commit -m "feat(voice): render result card with industry, gaps, addons (Screen 2)"
```

---

## Task 7: Wire the price endpoint into the result card

**Files:**
- Modify: `public/js/voice.js` — replace the `fetchPrice` stub with the real call

- [ ] **Step 1: Replace `fetchPrice`** at the bottom of `voice.js` with:

```javascript
let priceFetchSeq = 0;

async function fetchPrice() {
  const section = $('#price-section');
  if (!section) return;
  const state = window._voiceState;

  // Merge any answered gaps into parsed_job before pricing.
  // For numeric-feeling answers (area), best-effort coerce; otherwise stuff into scope_notes.
  const enrichedJob = { ...state.parsed_job };
  for (const [key, value] of Object.entries(state.gap_answers)) {
    if (key === 'area' || /sq.?ft|square|footage/i.test(key)) {
      const num = parseFloat(value);
      if (!Number.isNaN(num)) enrichedJob.area = num;
    } else {
      enrichedJob.scope_notes = `${enrichedJob.scope_notes || ''} | ${key}: ${value}`.trim().replace(/^\|\s*/, '');
    }
  }
  const addons = Object.entries(state.selected_addons).filter(([,v]) => v).map(([k]) => k);

  const seq = ++priceFetchSeq;
  section.innerHTML = '<div class="price-loading">Q is calculating a price…</div>';

  try {
    const res = await fetch('/api/voice/price', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ industry: state.industry, parsed_job: enrichedJob, addons }),
    });
    if (!res.ok) throw new Error(`price failed (${res.status})`);
    const data = await res.json();
    if (seq !== priceFetchSeq) return; // a newer fetch superseded this one
    state.price = data;
    state.enriched_job = enrichedJob;
    state.final_addons = addons;

    section.innerHTML = `
      <label class="industry-label">Your price</label>
      <input type="number" id="price-input" class="price-input" value="${Math.round(data.suggested_price)}" min="0" step="1" />
      <div class="price-hint">Q suggests $${Math.round(data.range.low)}–$${Math.round(data.range.high)}</div>
      <details class="price-reasoning">
        <summary>Why?</summary>
        <p>${escapeHtml(data.reasoning || '')}</p>
      </details>
    `;
    $('#save-btn').disabled = false;

    $('#price-input').addEventListener('input', (e) => {
      state.user_price = parseFloat(e.target.value) || 0;
    });
    state.user_price = Math.round(data.suggested_price);
  } catch (err) {
    if (seq !== priceFetchSeq) return;
    section.innerHTML = `<div class="price-loading" style="color:#B22222">Couldn't get a price: ${escapeHtml(err.message)}. <button type="button" id="retry-price" class="link-btn">Retry</button></div>`;
    $('#retry-price')?.addEventListener('click', fetchPrice);
  }
}
```

- [ ] **Step 2: Add the price-input styles** to `public/css/voice.css`:

```css
.price-input { width: 100%; padding: 14px; font-size: 24px; font-weight: 700; border: 2px solid #3A5E30; border-radius: 8px; background: white; }
.price-hint { margin-top: 6px; font-size: 13px; color: #4E4C46; }
.price-reasoning { margin-top: 10px; font-size: 13px; color: #4E4C46; }
.price-reasoning summary { cursor: pointer; }
.price-reasoning p { margin-top: 6px; line-height: 1.5; }
```

- [ ] **Step 3: Reload `/voice` and run a full pass** (speak → done → result card).

Expected:
1. Result card shows the price section transitioning from "Q is calculating a price…" to a numeric input pre-filled with Q's suggestion.
2. Below the input: "Q suggests $LOW–$HIGH" hint, plus a collapsible "Why?" with reasoning.
3. "Save quote" button is now enabled.
4. Toggle an add-on pill — price section flashes loading, then shows updated price.
5. Change industry — same behavior, price re-fetches.
6. Edit the price input — `state.user_price` updates (verify by typing `window._voiceState.user_price` in browser console).

- [ ] **Step 4: Commit.**

```bash
git add public/js/voice.js public/css/voice.css
git commit -m "feat(voice): wire price endpoint into result card with live re-fetch"
```

---

## Task 8: "Talk to Q again" merge

**Files:**
- Modify: `public/js/voice.js` — replace the `talk-again-btn` placeholder

- [ ] **Step 1: Add a `talkAgain` function** at the bottom of `voice.js`:

```javascript
async function talkAgain() {
  const state = window._voiceState;
  // Reset Screen 1 mic state, but preserve prior parsed context
  $('#transcript').textContent = '';
  $('#transcript-fallback').value = '';
  $('#submit-btn').disabled = false;
  $('#submit-btn').textContent = 'Done — Analyze';
  $('#mic-status').textContent = '';
  // Stash prior context so the next analyze call merges instead of replacing
  state.prior_context = {
    inferred_industry: state.industry,
    parsed_job: state.enriched_job || state.parsed_job,
    addons: state.final_addons || [],
  };
  show('mic');
}
```

- [ ] **Step 2: Update the analyze fetch** in the existing `submitBtn.addEventListener('click', …)` handler to send `prior_context` when present. Find the existing fetch:

```javascript
    const res = await fetch('/api/voice/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ transcript }),
    });
```

Replace with:
```javascript
    const res = await fetch('/api/voice/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        transcript,
        prior_context: window._voiceState?.prior_context || null,
      }),
    });
```

- [ ] **Step 3: Update the existing `_voiceState` assignment** in the same handler to preserve transcript history. Find:

```javascript
    window._voiceState = { transcript, analyze: data };
```

Replace with:
```javascript
    const prior = window._voiceState || {};
    window._voiceState = {
      ...prior,
      transcript: prior.transcript ? `${prior.transcript}\n\n${transcript}` : transcript,
      analyze: data,
      prior_context: null, // consumed
    };
```

- [ ] **Step 4: Replace the `talk-again-btn` alert placeholder** in `renderResult`:

Find:
```javascript
  $('#talk-again-btn').addEventListener('click', () => alert('Talk again — wired in Task 8'));
```

Replace with:
```javascript
  $('#talk-again-btn').addEventListener('click', talkAgain);
```

- [ ] **Step 5: Reload `/voice` and verify the merge flow.**

1. Speak: *"I need to pressure wash a two-story house."* → Done → result card shows pressure-washing, ~no area parsed.
2. Tap "🎙️ Talk to Q again" — Screen 1 reappears, mic ready.
3. Speak: *"It's about 2000 square feet, plus a driveway."* → Done.
4. Result card returns. The job summary should now reflect both utterances (industry still pressure-washing, area ≈ 2000, scope_notes mentions driveway). Open the browser console and inspect `window._voiceState.transcript` — should contain BOTH utterances joined by a blank line.

- [ ] **Step 6: Commit.**

```bash
git add public/js/voice.js
git commit -m "feat(voice): add Talk-to-Q-again merge with prior_context"
```

---

## Task 9: Save handoff + "Edit in full review" escape hatch

**Files:**
- Modify: `public/js/voice.js` — replace `save-btn` and `full-review-btn` placeholders
- Verify: `public/index.html` — confirm the existing app supports loading a quote by ID via URL fragment or query param. If not, add a minimal handler.

- [ ] **Step 1: Inspect how the existing app loads a saved quote** so the escape hatch routes correctly. Open `public/js/app.js` (or `public/index.html`) and search for `quoteId`, `?id=`, `#quote`, or any URL parsing on load. Note the URL pattern used.

- [ ] **Step 2: Add the save + escape-hatch functions** at the bottom of `voice.js`:

```javascript
async function saveQuote() {
  const state = window._voiceState;
  const price = Number.isFinite(state.user_price) ? state.user_price : Math.round(state.price?.suggested_price || 0);
  if (!price || price <= 0) {
    alert('Set a price first.');
    return;
  }

  const job = state.enriched_job || state.parsed_job;
  const body = {
    client_name: prompt('Client name for this quote?', '') || 'Voice Quote',
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
  saveBtn.textContent = 'Saving…';

  try {
    const res = await fetch('/api/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`save failed (${res.status})`);
    const data = await res.json();
    // POST /api/quotes returns the full row including `id` (verified at server.js:527).
    // Hand off to the existing app — adjust the URL pattern if Step 1's inspection
    // found that the app uses `#` fragment routing instead of `?id=` query param.
    window.location.href = `/app?id=${encodeURIComponent(data.id)}`;
  } catch (err) {
    alert(`Save failed: ${err.message}`);
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save quote';
  }
}

function editInFullReview() {
  // Stash the current state and let the main app pick it up.
  // If the main app doesn't yet support draft pre-fill, the user will land in
  // a blank quote builder — still better than losing the work, since they can
  // copy-paste from the transcript.
  try {
    sessionStorage.setItem('voice_draft', JSON.stringify(window._voiceState || {}));
  } catch {}
  window.location.href = '/app?from=voice';
}
```

- [ ] **Step 3: Wire the buttons.** In `renderResult`, replace:

```javascript
  $('#save-btn').addEventListener('click', () => alert('Save — wired in Task 9'));
  $('#full-review-btn').addEventListener('click', () => alert('Full review — wired in Task 9'));
```

with:
```javascript
  $('#save-btn').addEventListener('click', saveQuote);
  $('#full-review-btn').addEventListener('click', editInFullReview);
```

- [ ] **Step 4: Verify the save path end-to-end.**

1. Reload `/voice`, run a full flow: speak → analyze → result card with price → tap "Save quote".
2. Browser prompts for client name; type one.
3. Should redirect to the existing app. Either it shows the saved quote, or (if the URL pattern from Step 1 differs) it lands on the app blank.
4. Either way, verify the quote was saved correctly in SQLite:

```bash
node -e "const db=require('better-sqlite3')('./data/quotemachine.db'); console.log(db.prepare('SELECT id, client_name, project_type, total, source, inferred_industry, length(transcript) as t_len FROM quotes WHERE source = ? ORDER BY created_at DESC LIMIT 1').get('voice'));"
```
Expected: a row with `source='voice'`, the client name you typed, `project_type` matching the chosen industry, the price you set as `total`, and `t_len > 0`.

- [ ] **Step 5: Verify the escape-hatch.** Run the flow again, but tap "Edit in full review" instead. Confirm:
   - Browser navigates to `/app?from=voice`.
   - In the app, open browser console and type `sessionStorage.getItem('voice_draft')` — expect a JSON blob with the voice state.

- [ ] **Step 6: Commit.**

```bash
git add public/js/voice.js
git commit -m "feat(voice): wire save handoff and full-review escape hatch"
```

---

## Task 10: CSS polish pass — mobile-first, match pquote palette

**Files:**
- Modify: `public/css/voice.css`

- [ ] **Step 1: Open `public/landing.html`** and copy the design tokens (the `:root` block with `--bg`, `--accent`, `--serif`, etc., starting around line 16). Ensure `voice.css` uses those tokens for visual consistency.

- [ ] **Step 2: Update `public/css/voice.css`** to use the shared palette and bigger touch targets. Replace the entire file contents with:

```css
:root {
  --bg:          #F2F0EB;
  --bg2:         #E4E2DA;
  --dark:        #2A2824;
  --text:        #2A2824;
  --muted:       #4E4C46;
  --light:       #F2F0EB;
  --accent:      #3A5E30;
  --accent-hover:#2E4E24;
  --accent-pale: #E0EDDA;
  --border:      #C4C0B6;
  --white:       #FFFFFF;
  --danger:      #B22222;
  --serif:       'Playfair Display', Georgia, serif;
  --sans:        'Nunito', system-ui, sans-serif;
  --mono:        'DM Mono', monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--sans);
  color: var(--text);
  background: var(--bg);
  padding: 16px;
  max-width: 640px;
  margin: 0 auto;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}

.voice-header { display: flex; align-items: center; gap: 16px; padding: 8px 0 24px; }
.back-link { text-decoration: none; color: var(--muted); font-size: 14px; padding: 6px 0; }
.voice-header h1 { font-family: var(--serif); font-size: 24px; font-weight: 700; }

.screen { display: none; }
.screen.active { display: block; }

.prompt { font-size: 18px; margin-bottom: 24px; color: var(--muted); }

.mic-btn {
  width: 100%;
  min-height: 96px;
  padding: 24px;
  font-size: 22px;
  font-weight: 700;
  background: var(--accent);
  color: var(--white);
  border: 0;
  border-radius: 16px;
  cursor: pointer;
  transition: background .15s, transform .05s;
}
.mic-btn:active { transform: scale(.98); }
.mic-btn.recording { background: var(--danger); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .75; } }

.transcript {
  margin: 16px 0;
  padding: 16px;
  min-height: 100px;
  background: var(--white);
  border: 1px solid var(--border);
  border-radius: 12px;
  font-size: 16px;
  line-height: 1.6;
}
.transcript:empty::before { content: "Your words will appear here…"; color: #9A968C; }

textarea {
  width: 100%;
  min-height: 140px;
  padding: 14px;
  font-size: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  font-family: inherit;
  background: var(--white);
}

.primary-btn {
  width: 100%;
  margin-top: 16px;
  padding: 18px;
  font-size: 16px;
  font-weight: 700;
  background: var(--dark);
  color: var(--white);
  border: 0;
  border-radius: 12px;
  cursor: pointer;
}
.primary-btn:disabled { opacity: .5; cursor: not-allowed; }

.secondary-btn {
  padding: 14px;
  font-size: 15px;
  background: var(--white);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
}

.link-btn {
  padding: 10px;
  font-size: 14px;
  background: transparent;
  color: var(--muted);
  border: 0;
  cursor: pointer;
  text-align: center;
}

.status { margin-top: 12px; font-size: 13px; color: var(--muted); min-height: 18px; }
.hidden { display: none !important; }

/* Result card */
.result-card {
  background: var(--white);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 20px;
}

.industry-row { margin-bottom: 16px; }
.industry-label {
  display: block;
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .8px;
  color: var(--muted);
  margin-bottom: 6px;
}
.industry-chip {
  width: 100%;
  padding: 12px;
  font-size: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--white);
}

.card-section-title {
  margin: 24px 0 10px;
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .8px;
  color: var(--muted);
  font-weight: 600;
}

.job-summary {
  padding: 14px;
  background: var(--bg);
  border-radius: 10px;
  font-size: 15px;
  line-height: 1.5;
}

.pills { display: flex; flex-wrap: wrap; gap: 8px; }
.pill {
  padding: 10px 16px;
  background: var(--accent-pale);
  border: 1px solid var(--accent);
  color: var(--accent-hover);
  border-radius: 999px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.pill.selected { background: var(--accent); color: var(--white); }
.pill.expanded {
  background: var(--white);
  border-radius: 12px;
  padding: 14px;
  flex-basis: 100%;
  text-align: left;
  cursor: default;
  font-weight: 400;
  color: var(--text);
}
.pill.expanded label {
  display: block;
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 6px;
}
.pill.expanded input {
  width: 100%;
  padding: 10px;
  font-size: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.price-section {
  padding: 16px;
  background: var(--bg);
  border-radius: 10px;
}
.price-loading { color: var(--muted); font-style: italic; }
.price-input {
  width: 100%;
  padding: 16px;
  font-size: 28px;
  font-weight: 800;
  border: 2px solid var(--accent);
  border-radius: 10px;
  background: var(--white);
  color: var(--text);
}
.price-hint { margin-top: 8px; font-size: 13px; color: var(--muted); }
.price-reasoning { margin-top: 12px; font-size: 13px; color: var(--muted); }
.price-reasoning summary { cursor: pointer; padding: 4px 0; }
.price-reasoning p { margin-top: 6px; line-height: 1.5; }

.card-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 28px;
}
```

- [ ] **Step 3: Reload `/voice` on a desktop browser, then on a phone (or DevTools mobile emulation).**

Expected:
- Colors match the landing page palette (`#F2F0EB` background, dark olive accent).
- Mic button is a comfortable thumb target on mobile (≥ 96px tall).
- Result card spacing feels intentional, not crowded.
- Pills wrap naturally without horizontal scroll.
- All buttons remain tappable on a 375px-wide viewport.

- [ ] **Step 4: Commit.**

```bash
git add public/css/voice.css
git commit -m "style(voice): match pquote palette, mobile-first touch targets"
```

---

## Task 11: Add the "Voice Quote" button to landing.html

**Files:**
- Modify: `public/landing.html`

- [ ] **Step 1: Open `public/landing.html`** and locate the existing primary CTA in the hero or nav section. Search for `Get started`, `Sign in`, or the existing `/app` link to find the right spot.

- [ ] **Step 2: Add a sibling `<a href="/voice">` button** next to the existing CTA. Match the styling of the existing button by reusing its class. Example (adjust the surrounding HTML to match what's there):

If the existing CTA looks like:
```html
<a href="/app" class="cta-btn">Open quoter</a>
```
Add directly after it:
```html
<a href="/voice" class="cta-btn cta-btn-secondary">🎙️ Voice quote</a>
```

If the landing page uses a different button class, use that class instead — the goal is "looks consistent with the existing CTA."

- [ ] **Step 3: Add a complementary `cta-btn-secondary` style** to the landing page's `<style>` block if one doesn't already exist. Find the existing `.cta-btn` rule and add right below it:

```css
.cta-btn-secondary {
  background: transparent;
  color: var(--accent);
  border: 1.5px solid var(--accent);
}
.cta-btn-secondary:hover { background: var(--accent-pale); }
```

(Skip this step if the landing page already has a secondary-button style — use that instead.)

- [ ] **Step 4: Reload `/`** and confirm:
   - The "Voice quote" button is visible next to (or near) the existing CTA.
   - Clicking it navigates to `/voice`.
   - Visual style is consistent — no jarring colors or sizes.

- [ ] **Step 5: Commit.**

```bash
git add public/landing.html
git commit -m "feat(landing): add Voice Quote entry-point button"
```

---

## Task 12: End-to-end smoke test

**Files:** none (manual verification only)

- [ ] **Step 1: Cold-start verification.** Stop the dev server. Run `npm run dev`. Confirm the boot logs show NO migration messages (because Task 1's columns already exist) — this verifies the migration is idempotent.

- [ ] **Step 2: Happy path on desktop Chrome.**
   1. Visit `http://localhost:3000/` — log in if needed.
   2. Click "Voice quote" button — lands on `/voice`.
   3. Tap mic, allow permission, say: *"I need to pressure wash a 2000 square foot two-story house with a driveway."*
   4. Tap stop, then "Done — Analyze".
   5. Result card appears with industry = pressure-washing, area ≈ 2000, gaps + addons listed, price suggestion.
   6. Toggle one add-on. Price refreshes.
   7. Tap a gap pill (if any), type an answer, click outside. Toggle the add-on off. Price refreshes again.
   8. Tap "Talk to Q again". Speak: *"Also a back patio."* Done. Card returns with the patio mentioned in scope_notes.
   9. Edit the price input (raise it $50). Tap "Save quote". Type a client name. Confirm redirect to the app.
   10. Verify the saved quote in SQLite matches what was on screen (use the query from Task 9 Step 4).

- [ ] **Step 3: Fallback path on Firefox desktop** (no Speech API).
   1. Visit `/voice` in Firefox.
   2. Confirm the mic button is hidden, textarea is visible, status reads "Voice input not supported in this browser — type instead."
   3. Type the same job description, tap Done.
   4. Confirm the result card behaves identically.

- [ ] **Step 4: Mobile path on phone.** Open `/voice` on a real phone (Safari iOS or Chrome Android via your local IP — `http://<your-lan-ip>:3000/voice` and ensure the dev server binds 0.0.0.0).
   1. Confirm the mic button is comfortable to tap.
   2. Run the happy path. Verify recording works, transcript appears, result card is readable without horizontal scroll, save works.

- [ ] **Step 5: KB calibration check.** After saving 2-3 voice quotes for the same industry at different prices:
   1. Run a new voice quote for the same industry.
   2. Inspect the price section's "Why?" reasoning. It should mention calibration to past jobs (e.g., "Based on 3 similar jobs you've quoted…"). If it doesn't, check the `examples` array being sent to Q in the `/api/voice/price` endpoint — confirm the KB query is returning rows.

- [ ] **Step 6: No commit needed for verification-only.** If anything failed, file the issue back to the task that owns the broken behavior, fix, and re-verify.

---

## Self-Review Notes

Spec coverage check:
- Two-screen flow → Tasks 5, 6, 7
- Industry chip override → Task 6
- Skip-by-ignoring pills → Task 6 (no skip button — pills are opt-in)
- "Talk to Q again" merge → Task 8
- Pre-filled price + range + reasoning → Task 7
- Save reuses existing endpoint → Task 9
- Edit-in-full-review escape hatch → Task 9
- KB injection (top-5 same-industry past quotes) → Tasks 2, 3, 4
- Web Speech API + textarea fallback → Task 5
- Auth via existing middleware → inherited by mounting under same `/api` prefix
- Migration follows `cols.includes` pattern → Task 1
- Uses `claude-opus-4-7` → Tasks 3, 4

No placeholders, no TBDs, no "similar to Task N". Method names are consistent across tasks (`fetchPrice`, `renderResult`, `talkAgain`, `saveQuote`, `editInFullReview`). State shape (`window._voiceState`) is used identically in Tasks 5–9.
