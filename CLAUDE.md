# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
cp .env.example .env             # then fill ANTHROPIC_API_KEY + MAPBOX_TOKEN
npm run dev                      # nodemon server.js, http://localhost:3000
npm start                        # node server.js (what Railway runs)
npm run hash-password -- <pw>    # bcrypt hash for QMACH_USERS entries
```

There is no test suite, lint config, or build step — `server.js` is the application and `public/` is served as static files. "Build" means redeploy on Railway via push to `main`.

Verify a deploy actually swapped:

```bash
curl -s https://www.pquote.ai/version    # returns the short git SHA of the running build
```

`APP_VERSION` is derived from `RAILWAY_GIT_COMMIT_SHA` at boot (with a `git rev-parse` fallback for local dev). Compare the returned SHA against the commit you expect to be live; if it doesn't match within ~2 min of merge, the Railway container didn't swap and a manual Redeploy is needed.

## Architecture

**Single-file Express monolith.** All routing, auth, AI integration, rate limiting, and business logic lives in `server.js` (~1.4k lines). There are no controllers, services, or routers — endpoints are defined inline. When extending, follow the existing pattern (define handlers near related ones, reuse the `db.prepare(...)` statements at module scope) rather than introducing layered abstractions.

**Three frontend entry points**, each its own HTML/JS pair under `public/`:

| Route | File | Purpose |
|---|---|---|
| `/` | `landing.html` | Public marketing page |
| `/app` | `index.html` + `js/app.js` | Authenticated map-based quoter (Mapbox draw → AI pricing → save) |
| `/voice` | `voice.html` + `js/voice.js` | Open-access voice→quote flow (guest-quotaed) |
| `/admin` | `admin.html` | Admin UI; HTML is public, API gated by `ADMIN_USER_ID` |

`express.static` serves `public/` with `no-cache` on HTML/CSS/JS so iOS Safari picks up new builds without manual refresh; image/font caching is left default.

### Auth (three coexisting sources)

`server.js` recognizes users from three places, all writing to the same SQLite `sessions` table:

1. **`QMACH_USERS` env** — JSON array `[{id, password, name}]`. Passwords may be plaintext (legacy, warned at boot) or bcrypt (`$2[aby]$...`). `QMACH_PASSWORD` is a single-user fallback.
2. **DB users** (`users` table) — email + bcrypt signups via `POST /api/auth/signup`. Fresh schema added in `db/database.js`.
3. **Supabase Google OAuth** — frontend gets a Supabase session, posts the JWT to `/api/auth/google`, server verifies with Supabase REST and mints a local session. User IDs are prefixed `g:<email>` to keep them disjoint from password users.

`isOpenAccess()` returns true **only** when `QMACH_USERS` is empty AND the `users` table is empty. In that state every protected endpoint sees `req.userId = 'default'`. The first signup or env-config flips the whole app into auth-required mode automatically.

The auth middleware is one `app.use('/api/', ...)` block (around line 573) with a hardcoded `open` array of paths that bypass auth — `/voice/analyze`, `/voice/price`, `/config`, and the `/auth/*` family. Add new public endpoints by extending that array, not by reordering middleware.

### `/voice` token-spend defense

`/voice` is intentionally open to guests, so it has a layered stack to bound Anthropic spend. All counters live in the SQLite `voice_quota` table — persisted so a Railway restart doesn't reset the daily cap or hand every guest fresh quota:

1. `voiceLimiter` — 10 req/min/IP across `/api/voice/*`.
2. Per-IP guest quota — `GUEST_VOICE_LIMIT = 2` analyses per 24 h.
3. Per-cookie guest quota — signed httpOnly `_qg` cookie, same 24 h counter.
4. `Math.max(ip, cookie)` enforcement — bypass needs both rotated.
5. **Per-user authenticated cap** — `USER_VOICE_LIMIT` env (default 25/24h) on `/voice/analyze` + `/voice/price`. Catches runaway scripts and one-account abuse.
6. `VOICE_DAILY_CAP` (env, default 500) — server-wide kill switch on every voice call (auth + guest, analyze + price). 503 once tripped until UTC midnight.
7. Anthropic console monthly spend cap — out of band, must be set manually.

Counters bump only on **success** so failed calls don't burn quota. The `voice_quota` keys are `ip:<ip>`, `gid:<cookie>`, `user:<userId>`, `daily:YYYY-MM-DD`. `GUEST_COOKIE_SECRET` env signs the cookie. Full reference: `docs/voice-security.md`.

### AI integration

All Anthropic calls use `claude-opus-4-7` directly (no abstraction). Three patterns:

- **`/api/ai/suggest-price`** + **`/api/ai/generate-narrative`** — auth-only, called from the map quoter UI.
- **`/api/voice/analyze`** + **`/api/voice/price`** — guest-allowed, enforce the layered quota above.
- **`/api/ai/chat`** — trades-assistant chat used by the quoter UI.

The voice endpoints inject **calibration examples** via `db/kb.js` → `getRecentQuotesForIndustry(userId, industry, 5)`, which pulls the user's own recent quotes for the same `project_type` or `inferred_industry` so Q's pricing matches their patterns. Empty examples are sent on the very first analyze (no industry yet); `/voice/price` and continuation analyses pass `prior_context.inferred_industry` so calibration kicks in. New AI endpoints that should be calibrated to user history should follow the same pattern.

### Persistence

`db/database.js` opens `better-sqlite3` at `${RAILWAY_VOLUME_MOUNT_PATH}/quotemachine.db` (falls back to `./data/quotemachine.db` for dev). WAL mode + foreign keys on. Schema lives inline in `db/database.js` as `CREATE TABLE IF NOT EXISTS` — there is no migration system; add columns with idempotent `ALTER TABLE` guards in the same file or via `db.exec` on boot.

Tables: `quotes` (per-user, scoped via `user_id`, soft-delete via `deleted_at`), `sessions` (24 h TTL, capped at 1000 with oldest-evicted-first), `users` (DB signups), `voice_quota` (rate-limit counters), `email_only_signups` (soft-signup marketing list), `materials_kb` (industry application rates / pricing reference, seeded from `db/materials_seed.json` on every boot).

`quotes.user_id` references whichever ID source authenticated — `default` (open access), the QMACH_USERS id, the DB users PK, or `g:<email>` (Google), or `e:<email>` (email-only soft signup).

**Soft-delete on quotes:** `DELETE /api/quotes/:id` sets `deleted_at = Date.now()` by default; pass `?purge=1` to hard-delete. List endpoints filter `deleted_at IS NULL` by default; pass `?include_trash=1` or `?trash_only=1` to see soft-deleted rows. `POST /api/quotes/:id/restore` clears `deleted_at`. Stats and KB calibration both filter on `deleted_at IS NULL` so trash doesn't pollute analytics or AI prompts.

**Materials KB:** `db/kb.js` exports `getMaterialsForIndustry(industry, region='US')` returning seeded application/coverage rates (paint sqft/gal, sealcoat per-sqft, asphalt per-square, etc.). Both `/voice/price` and `/api/ai/suggest-price` inject these rows + the user's own pricing calibration (`getPricingCalibration`) into the Anthropic prompt as priority-ordered grounding: user's actual past pricing first, materials_kb numbers second, generic market range last. To add a row, edit `db/materials_seed.json` and redeploy — UPSERT on the deterministic id refreshes existing entries.

`db/backup.js` runs `VACUUM INTO` snapshots into `<volume>/backups/pquote-YYYY-MM-DD.db` — 30 s after boot then hourly (short-circuits if today's already exists). Retains 14 days. These protect against app-level corruption, not volume loss; pair with `/api/backup/download` for offsite copies.

### Deploy / infra

Railway, single service, Dockerfile-based (`node:20-alpine`, builds `better-sqlite3` natively via apk python3/make/g++). `railway.toml` mounts a volume at `/data` — that's `RAILWAY_VOLUME_MOUNT_PATH` and is where the DB and backups live. Env vars (set in Railway → Variables): `ANTHROPIC_API_KEY`, `MAPBOX_TOKEN`, `QMACH_USERS` or `QMACH_PASSWORD`, `ADMIN_USER_ID`, `VOICE_DAILY_CAP`, `GUEST_COOKIE_SECRET`, `CORS_ORIGIN`, `PZIP_WEBHOOK_URL` + `PZIP_API_KEY` (for the optional `/api/quotes/:id/send-to-pzip` invoice handoff to the sister pzip app).

`app.set('trust proxy', 1)` is required so `express-rate-limit` and the per-IP guest quota see the real client IP behind Railway's proxy — don't remove it.

### Landing-page assets

`public/promo.webm` (~1.5 MB, 30 fps VP9) is the rotating hero video showing both the voice-quote and map-quote flows end-to-end. It's tap-to-pause via a `<button>` wrapper around the `<video>` with a ▶ overlay synced to the video's pause/play events.

`public/hero-bg/*.jpg` are six satellite views (Mapbox Static API, public commercial properties only — never residential) cycling every 10 s as the hero backdrop at 32 % opacity behind a vignette.

Both assets are produced by tooling outside the repo at `C:\Users\Ross.Wearden\AppData\Local\Temp\pquote-browser-tests\`. See `docs/promo-video.md` for the re-record runbook. Memory file `reference_promo_assets_workflow.md` has the operational summary.

## Memory and conventions

`memory/MEMORY.md` is loaded into Claude's context every session. Read it first. Key flags currently:
- Frontend work for Ross uses the `frontend-design` skill, not generic CSS.
- Never use 11905 Metmora Ct or any personal address in demos / recordings / commits — public commercial addresses only (e.g., 1601 Bryan St, Dallas TX).
- The Synology NAS is not always powered on — don't propose it as a live cron host without confirming.
- Promo-video iteration has its own preferences captured (natural pace, end-to-end coverage, click rings, section labels).
- Playwright /app driving has well-known gotchas (service-tile auto-advance, AI-price modal flow, 30s default timeouts).
