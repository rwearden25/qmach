# Voice quote token-spend defense

The `/voice` flow is intentionally open to unauthenticated guests so people can try pquote before signing up. That openness is a token-spend risk — a bot or one ambitious user could rack up an Anthropic bill in minutes if there were no guard rails. This doc lists every layer that's in place, what each one protects against, and where to tune them.

All code lives in `server.js`. Bumping numbers usually means changing a constant or env var; only the per-guest limit needs a real code change.

## The stack (from cheap-to-bypass to absolute ceiling)

### 1. Per-IP rate limit — `voiceLimiter`

```
10 requests per minute per IP, applied to /api/voice/*
```

Guards against bursting. A normal user submits one quote and refines it 2–3 times; even an aggressive flow is well under the limit. An attacker hitting the endpoint in a tight loop is throttled within a second.

**Bypass cost:** Trivial (use a different IP).
**Configure:** `voiceLimiter` in `server.js`, near the other `rateLimit(...)` definitions.

### 2. Per-IP guest quota

```
GUEST_VOICE_LIMIT = 2 successful /voice/analyze calls per IP per 24h
```

After two successful "quotes" from the same IP, the third returns `403 { error: 'guest_limit_reached' }`. Failed analyses don't burn the quota. `/voice/price` is **not** counted (it's the in-quote refinement loop, not a new quote).

**Bypass cost:** Need a different IP for each pair of quotes.
**Configure:** `GUEST_VOICE_LIMIT` constant in `server.js`. No env var; needs a code change.

### 3. Per-cookie guest quota — signed httpOnly `_qg`

A signed httpOnly cookie is issued on the first guest analyze call. Every subsequent analyze for the same browser counts against the same `gid:<cookie>` counter as the IP one.

```
Cookie:    _qg=<random-hex>.<hmac-sig>
Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000  (30 days)
```

The cookie tracks the **browser**, not the network — so a single mobile user who switches between WiFi and LTE doesn't get extra free quotes, and a NAT'd office where 50 people share an IP still gets 50 individual quotas instead of all sharing one.

**Bypass cost:** Need to clear cookies AND use a fresh browser/private window each time.
**Configure:** `GUEST_COOKIE_SECRET` env var (default: random per-boot — fine for the 24h quota window since the worst case after a deploy is everyone gets fresh quota).

### 4. MAX(IP, cookie) enforcement

The quota check in `/api/voice/analyze` reads both counters and takes the **larger** of the two:

```js
const used = Math.max(readGuestVoice('ip:'+req.ip), readGuestVoice('gid:'+guestId));
if (used >= GUEST_VOICE_LIMIT) return 403;
```

**Bypass cost:** Need to rotate **both** the cookie and the IP on every request — significantly harder than just cycling proxies. A determined attacker still can, but it's no longer a one-line script.

### 5. Server-wide daily kill switch — `VOICE_DAILY_CAP`

```
VOICE_DAILY_CAP = 500 (default)
```

A counter that tracks **every** voice call (analyze + price, auth + guest) for the current UTC day. Once the cap is hit, both endpoints return `503 { error: 'daily_cap_reached' }` until midnight UTC.

This is the **bounded worst case**. Even if every other layer is bypassed by a coordinated proxy attack, your token spend cannot exceed `VOICE_DAILY_CAP` calls per day.

At Opus 4.7 rates with the current prompts:
- analyze ≈ 800 max_tokens out, ~500 in → ~$0.04 / call
- price ≈ 400 max_tokens out, ~300 in → ~$0.02 / call

`500/day` ≈ **$15–$20/day max** if it gets fully drained. Adjust `VOICE_DAILY_CAP` to fit your budget tolerance.

**Configure:** Set the `VOICE_DAILY_CAP` env var in Railway → pquote service → Variables. No code change.

### 6. Anthropic console spend cap

The absolute ceiling, sitting outside our app entirely. **Configure this manually:**

1. Go to https://console.anthropic.com/settings/limits
2. Set a **Monthly spend limit** (e.g. $100)
3. Add **alert thresholds** at 50% / 75% / 90%

If everything else fails, Anthropic will reject API calls past the cap and bill you nothing more. **This should always be set** — it's the only layer that can't be defeated by a bug in our own code.

## Authenticated users bypass guest quotas

Layers 2–4 (per-IP, per-cookie, MAX) are only enforced when `req.userId` is unset. Logged-in users hit only the per-IP rate limit (layer 1) and the daily cap (layer 5).

If you want to add an authenticated per-user quota too, the same `bumpGuestVoice` / `readGuestVoice` machinery can be keyed on `userId:<id>` — already structured for it.

## Where each layer lives in the code

| Layer | Location in `server.js` |
|---|---|
| 1. Voice rate limit | `voiceLimiter` constant near other `rateLimit(...)` definitions |
| 2/3/4. Guest quota | `GUEST_VOICE_LIMIT`, `guestVoiceUsage`, `readGuestVoice`, `bumpGuestVoice`, `ensureGuestCookie`, enforcement inside `/api/voice/analyze` |
| 5. Daily cap | `VOICE_DAILY_CAP`, `checkVoiceDailyCap`, `bumpVoiceDaily`, called at top of both `/voice/analyze` and `/voice/price` |
| 6. Anthropic cap | Out-of-band — set in Anthropic console |

## How to verify the stack is live

`/version` returns the active build stamp — the short SHA of the deployed commit, derived from `RAILWAY_GIT_COMMIT_SHA` at boot. Compare it against the SHA you expect to be live; if they don't match within ~2 min of merge, the Railway container didn't swap and a manual Redeploy is needed.

To prove the quota works end-to-end on production:

```bash
# 1. Confirm /version is the latest deploy
curl -s https://www.pquote.ai/version

# 2. Burn 2 free quotes from a fresh cookie jar
for i in 1 2; do
  curl -s -c /tmp/cj -b /tmp/cj -X POST https://www.pquote.ai/api/voice/analyze \
    -H "Content-Type: application/json" \
    -d '{"transcript":"pressure wash 2000 sqft house"}' | head -c 200
  echo
done

# 3. Third call should return 403 guest_limit_reached
curl -s -c /tmp/cj -b /tmp/cj -X POST https://www.pquote.ai/api/voice/analyze \
  -H "Content-Type: application/json" \
  -d '{"transcript":"pressure wash 2000 sqft house"}'
# → {"error":"guest_limit_reached","message":"You've used your 2 free quotes...",...}
```

## Operational checklist

- [ ] `VOICE_DAILY_CAP` env var set in Railway to your tolerance (default 500)
- [ ] `GUEST_COOKIE_SECRET` env var set in Railway (optional — random per-boot is fine for the 24h quota window)
- [ ] Anthropic console monthly spend limit set with alert thresholds
- [ ] Railway log monitoring is on (boot logs include `[Boot] pquote APP_VERSION = ...`)
- [ ] Set up an alert on Railway logs for repeated `daily_cap_reached` 503s — that's the signal someone is actively trying to drain you

## Future hardening options (not implemented)

- **hCaptcha / Cloudflare Turnstile on first guest call** — proves the request is from a human; significantly raises the cost of automated abuse. Adds ~1s of UX friction.
- **Per-user authenticated quota** — extend `bumpGuestVoice` to a `userId:<id>` key with a higher limit (e.g. 50/day for free accounts, unlimited for paid).
- **Token-accounting estimation** — track approximate tokens used per guest/day instead of just call count, since some prompts cost more than others.
- **Sliding-window cap instead of UTC-day reset** — smoother behavior near midnight; minor UX win, slightly more code.

The current 6-layer stack is enough for normal real-world abuse. Add to it when traffic justifies the complexity.
