# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
cp .env.example .env          # fill ANTHROPIC_API_KEY and MAPBOX_TOKEN
npm run dev                   # nodemon server.js
npm start                     # node server.js (what Railway runs)
npm run hash-password -- <pw> # prints a bcrypt hash for QMACH_USERS
```

There is no test runner, linter, or build step. The frontend is served as static files from `public/` — no bundling.

## Architecture

Single-process Express app (`server.js`, one file, all routes inline) + SQLite (`better-sqlite3`) + vanilla-JS SPA in `public/`. Designed to deploy to Railway as a Docker image with a persistent volume at `/data`.

### Data & persistence
- **DB file**: `${RAILWAY_VOLUME_MOUNT_PATH || ./data}/quotemachine.db`, opened in WAL mode. Schema lives in `db/database.js` (`quotes` + `sessions` tables).
- **Schema evolution**: new columns are added via `ALTER TABLE` blocks at the top of `server.js` (`// Auto-migrate` section). Add new columns there, not by editing the `CREATE TABLE` — existing deployments already have the table. `line_items`, `markup`, `user_id`, `tax_rate` were all added this way.
- **JSON columns**: `polygon_geojson` and `line_items` are stored as stringified JSON; stringify on write, parse on read. The stats query uses `json_each` to expand `line_items`.
- **Backups**: `db/backup.js` runs `VACUUM INTO` daily into `${data}/backups/pquote-YYYY-MM-DD.db`, keeps 14 days, hourly self-check short-circuits if today's snapshot exists. Downloadable via `/api/backup/download` (admin only).

### Auth (three modes, evaluated in this order)
1. **Multi-user**: `QMACH_USERS` is a JSON array `[{id, password, name}]`. `password` can be a bcrypt hash (`$2a$`/`$2b$`/`$2y$`) or plaintext — plaintext works but prints a boot-time warning. Generate hashes with `npm run hash-password`.
2. **Single-user**: `QMACH_PASSWORD` — all quotes belong to `user_id = "default"`.
3. **Open**: neither env var set — everyone is `user_id = "default"`, no login prompt.

**Google OAuth** (via Supabase, `/api/auth/google`) works alongside any of the above. Google user ids are prefixed `g:` to avoid collision with password-user ids. `GOOGLE_ALLOWED_EMAILS` is a comma-separated allowlist; entries starting with `@` are domain suffixes. Empty = open.

Sessions are rows in the `sessions` table keyed by a UUID token (client sends `x-auth-token` header). TTL 24h, capped at 1000 with oldest-eviction, pruned every 30 min. Persisted in SQLite so Railway redeploys don't log everyone out.

### Request pipeline
- `app.set('trust proxy', 1)` — Railway terminates TLS; required for rate-limit-by-IP.
- `helmet` with a hand-tuned CSP — if you add a new CDN (Mapbox tile host, Supabase URL, etc.), extend the matching directive in `server.js` or it will be blocked silently in the browser.
- CORS pinned to `pquote.ai`, `www.pquote.ai`, `localhost:3000`; override via `CORS_ORIGIN` (comma-separated).
- Rate limits: `/api/*` 60/min, `/api/ai/*` 20/min.
- Auth middleware is mounted on `/api/*` and skips `/api/auth*` and `/api/config`. It sets `req.userId` (and `req.userName`) for every downstream handler.

### Multi-tenant isolation
Every quote route filters by `user_id = req.userId`. When adding new routes that touch `quotes`, **always include `user_id` in the WHERE clause** — otherwise users will see each other's data.

### Admin surface
Endpoints under `/api/admin/*` and `/api/backup/*` are gated by `adminGate`, which requires `process.env.ADMIN_USER_ID` (or legacy `BACKUP_ADMIN_ID`) to equal `req.userId`. If neither env var is set, all admin endpoints return 403. The `/admin` page itself is public HTML; the client-side check in `admin.html` calls the gated endpoints and renders "not authorized" on 403.

### AI endpoints
`/api/ai/suggest-price`, `/api/ai/generate-narrative`, `/api/ai/chat` all call Anthropic via `@anthropic-ai/sdk`. The model in use is `claude-opus-4-6` — keep that unless explicitly asked to change it. `suggest-price` expects a JSON-only response and strips ```json fences before parsing; if you change its system prompt, preserve that contract. `chat` slices to the last 10 messages.

### Frontend
- `public/landing.html` is served at `/` (public marketing page).
- `public/index.html` is the SPA, served at `/app` and as the SPA catch-all for non-asset paths.
- `public/admin.html` at `/admin`.
- `public/404.html` is returned only for requests that look like missing static assets (path has a file extension); everything else falls through to the SPA so client-side routing works.
- `public/js/app.js` is one ~72KB vanilla-JS file — no framework, no bundler. State lives in module-scoped `let`s near the top. Auth token is kept in `sessionStorage` as `qmach_token`.
- Map is Mapbox GL JS loaded from CDN; token comes from `/api/config` (`MAPBOX_TOKEN` never ships in HTML).
- Supabase JS (also CDN) handles the Google OAuth redirect on the client; the returned access token is POSTed to `/api/auth/google`, which re-validates it against Supabase before issuing a pquote session.

## Conventions

- **One server file.** Don't split `server.js` into routers/controllers unless the task explicitly calls for it — all existing comments and admin/auth logic assume the single-file layout.
- **No new dependencies without reason.** The stack is deliberately small (Express, helmet, rate-limit, better-sqlite3, Anthropic SDK, bcryptjs, uuid). Prefer vanilla JS on the frontend.
- **Migrations go in the auto-migrate block** at the top of `server.js`, not in `db/database.js`.
- **Branch**: active development branch is `claude/add-claude-documentation-uiW4v` (per session config). `main` auto-deploys to Railway, so don't push directly.
- **Secrets**: `.env` is gitignored; `MAPBOX_TOKEN` is the only secret intentionally exposed to the browser (via `/api/config`).
