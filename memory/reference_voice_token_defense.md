---
name: Voice quote token-spend defense stack
description: Where the voice flow's anti-abuse / token-spend protection lives, the env vars that tune it, and the manual Anthropic-console step that backs it
type: reference
---

The pquote `/voice` flow is open to unauthenticated guests, so it's protected by a layered token-spend defense. All code is in `server.js`. Full reference doc: `docs/voice-security.md`.

**Stack (from cheap-to-bypass to ultimate ceiling):**

1. `voiceLimiter` — express-rate-limit, **10 req/min per IP** on `/api/voice/*`. Defined near the other rate limiters in `server.js`.
2. **Per-IP guest quota** — `bumpGuestVoice('ip:<ip>')`, 24h rolling window, default 2 successful analyses.
3. **Per-cookie guest quota** — signed httpOnly `_qg` cookie issued on first analyze (`ensureGuestCookie`). Tracks the BROWSER, not the network.
4. **MAX(IP, cookie) check** — quota enforcement in `/api/voice/analyze` takes the larger of the two counters. To bypass, an attacker must rotate BOTH on every request.
5. `VOICE_DAILY_CAP` — env var (default `500`) — server-wide daily kill switch on every voice call (analyze + price). 503 `daily_cap_reached` once exceeded.
6. **Anthropic console spend cap** — set at https://console.anthropic.com/settings/limits as the final ceiling; not configured from code.

**Tunable env vars (set in Railway → pquote service → Variables):**
- `VOICE_DAILY_CAP` — integer, default 500
- `GUEST_COOKIE_SECRET` — hex string, default random per-boot (override for cookie persistence across restarts)

**To raise/lower the guest quota itself**, edit the `GUEST_VOICE_LIMIT = 2` constant in `server.js` (no env var, would need a code change).

**Verify it's live:** GET `/version` returns the current build stamp; `/api/voice/analyze` 403s with `guest_limit_reached` after `GUEST_VOICE_LIMIT` calls; `/api/voice/analyze` and `/api/voice/price` both 503 with `daily_cap_reached` after `VOICE_DAILY_CAP` calls.
