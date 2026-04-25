# Voice Quote Flow — Design

**Date:** 2026-04-25
**Status:** Draft for review
**Owner:** Ross

## Summary

A new voice-first entry point on pquote that lets a user speak a job description on their phone and get a saveable ballpark quote in two screens. Targets the "I just need a general quote, not a satellite-measured one" use case. Lives alongside the existing map-based flow without modifying it.

## Goals

- Two screens from "tap mic" to "save quote"
- Skipping Q's suggestions is the default behavior (not a dismissable screen)
- Q gets smarter over time per-user via a lightweight SQLite-backed knowledge base of past quotes
- Reuses the existing `quotes` table, auth, and final review/save pipeline — no parallel data model

## Non-Goals (v1)

- Multi-turn voice conversations beyond the "talk to Q again" merge
- Saving partial voice drafts
- Adding voice to the existing map flow
- Embeddings or vector similarity (deferred to v2 if keyword + industry filter proves insufficient)
- Server-side transcription (Whisper, etc.)

## User Flow

```
[Landing] → [Mic + live transcript] → [Result card] → [Save] → [existing review page]
```

Two interactive screens. Save is one tap from the result card.

### Screen 1 — Mic

- Big mic button, label: *"Tell Q about the job."*
- Tapping starts Web Speech API recognition; live transcript renders below
- Stop button → POST transcript to `/api/voice/analyze`
- Loading state while Q analyzes (typically 2–4s)
- Fallback: if `webkitSpeechRecognition` and `SpeechRecognition` are both undefined, render a textarea with the same submit button — flow continues identically downstream

### Screen 2 — Result card

A single scrollable card containing everything Q produced. Inline editing throughout.

- **Industry chip** at top (e.g., "Pressure washing"). Tap to open a dropdown of `project_type` values and override.
- **Job summary** — short structured line (e.g., "2-story house · ~2,000 sqft · includes driveway")
- **Q's notes** — soft pill buttons listing missing-info gaps and suggested add-ons. Tapping a pill expands an inline input (for gaps) or toggles the add-on. Pills the user ignores stay ignored — that IS skipping.
- **Price field** — pre-filled with `suggested_price`. Range shown as helper text: *"Q suggests $380–$520"*. Reasoning collapsible underneath.
- **"Talk to Q again"** button (small, persistent at bottom of card). Re-opens mic; new transcript is merged with prior context server-side, card refreshes with updated parse.
- **Primary action: [Save quote]** — sends to existing save endpoint, redirects to the existing quote review/print page.
- **Secondary action: [Edit in full review]** — escape hatch into the existing dense map-flow review page, pre-populated with the same data.

## Q's Personality and Naming

The AI is named **Q** throughout the UI ("Q noticed…", "Q suggests…", "Talk to Q again"). System prompts reference Q in the third person to keep the assistant identity consistent.

## Backend

### New endpoints

#### `POST /api/voice/analyze`
Request body:
```json
{ "transcript": "string", "prior_context": null | <previous parsed_job> }
```
Response:
```json
{
  "inferred_industry": "pressure-washing",
  "confidence": 0.92,
  "parsed_job": {
    "area": 2000,
    "unit": "sqft",
    "location": null,
    "scope_notes": "2-story house, driveway"
  },
  "missing_fields": [
    { "key": "stories", "prompt": "Is this single or two-story?" }
  ],
  "suggested_addons": [
    { "key": "front_walkway", "label": "Front walkway", "default_qty": 1 }
  ]
}
```

`prior_context` enables the "Talk to Q again" merge — server prepends the prior parse to the system prompt and asks Q to merge new audio into the existing structure.

#### `POST /api/voice/price`
Request body:
```json
{
  "industry": "pressure-washing",
  "parsed_job": { ... },
  "addons": ["front_walkway"]
}
```
Response:
```json
{
  "suggested_price": 450,
  "range": { "low": 380, "high": 520 },
  "reasoning": "Based on 4 similar jobs you've quoted; mid-range reflects 2-story premium."
}
```

Wraps the existing `/api/ai/suggest-price` logic but with KB context injected.

### Knowledge base

Reuses the existing `quotes` table. Migration adds three nullable columns:
- `source TEXT DEFAULT 'map'` — `'voice'` or `'map'`. Existing rows backfill to `'map'`.
- `transcript TEXT` — raw voice transcript. Voice quotes only.
- `inferred_industry TEXT` — Q's classification at analyze time. May differ from final `project_type` if the user overrode the industry chip.

KB query (used by both new endpoints):
```sql
SELECT project_type, area, unit, total, line_items, notes
FROM quotes
WHERE user_id = ?
  AND project_type = ?
ORDER BY created_at DESC
LIMIT 5;
```

The top-5 rows are formatted as worked examples in Q's system prompt. The user's actual final `total` is the calibration signal — Q's pricing converges toward what the user actually charges.

If the KB is empty for that industry (new user), Q runs with no examples and pricing falls back to the existing generic-market behavior.

### Save pipeline

No new save endpoint. The result card's [Save quote] button POSTs to the existing `POST /api/quotes` with three additions in the body:
- `source: 'voice'`
- `transcript: <raw>`
- `inferred_industry: <q's_classification>`

The existing endpoint persists everything; the new columns capture the voice-specific fields.

## Q's System Prompt Structure

```
You are Q, a quoting assistant for trades on pquote.
Industry: {inferred or user-chosen}
User's recent similar jobs (calibration — match this user's actual pricing patterns):
{top-5 KB rows formatted as JSON}

Voice transcript: """{raw}"""
Prior context (if continuing): {previous parsed_job or null}

Task: extract structured job data, identify gaps, suggest common add-ons for this trade.
Return JSON only matching this schema: {schema}
```

For the price endpoint, swap the task line to: *"Suggest a price range based on the user's past pricing for similar jobs. Return JSON only."*

Both endpoints use `claude-opus-4-7` (matches the rest of the app after the recent model bump).

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| Browser has no Speech API | Fall back to textarea; downstream flow identical |
| Q returns malformed JSON | Existing try/catch in `server.js` returns 500 with friendly message; client shows retry |
| KB empty for that industry | Q runs without examples; pricing uses generic market rates |
| Confidence < 0.6 on industry inference | Industry chip on result card opens pre-expanded showing the dropdown |
| User taps "Talk to Q again" but says nothing | Discard empty transcript, return to result card unchanged |
| Save fails (network) | Toast error, card state preserved, retry button |

## Architecture and File Layout

- `public/voice.html` — new SPA page for the voice flow. Self-contained.
- `public/js/voice.js` — Web Speech API handling, screen state, calls to new endpoints, save handoff
- `public/css/voice.css` — voice-specific styles (mobile-first, big touch targets)
- `server.js` — adds two route handlers near the existing AI routes (around line 748)
- `db/database.js` — adds the three new columns. SQLite has no `ADD COLUMN IF NOT EXISTS`, so wrap each `ALTER TABLE quotes ADD COLUMN …` in a try/catch that swallows the "duplicate column" error, making startup idempotent across deploys.
- `public/landing.html` — adds a "Voice Quote" button next to the existing entry point

## Testing Strategy

- Unit: parsing of Q's JSON response (handle markdown fences, partial JSON, missing fields)
- Manual: end-to-end on iOS Safari, Android Chrome, desktop Chrome (each is a different Web Speech behavior)
- Manual: KB-empty path (new user), KB-populated path (after 5+ saved voice quotes)
- Manual: "Talk to Q again" merge correctness — does prior context survive a second utterance?
- Manual: fallback textarea path on a browser without Speech API (Firefox desktop)

## Open Questions

None blocking. Defer until implementation:
- Exact wording of Q's system prompts (iterate during build)
- Visual styling of pill buttons (frontend-design pass during implementation)
- Whether "Talk to Q again" should preserve the original transcript verbatim or replace with merged paraphrase (lean: preserve original, append new)
