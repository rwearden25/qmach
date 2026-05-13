# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # install deps; better-sqlite3 builds a native binary
npm run dev            # nodemon — auto-restart on server.js changes
npm start              # plain `node server.js` (used in production)
npm run hash-password -- <password>   # bcrypt-hash a value for QMACH_USERS
node --check server.js                # syntax-check without booting (DB binary mismatch is common in dev)
node scripts/reconcile-pzip-invoices.js   # one-off maintenance script (read its header before running)
```

There is **no test suite, linter, or formatter** configured. Don't invent commands for tools that aren't installed. Don't add tooling unless asked.

Required env vars for boot: `ANTHROPIC_API_KEY`, `MAPBOX_TOKEN`. See `.env.example` for the full optional list (auth, Stripe, pzip integration, Google OAuth allowlist, voice abuse caps).

## Architecture

**Single-process Express app, SQLite for storage, no build step, no framework on the frontend.** Static HTML/CSS/JS in `public/` served directly. All routing, auth, AI calls, and webhook handling live in one file: `server.js` (~1500 lines, intentionally flat).

### Data layer
- **One SQLite DB** at `$RAILWAY_VOLUME_MOUNT_PATH/quotemachine.db` (falls back to `./data/` locally). WAL mode. The Railway volume is the single source of truth — there is no replica.
- Schema in `db/database.js` — `quotes`, `sessions`, `users`. Schema changes are layered as `ALTER TABLE` auto-migrations at the top of `server.js` (search for `[DB] Added`) rather than versioned migration files. **Add new columns there**, not by editing the `CREATE TABLE` alone, or existing deployments won't pick them up.
- `db/backup.js` runs daily `VACUUM INTO` snapshots into `<volume>/backups/`, kept 14 days. Same-volume only — pair with `/api/backup/download` for offsite copies.
- `db/kb.js` is the calibration helper: returns a user's recent quotes by industry to seed AI prompts with their actual pricing.

### Auth — three coexisting paths
All three resolve to the same `req.userId` downstream. The middleware at `app.use('/api/', ...)` enforces auth on every `/api/*` route except an explicit open list (search for `const open = [`).

1. **Email + bcrypt** (primary). Signup writes to `users` table; `users.id === users.email`. Sessions live in SQLite (`sessions` table), 24h TTL, capacity-capped at 1000, identified by `x-auth-token` header.
2. **Google OAuth** via Supabase. The frontend gets a Supabase access token; `/api/auth/google` validates it against Supabase, applies the `GOOGLE_ALLOWED_EMAILS` allowlist (entries starting with `@` are domain suffixes), creates a session with `userId = 'g:' + email`. **Google users have no `users` row**, which matters for billing.
3. **Legacy env users** — `QMACH_USERS` (JSON array) or single-user `QMACH_PASSWORD`. Plaintext passwords still work but log a boot-time warning; hash with `npm run hash-password`.

`isOpenAccess()` grants `userId='default'` only when both env users AND the `users` table are empty — fresh-install convenience that flips off the moment anyone signs up.

### Pages
- `/` → `landing.html` — marketing; design system: Playfair Display + Nunito + DM Mono on a sand/dark/forest-green palette ("Rugged Precision"). **Any new public page must match this aesthetic** — see `memory/feedback_frontend_design.md`. Invoke `/frontend-design:frontend-design` before writing generic CSS.
- `/app` → `index.html` — the authenticated SPA (map, drawing tools, quote editor, AI chat). All logic in `public/js/app.js`.
- `/voice` → `voice.html` — open voice-quote flow for guests, defended by a 6-layer abuse stack (see `docs/voice-security.md`).
- `/billing` → `billing.html` — Stripe subscription management.
- `/admin` → `admin.html` — admin UI gated by `ADMIN_USER_ID`.

### AI calls (all via Anthropic SDK, model `claude-opus-4-7`)
- `/api/ai/suggest-price`, `/api/ai/generate-narrative`, `/api/ai/chat` — auth'd.
- `/api/voice/analyze`, `/api/voice/price` — open to guests. Both burn tokens, so they're behind a stack of caps: 10/min IP rate limit → 2-per-24h guest cap (MAX of IP-keyed and HMAC-signed-cookie-keyed counters, so bypass needs rotating both) → server-wide daily kill switch (`VOICE_DAILY_CAP`, default 500) → Anthropic console cap. **Don't loosen any of these without reading `docs/voice-security.md`.** Counter bumps happen only on success so failures don't burn quota.

### Stripe billing
- Webhook at `/api/stripe/webhook` is mounted **before** `express.json()` because signature verification needs the raw body — keep it that way. Auth middleware also bypasses it because Stripe doesn't send our session token.
- Webhook updates the `users` row directly; everything else (`/api/billing/status`, `/billing` page) reads from the DB, never from Stripe live. Source of truth for plan is `users.plan` (`'free' | 'pro'`), updated by `applySubscriptionToUser()` whenever a `customer.subscription.*` event fires.
- Billing is gated to DB-registered users only. Google OAuth (`g:` prefix) and env-configured users get a 403 — they have nowhere to hang `stripe_customer_id`.
- Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY` (a `price_xxx` ID). Optional `APP_BASE_URL` overrides the request-derived host for success/cancel URLs.

### Integrations
- **Mapbox** — token is server-held; `/api/config` ships it to the frontend.
- **pzip.ai** — `POST /api/quotes/:id/send-to-pzip` ships a saved quote as a draft invoice. Idempotent via `external_id = qmach:<uuid>`. Tax is sent as a dollar amount under `tax` (not `tax_rate`) to avoid the percent-vs-fraction mismatch that previously inflated invoices 100×. Requires `PZIP_WEBHOOK_URL` + `PZIP_API_KEY`.

### Deploy (Railway)
- `Dockerfile` (Node 20-alpine) and `railway.toml` define the deploy. A Railway **Volume** mounted at `/data` is what makes `RAILWAY_VOLUME_MOUNT_PATH` populate — without it, the SQLite DB doesn't persist across deploys.
- `APP_VERSION` constant near the bottom of `server.js` is bumped on intentional deploys; `/version` returns it. If `/version` doesn't reflect the merge within ~2min, the container didn't swap and a manual Redeploy is needed.

## Conventions

- **One file, flat structure.** `server.js` is intentionally not split into routers/services. Don't refactor it without being asked.
- **No frontend framework.** No React, no bundler. Hand-written HTML/CSS/JS per page. Auth token lives in `sessionStorage['qmach_token']`; reads use `headers: { 'x-auth-token': token }`.
- **Comments explain *why*, not *what*.** The existing comments in `server.js` are the bar — preserve them, don't strip them, and when adding non-obvious code (security guards, ordering requirements, integration quirks) add a short comment in the same voice.
- **Don't introduce backwards-compat shims for code you control.** The legacy `QMACH_USERS` path stays because real deployments rely on it; new code should not add similar layers speculatively.
