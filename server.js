require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('./db/database');
const { getRecentQuotesForIndustry, getPricingCalibration, getMaterialsForIndustry } = require('./db/kb');
const backup = require('./db/backup');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway / any reverse proxy terminates TLS and forwards X-Forwarded-For.
// Required so express-rate-limit sees the real client IP instead of the proxy.
app.set('trust proxy', 1);

// ── Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ══════════════════════════════════════════
//  STRIPE BILLING
// ══════════════════════════════════════════
// stripe is optional — the app boots fine without it (billing endpoints
// return 503 until STRIPE_SECRET_KEY is set). Webhook is mounted directly
// below this block, BEFORE express.json(), because Stripe needs the raw
// request body to verify the signature.
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_PRO      = process.env.STRIPE_PRICE_PRO_MONTHLY || '';
const APP_BASE_URL          = process.env.APP_BASE_URL || ''; // optional override
const BILLING_SUCCESS_PATH  = process.env.STRIPE_BILLING_SUCCESS_URL || '/billing?status=success';
const BILLING_CANCEL_PATH   = process.env.STRIPE_BILLING_CANCEL_URL  || '/billing?status=canceled';

if (stripe) {
  console.log(`[Stripe] ✓ Configured${STRIPE_PRICE_PRO ? ` (price: ${STRIPE_PRICE_PRO})` : ' — set STRIPE_PRICE_PRO_MONTHLY to enable checkout'}`);
} else {
  console.log('[Stripe] ✗ Not configured (set STRIPE_SECRET_KEY to enable billing)');
}

// Resolve the public base URL for Stripe redirects. Prefer APP_BASE_URL env,
// otherwise reconstruct from the request — Railway sets X-Forwarded-Proto so
// req.protocol respects HTTPS once `trust proxy` is on (set above).
function resolveBaseUrl(req) {
  if (APP_BASE_URL) return APP_BASE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// Mirror Stripe subscription state into the users row. Called by the webhook
// after every subscription.created / .updated / .deleted event so the DB is
// the source of truth for plan + status (no live Stripe lookups on hot paths).
function applySubscriptionToUser(customerId, subscription) {
  if (!customerId) return;
  const status = subscription?.status || null;
  // 'active' and 'trialing' are paying states; everything else (past_due,
  // canceled, unpaid, incomplete) drops the user back to free. Keeps gating
  // logic dumb: `plan === 'pro'` is the only thing callers check.
  const isPaying = status === 'active' || status === 'trialing';
  const plan = isPaying ? 'pro' : 'free';
  const periodEnd = subscription?.current_period_end
    ? subscription.current_period_end * 1000
    : null;
  const subId = subscription?.id || null;
  db.prepare(`
    UPDATE users
       SET plan = ?, subscription_status = ?, stripe_subscription_id = ?, current_period_end = ?
     WHERE stripe_customer_id = ?
  `).run(plan, status, subId, periodEnd, customerId);
}

// ── Free-tier limits. Pro users skip both checks entirely. Counters live in
// SQLite (db/database.js → usage_counters), keyed by (user_id, period, kind)
// where period = 'YYYY-MM' UTC. New month → fresh quota with zero code work.
const FREE_QUOTES_PER_MONTH = 5;
const FREE_AI_PER_MONTH     = 5;

function currentPeriod() {
  // UTC YYYY-MM. Using UTC (not local) so a midnight-local request doesn't
  // get split into two periods depending on which container processes it.
  return new Date().toISOString().slice(0, 7);
}
function effectivePlan(userId) {
  if (!userId) return 'free';
  try {
    const row = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
    return row?.plan === 'pro' ? 'pro' : 'free';
  } catch { return 'free'; }
}
function getUsage(userId, kind) {
  try {
    const row = db.prepare('SELECT count FROM usage_counters WHERE user_id = ? AND period = ? AND kind = ?')
      .get(userId, currentPeriod(), kind);
    return row?.count || 0;
  } catch { return 0; }
}
// UPSERT — atomic increment that creates the row on first call.
const bumpUsageStmt = db.prepare(`
  INSERT INTO usage_counters (user_id, period, kind, count) VALUES (?, ?, ?, 1)
  ON CONFLICT(user_id, period, kind) DO UPDATE SET count = count + 1
`);
function bumpUsage(userId, kind) {
  if (!userId) return;
  // Skip bumping for Pro users. They're never gated by counters, but if we
  // wrote rows for them, a mid-month downgrade would surface their old
  // Pro-era usage as a now-applicable cap and gate them retroactively.
  if (effectivePlan(userId) === 'pro') return;
  try { bumpUsageStmt.run(userId, currentPeriod(), kind); } catch (e) {
    // Don't fail the user-facing request just because the counter wrote badly.
    console.warn('[Usage] bump failed:', e.message);
  }
}

// Middleware factories — return Express middleware that 429s when over quota.
function checkQuota(kind, limit, label) {
  return (req, res, next) => {
    if (!req.userId) return next();                       // guests handled elsewhere
    if (effectivePlan(req.userId) === 'pro') return next();
    const used = getUsage(req.userId, kind);
    if (used >= limit) {
      return res.status(429).json({
        error: `${kind}_limit_reached`,
        message: `Free plan is limited to ${limit} ${label} per month. Upgrade to pquote Pro for unlimited.`,
        limit,
        used,
        upgrade_url: '/billing',
      });
    }
    next();
  };
}
const checkQuoteQuota = checkQuota('quote', FREE_QUOTES_PER_MONTH, 'saved quotes');
const checkAiQuota    = checkQuota('ai',    FREE_AI_PER_MONTH,     'AI actions');

// Hard Pro gate — 402 (Payment Required) when the user isn't on Pro.
function requirePro(req, res, next) {
  if (effectivePlan(req.userId) === 'pro') return next();
  res.status(402).json({
    error: 'pro_required',
    message: 'This feature requires pquote Pro.',
    upgrade_url: '/billing',
  });
}

// Webhook MUST be registered before express.json() — Stripe's signature
// check verifies the raw request bytes, and json() consumes the body stream.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe webhook not configured');
  }
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Stripe] Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        // First time a user pays — link the new Stripe customer to their pquote
        // account via client_reference_id (we set it = users.id on checkout).
        const s = event.data.object;
        const userId     = s.client_reference_id;
        const customerId = s.customer;
        if (userId && customerId) {
          db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ? AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)')
            .run(customerId, userId, customerId);
        }
        // The subscription.created event fires alongside this and carries the
        // full subscription object — let that handler set the plan/status so
        // we don't double-write here.
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        applySubscriptionToUser(sub.customer, sub);
        break;
      }
      case 'invoice.payment_failed': {
        // Subscription will transition to past_due/unpaid via a separate
        // subscription.updated event; we just log here for visibility.
        const inv = event.data.object;
        console.warn(`[Stripe] payment_failed for customer ${inv.customer} (invoice ${inv.id})`);
        break;
      }
      default:
        // Unhandled event types are normal — Stripe sends many we don't care about.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[Stripe] Webhook handler error:', err);
    // Return 500 so Stripe retries — better than silently swallowing.
    res.status(500).send('Webhook handler error');
  }
});

// ══════════════════════════════════════════
//  MULTI-USER AUTH
// ══════════════════════════════════════════
//
//  Option A (recommended): Set QMACH_USERS as a JSON array in Railway:
//    [{"id":"ross","password":"mypass1","name":"Ross"},{"id":"mike","password":"mypass2","name":"Mike"}]
//
//  Option B (backward compat): Set QMACH_PASSWORD for single-user mode
//    All quotes belong to user_id = "default"
//
// ══════════════════════════════════════════

let USERS = []; // { id, password, name }

// Parse QMACH_USERS if set
if (process.env.QMACH_USERS) {
  try {
    USERS = JSON.parse(process.env.QMACH_USERS);
    if (!Array.isArray(USERS) || USERS.length === 0) throw new Error('Empty array');
    // Validate each user has id + password
    USERS = USERS.filter(u => u.id && u.password);
    console.log(`[Auth] Multi-user mode: ${USERS.length} users configured`);
  } catch (err) {
    console.error('[Auth] Failed to parse QMACH_USERS:', err.message);
    USERS = [];
  }
}

// Fallback: single-user mode with QMACH_PASSWORD
if (USERS.length === 0 && process.env.QMACH_PASSWORD) {
  USERS = [{ id: 'default', password: process.env.QMACH_PASSWORD, name: 'Admin' }];
  console.log('[Auth] Single-user mode (QMACH_PASSWORD)');
}

// Warn once at boot if any user still has a plaintext password. Not fatal —
// we keep supporting plaintext for migration — but visible in logs so it
// doesn't become a forgotten gap.
const plaintextUsers = USERS.filter(u => u.password && !/^\$2[aby]\$/.test(u.password));
if (plaintextUsers.length > 0) {
  console.warn(`[Auth] ⚠️  ${plaintextUsers.length} user(s) have plaintext passwords: ${plaintextUsers.map(u => u.id).join(', ')}`);
  console.warn('[Auth] ⚠️  Run `npm run hash-password -- <password>` and replace the plaintext values in QMACH_USERS.');
}

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SESSIONS = 1000; // prevent session DoS

// Sessions live in SQLite (table defined in db/database.js) so a deploy/restart
// doesn't force every signed-in user to re-authenticate.
const insertSessionStmt = db.prepare('INSERT INTO sessions (token, user_id, user_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
const getSessionStmt    = db.prepare('SELECT user_id, user_name, created_at, expires_at FROM sessions WHERE token = ?');
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token = ?');
const pruneSessionsStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
const countSessionsStmt = db.prepare('SELECT COUNT(*) AS n FROM sessions');
const oldestSessionStmt = db.prepare('SELECT token FROM sessions ORDER BY created_at ASC LIMIT 1');

// DB-backed users (new email+password signup flow).
const insertUserStmt     = db.prepare('INSERT INTO users (id, email, password_hash, first_name, last_name, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const getUserByEmailStmt = db.prepare('SELECT id, email, password_hash, first_name, last_name FROM users WHERE email = ?');
const countUsersStmt     = db.prepare('SELECT COUNT(*) AS n FROM users');

// Email-only "soft signup" — captures an email for the marketing list and
// upgrades the caller from the 1-quote anon cap to the regular per-user cap.
// They get range-only pricing and a watermarked PDF until they upgrade to
// a full account (email + password or Google sign-in).
const upsertEmailOnlyStmt = db.prepare(`
  INSERT INTO email_only_signups (email, created_at, last_seen) VALUES (?, ?, ?)
  ON CONFLICT(email) DO UPDATE SET last_seen = excluded.last_seen
`);
const countEmailOnlyStmt = db.prepare('SELECT COUNT(*) AS n FROM email_only_signups');

// User tier — drives pricing precision, PDF watermark, and quote-cap level.
//   'full'        — req.userId is set and not a soft signup (DB user, env user, Google)
//   'email_only'  — req.userId starts with 'e:' (soft signup via /api/auth/email-only)
//   'anon'        — no req.userId at all
function getUserTier(req) {
  if (!req.userId) return 'anon';
  if (typeof req.userId === 'string' && req.userId.startsWith('e:')) return 'email_only';
  return 'full';
}

// Open-access check: honored by the auth middleware and /api/auth/check.
// Returns true only when BOTH env-configured users (QMACH_USERS/PASSWORD)
// AND the DB users table are empty — a fresh install with no accounts yet.
// Once any user exists (env or DB), every protected endpoint requires a
// valid session, even if QMACH_USERS is still unset.
function isOpenAccess() {
  if (USERS.length > 0) return false;
  try { return countUsersStmt.get().n === 0; } catch { return true; }
}

function createSession(userId, userName) {
  // Evict oldest if at capacity (DoS prevention).
  if (countSessionsStmt.get().n >= MAX_SESSIONS) {
    const oldest = oldestSessionStmt.get();
    if (oldest) deleteSessionStmt.run(oldest.token);
  }
  const token = uuidv4();
  const now = Date.now();
  insertSessionStmt.run(token, userId, userName || userId, now, now + SESSION_TTL);
  return token;
}

function sessionCount() { return countSessionsStmt.get().n; }

// Prune expired rows every 30 min. Also runs once at boot to clear anything
// left over from a previous deploy.
pruneSessionsStmt.run(Date.now());
setInterval(() => {
  try { pruneSessionsStmt.run(Date.now()); } catch {}
}, 30 * 60 * 1000);

// ── Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // challenges.cloudflare.com hosts the Turnstile bootstrap script + iframe.
      // Always whitelisted (not gated on env vars) so a future deploy with a
      // site key set doesn't get a CSP-block surprise — leaving CF on the
      // allowlist is a tiny extension of an already external-script-friendly
      // policy (Mapbox, jsdelivr, cdnjs all here).
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "api.mapbox.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "challenges.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "api.mapbox.com", "fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "*.mapbox.com", "api.mapbox.com"],
      connectSrc: ["'self'", "api.mapbox.com", "events.mapbox.com", "*.tiles.mapbox.com", "*.supabase.co", "cdn.jsdelivr.net"],
      workerSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "fonts.gstatic.com", "fonts.googleapis.com"],
      frameSrc: ["challenges.cloudflare.com"]
    }
  }
}));
// Pin CORS to known origins by default. `CORS_ORIGIN` (comma-separated) can
// override. Same-origin requests (no Origin header) are always allowed.
const CORS_ORIGINS = (process.env.CORS_ORIGIN ||
  'https://pquote.ai,https://www.pquote.ai,http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl, same-origin, server-to-server
    cb(null, CORS_ORIGINS.includes(origin) || CORS_ORIGINS.includes('*'));
  },
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));
// Serve /public with no-cache headers on HTML/CSS/JS so deploys are
// picked up immediately. iOS Safari caches static files aggressively
// even in private mode otherwise. Images and fonts can still cache.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    if (/\.(?:html|css|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// ── Rate limiters
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const aiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: 'Too many AI requests, slow down.' } });
// Stricter limit on password-testing endpoints — the 60/min api limit is
// too generous for credential stuffing. Successful requests don't count,
// so a legitimate user who fat-fingers once doesn't get locked out after
// finally logging in. Applied per-IP via express-rate-limit defaults.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { success: false, error: 'Too many login attempts — try again in a few minutes.' }
});

app.use('/api/', apiLimiter);
app.use('/api/ai/', aiLimiter);
// Voice endpoints hit Anthropic too. Tighter cap (10/min) than the auth'd
// /api/ai/* routes since /voice/* is open to unauthenticated guests.
const voiceLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many voice requests — slow down or sign in.' },
});
app.use('/api/voice/', voiceLimiter);

// ── Voice quota counters — SQLite-backed (table: voice_quota in db/database.js)
//    Persistence matters: when these were in-memory Maps, every Railway
//    restart reset every counter, which meant the "absolute daily ceiling"
//    layer wasn't actually a ceiling — auto-deploy on push to main reset
//    the counter on every push, and a coordinated attack could drain
//    multiple full-day caps in an hour by triggering restarts.
//
//    Defense-in-depth (see docs/voice-security.md for full layer breakdown):
//      ip:<addr>         → per-IP guest analyses (24h)
//      gid:<cookie>      → per-cookie guest analyses (24h)
//      MAX(ip,gid)       → enforced for guests so bypass needs BOTH rotated
//      user:<userId>     → per-authenticated-user analyses (24h) — added so
//                          one signed-in user can't drain the daily budget
//      daily:YYYY-MM-DD  → server-wide kill switch across all callers
// Anon guests get ONE quote — see the user's last quote, taste the product,
// then either give up an email (email_only tier) or sign up properly. The
// previous "2 free quotes" was generous for testing but blew up conversion
// pressure at the wall.
const GUEST_VOICE_LIMIT  = 1;
const GUEST_VOICE_WINDOW = 24 * 60 * 60 * 1000; // 24h

// Cookie signing — uses an env secret if set, otherwise a random per-boot
// secret. Per-boot is fine because cookies only need to be valid for the
// 24h quota window; the worst case after a deploy/restart is everyone gets
// fresh quota, which is consistent with the IP fallback resetting on the
// same cadence anyway.
const GUEST_COOKIE_NAME   = '_qg';
const GUEST_COOKIE_SECRET = process.env.GUEST_COOKIE_SECRET ||
  crypto.randomBytes(32).toString('hex');
const GUEST_COOKIE_TTL    = 30 * 24 * 60 * 60 * 1000; // 30d

function signGuestCookie(value) {
  const sig = crypto.createHmac('sha256', GUEST_COOKIE_SECRET)
    .update(value).digest('hex').slice(0, 16);
  return `${value}.${sig}`;
}
function verifyGuestCookie(signed) {
  if (!signed || typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const sig   = signed.slice(i + 1);
  if (!sig || sig.length !== 16) return null;
  const expected = crypto.createHmac('sha256', GUEST_COOKIE_SECRET)
    .update(value).digest('hex').slice(0, 16);
  try {
    if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return value;
  } catch { /* length mismatch */ }
  return null;
}
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const pair of h.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// SQL prepared statements for the voice_quota table. better-sqlite3 is
// synchronous so the read-then-write pattern is race-free without explicit
// transactions for this volume.
const readQuotaStmt   = db.prepare('SELECT count, first_at FROM voice_quota WHERE key = ?');
const insertQuotaStmt = db.prepare('INSERT INTO voice_quota (key, count, first_at, last_at) VALUES (?, 1, ?, ?)');
const resetQuotaStmt  = db.prepare('UPDATE voice_quota SET count = 1, first_at = ?, last_at = ? WHERE key = ?');
const incQuotaStmt    = db.prepare('UPDATE voice_quota SET count = count + 1, last_at = ? WHERE key = ?');
const deleteQuotaStmt = db.prepare('DELETE FROM voice_quota WHERE key = ?');
const pruneQuotaStmt  = db.prepare('DELETE FROM voice_quota WHERE first_at < ?');

function readVoiceQuota(key, windowMs) {
  const row = readQuotaStmt.get(key);
  if (!row) return 0;
  if (Date.now() - row.first_at > windowMs) {
    deleteQuotaStmt.run(key);
    return 0;
  }
  return row.count;
}
function bumpVoiceQuota(key, windowMs) {
  const now = Date.now();
  const row = readQuotaStmt.get(key);
  if (!row) {
    insertQuotaStmt.run(key, now, now);
    return 1;
  }
  if (now - row.first_at > windowMs) {
    resetQuotaStmt.run(now, now, key);
    return 1;
  }
  incQuotaStmt.run(now, key);
  return row.count + 1;
}

// Backwards-compatible names — the rest of server.js still calls these.
function readGuestVoice(key) { return readVoiceQuota(key, GUEST_VOICE_WINDOW); }
function bumpGuestVoice(key) { return bumpVoiceQuota(key, GUEST_VOICE_WINDOW); }

// Prune rows older than 48h. The longest active window is 24h (per-IP/cookie/user)
// and daily:YYYY-MM-DD rows are dead weight after their day rolls over, so 48h
// is plenty of slack. The earlier 7-day window let stale single-visit IP/cookie
// rows accumulate unboundedly under traffic — every distinct guest IP that
// never came back sat in the table for a week.
setInterval(() => {
  try { pruneQuotaStmt.run(Date.now() - 48 * 60 * 60 * 1000); } catch {}
}, 60 * 60 * 1000);

// ── Server-wide daily voice cap (token-spend ceiling)
//    Counts ALL /voice/analyze + /voice/price calls regardless of auth.
//    Returns 503 once exceeded so the client shows a friendly "we're at
//    capacity, try again tomorrow" instead of burning more tokens. Default
//    of 500 ≈ $15/day worst case at Opus 4.7 rates; raise/lower via env.
const VOICE_DAILY_CAP = parseInt(process.env.VOICE_DAILY_CAP || '500', 10);
function todayUtcKey() { return 'daily:' + new Date().toISOString().slice(0, 10); }
function checkVoiceDailyCap() {
  // 48h window so the row stays alive for the full UTC day even at edges.
  return readVoiceQuota(todayUtcKey(), 48 * 60 * 60 * 1000) < VOICE_DAILY_CAP;
}
function bumpVoiceDaily() {
  bumpVoiceQuota(todayUtcKey(), 48 * 60 * 60 * 1000);
}

// ── Cloudflare Turnstile (CAPTCHA) — gated on env vars
//    Set TURNSTILE_SITE_KEY (public, ships to client via /api/config) and
//    TURNSTILE_SECRET_KEY (server only) to enable a human-check on guest
//    voice analyze. With both unset, this is a complete no-op and the flow
//    behaves exactly as before — so deploying the integration is decoupled
//    from registering a site at https://dash.cloudflare.com/?to=/:account/turnstile.
//
//    Why: the cookie+IP MAX layer of the voice defense is partly defeated
//    by iOS Safari ITP (cookie drops) and CGNAT (shared IPs), so a real
//    human-check is the proper backstop. We only require it for guests
//    because authenticated users are bounded by the per-user cap above.
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return { ok: true, skipped: true }; // disabled
  if (!token) return { ok: false, error: 'turnstile_token_missing' };
  try {
    const params = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
    if (ip) params.set('remoteip', ip);
    const r = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await r.json().catch(() => ({}));
    return data?.success
      ? { ok: true }
      : { ok: false, error: 'turnstile_invalid', codes: data?.['error-codes'] };
  } catch (err) {
    console.error('[Turnstile] verify failed:', err.message);
    // Fail-closed: a network error talking to CF should not silently let
    // guests through. If CF is genuinely down, the user can sign up to
    // bypass the guest gate, or wait it out.
    return { ok: false, error: 'turnstile_unreachable' };
  }
}

// ── Per-authenticated-user daily voice cap
//    Guests are bounded by IP+cookie (layers 2-4); without a per-user cap a
//    single signed-in user could drain the whole VOICE_DAILY_CAP budget on
//    their own. USER_VOICE_LIMIT is generous (25/day default) — meant to
//    catch runaway scripts and accidents, not to gate normal usage.
const USER_VOICE_LIMIT  = parseInt(process.env.USER_VOICE_LIMIT || '25', 10);
const USER_VOICE_WINDOW = 24 * 60 * 60 * 1000;

function ensureGuestCookie(req, res) {
  const cookies = parseCookies(req);
  const existing = verifyGuestCookie(cookies[GUEST_COOKIE_NAME]);
  if (existing) return existing;
  const fresh = crypto.randomBytes(8).toString('hex');
  res.setHeader('Set-Cookie',
    `${GUEST_COOKIE_NAME}=${encodeURIComponent(signGuestCookie(fresh))}; ` +
    `Max-Age=${Math.floor(GUEST_COOKIE_TTL / 1000)}; ` +
    `Path=/; HttpOnly; SameSite=Lax; Secure`
  );
  return fresh;
}
// NOTE: authLimiter is attached directly on each endpoint below, not via
// app.use, so the route definitions stay the single source of truth for
// which endpoints are credential-guarded.

// ── Auto-migrate: add new columns if they don't exist
try {
  const cols = db.pragma('table_info(quotes)').map(c => c.name);
  if (!cols.includes('line_items')) {
    db.exec('ALTER TABLE quotes ADD COLUMN line_items TEXT');
    console.log('[DB] Added line_items column');
  }
  if (!cols.includes('markup')) {
    db.exec('ALTER TABLE quotes ADD COLUMN markup REAL DEFAULT 0');
    console.log('[DB] Added markup column');
  }
  // ── Multi-user migration: add user_id column
  if (!cols.includes('user_id')) {
    db.exec("ALTER TABLE quotes ADD COLUMN user_id TEXT DEFAULT 'default'");
    console.log('[DB] Added user_id column — existing quotes assigned to "default"');
    // If using multi-user mode, assign existing quotes to first user
    if (USERS.length > 0 && USERS[0].id !== 'default') {
      const firstUserId = USERS[0].id;
      const migrated = db.prepare("UPDATE quotes SET user_id = ? WHERE user_id = 'default'").run(firstUserId);
      console.log(`[DB] Migrated ${migrated.changes} existing quotes to user: ${firstUserId}`);
    }
  }
  // Per-quote tax rate. Existing rows backfilled to 0 — users can re-save to correct.
  if (!cols.includes('tax_rate')) {
    db.exec('ALTER TABLE quotes ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0');
    console.log('[DB] Added tax_rate column');
  }
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
  // Soft-delete: deleted_at is NULL for live quotes, ms-epoch when trashed.
  // Default-list queries filter on deleted_at IS NULL; a /trash list shows
  // the others. Restore = set deleted_at back to NULL.
  if (!cols.includes('deleted_at')) {
    db.exec('ALTER TABLE quotes ADD COLUMN deleted_at INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_quotes_deleted_at ON quotes(deleted_at)');
    console.log('[DB] Added deleted_at column for soft-delete');
  }
} catch (err) {
  console.error('[DB] Migration error:', err.message);
}

// ── Billing columns on users — added incrementally so existing DBs migrate
// in place without dropping anything. Populated by the Stripe webhook.
try {
  const ucols = db.pragma('table_info(users)').map(c => c.name);
  const addCol = (name, ddl) => {
    if (!ucols.includes(name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
      console.log(`[DB] Added users.${name}`);
    }
  };
  addCol('stripe_customer_id',     "stripe_customer_id TEXT");
  addCol('stripe_subscription_id', "stripe_subscription_id TEXT");
  addCol('plan',                   "plan TEXT NOT NULL DEFAULT 'free'");
  addCol('subscription_status',    "subscription_status TEXT");
  addCol('current_period_end',     "current_period_end INTEGER");
  // Business preferences (drive PDF branding + AI pricing region).
  addCol('business_name',          "business_name TEXT");
  addCol('default_tax_rate',       "default_tax_rate REAL");
  addCol('default_region',         "default_region TEXT");
  addCol('logo_filename',          "logo_filename TEXT");
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id)');
} catch (err) {
  console.error('[DB] Users billing migration error:', err.message);
}

// ── Helper: find user by password — supports bcrypt hashes AND legacy plaintext.
// Bcrypt hashes are detected by the $2a$ / $2b$ / $2y$ prefix. Run
// `npm run hash-password -- <password>` to generate one, then paste into
// the `password` field of QMACH_USERS. Plaintext entries still work (for
// migration), but emit a boot-time warning (see further down).
function isBcryptHash(s) { return typeof s === 'string' && /^\$2[aby]\$/.test(s); }

// Google OAuth allowlist. GOOGLE_ALLOWED_EMAILS is a comma-separated list.
// Entries that start with '@' are treated as domain suffixes ('@spwinc.com'
// matches any email from that domain). Empty/unset list = open signup
// (matches pre-allowlist behavior).
const GOOGLE_ALLOWED = (process.env.GOOGLE_ALLOWED_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function isAllowedGoogleEmail(email) {
  if (GOOGLE_ALLOWED.length === 0) return true;
  const e = (email || '').toLowerCase();
  return GOOGLE_ALLOWED.some(entry =>
    entry.startsWith('@') ? e.endsWith(entry) : e === entry
  );
}

if (GOOGLE_ALLOWED.length > 0) {
  console.log(`[Auth] Google OAuth restricted to: ${GOOGLE_ALLOWED.join(', ')}`);
} else {
  console.log('[Auth] Google OAuth open to any Gmail account (set GOOGLE_ALLOWED_EMAILS to restrict)');
}

function findUserByPassword(password) {
  if (!password) return null;
  for (const u of USERS) {
    const stored = u.password || '';
    if (!stored) continue;
    if (isBcryptHash(stored)) {
      try { if (bcrypt.compareSync(password, stored)) return u; } catch {}
    } else {
      // Legacy plaintext — constant-time compare
      if (password.length !== stored.length) continue;
      try {
        if (crypto.timingSafeEqual(Buffer.from(password), Buffer.from(stored))) return u;
      } catch {}
    }
  }
  return null;
}

// ── Helper: get session from request
function getSession(req) {
  const token = req.headers['x-auth-token'];
  if (!token) return null;
  const row = getSessionStmt.get(token);
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    try { deleteSessionStmt.run(token); } catch {}
    return null;
  }
  return { userId: row.user_id, userName: row.user_name, created: row.created_at, expires: row.expires_at };
}

// ══════════════════════════════════════════
//  AUTH ENDPOINTS
// ══════════════════════════════════════════

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Signup — first name, last name, email, password. Creates a DB user,
// hashes the password with bcrypt, and returns a session token.
app.post('/api/auth/signup', authLimiter, (req, res) => {
  try {
    const firstName = String(req.body?.first_name || '').trim();
    const lastName  = String(req.body?.last_name  || '').trim();
    const email     = String(req.body?.email      || '').trim().toLowerCase();
    const password  = String(req.body?.password   || '');

    if (!firstName || !lastName) return res.status(400).json({ success: false, error: 'First and last name required' });
    if (!EMAIL_RE.test(email))   return res.status(400).json({ success: false, error: 'Valid email required' });
    // Password policy: 8–72 chars, ≥1 uppercase, ≥1 number, ≥1 special.
    // The upper bound matches bcrypt's 72-byte input limit — anything longer
    // is silently truncated by bcrypt, which would let two different long
    // passwords collide on the same hash. Kept in sync with the client-side
    // check in public/js/app.js (doSignup).
    if (password.length < 8 || password.length > 72
        || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      return res.status(400).json({ success: false, error: 'Password must be 8–72 characters with an uppercase letter, a number, and a special character' });
    }

    if (getUserByEmailStmt.get(email)) {
      return res.status(409).json({ success: false, error: 'An account with that email already exists' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const userName = `${firstName} ${lastName}`.trim();
    try {
      insertUserStmt.run(email, email, hash, firstName, lastName, Date.now());
    } catch (err) {
      // Two signups racing for the same email — the pre-check above passed
      // for both, but the UNIQUE index catches the second INSERT. Return
      // 409 instead of a generic 500 so the client shows the right error.
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ success: false, error: 'An account with that email already exists' });
      }
      throw err;
    }

    const token = createSession(email, userName);
    console.log(`[Auth] Signup: ${userName} (${email}), sessions active: ${sessionCount()}`);
    res.status(201).json({ success: true, token, userId: email, userName });
  } catch (err) {
    console.error('[Auth] Signup error:', err);
    res.status(500).json({ success: false, error: 'Signup failed' });
  }
});

// ── Login — primary path is email + password (DB users). We also keep the
// legacy env-configured QMACH_USERS path alive: if no email is supplied, or
// the email isn't in the DB, we fall through to the password-only check.
function handleLogin(req, res) {
  const email    = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  // DB user — email + password
  if (email) {
    const u = getUserByEmailStmt.get(email);
    if (u && bcrypt.compareSync(password, u.password_hash)) {
      const userName = `${u.first_name} ${u.last_name}`.trim();
      const token = createSession(u.id, userName);
      console.log(`[Auth] Login: ${userName} (${u.id}), sessions active: ${sessionCount()}`);
      return res.json({ success: true, token, userId: u.id, userName });
    }
    // Email supplied but no DB match — reject without falling through,
    // otherwise a legitimate "wrong password" request leaks into env-user
    // space and could succeed if the typed password happens to match one.
    if (u) {
      console.log(`[Auth] Login failed (bad password): ${email}`);
      return res.status(401).json({ success: false, error: 'Wrong email or password' });
    }
  }

  // No email, or email not registered — legacy env-user flow.
  if (isOpenAccess() && !email) {
    return res.json({ success: true, token: 'open', userId: 'default', userName: 'Admin', message: 'No password configured' });
  }
  const legacy = findUserByPassword(password);
  if (legacy) {
    const token = createSession(legacy.id, legacy.name || legacy.id);
    console.log(`[Auth] Login (env user): ${legacy.name || legacy.id}, sessions active: ${sessionCount()}`);
    return res.json({ success: true, token, userId: legacy.id, userName: legacy.name || legacy.id });
  }

  console.log('[Auth] Login failed — no match');
  res.status(401).json({ success: false, error: 'Wrong email or password' });
}

// Bind the login handler at both the new path and the legacy `/api/auth` URL.
// Older cached PWA clients still POST to /api/auth — Express treats array
// paths as first-class, so both URLs route to the same handler.
app.post(['/api/auth/login', '/api/auth'], authLimiter, handleLogin);

// ── Logout — delete the server-side session so a stolen token can't outlive
// a "sign out" click. Safe to call without a valid session (no-op if the
// token is missing or expired).
app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) { try { deleteSessionStmt.run(token); } catch {} }
  res.json({ success: true });
});

// ── Auth check — returns user info + tier so the frontend can blur prices,
// hide/watermark the PDF, and pick the right CTA copy.
app.get('/api/auth/check', (req, res) => {
  if (isOpenAccess()) {
    return res.json({ valid: true, userId: 'default', userName: 'Admin', tier: 'full' });
  }
  const sess = getSession(req);
  if (sess) {
    const tier = (typeof sess.userId === 'string' && sess.userId.startsWith('e:'))
      ? 'email_only'
      : 'full';
    return res.json({ valid: true, userId: sess.userId, userName: sess.userName, tier });
  }
  res.json({ valid: false, tier: 'anon' });
});

// ── Email-only "soft signup" — captures an email after the anon user hits
// the 1-quote cap. Creates a session under user_id = 'e:<email>' so the
// caller bypasses the guest gate but still sits in the conversion funnel
// (range-only pricing, watermarked PDF). Doesn't insert into the `users`
// table — that's reserved for full signups with passwords. Quotes saved by
// email-only users belong to 'e:<email>'; if they later sign up with the
// same email + password, they'll get a different user_id (<email>) and the
// soft-signup quotes won't follow. Acceptable trade-off vs. allowing email
// collisions across tiers — the email-only tier is intentionally sticky to
// push real signup, not a long-term identity.
const emailOnlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: false,
  message: { success: false, error: 'Too many requests — try again in an hour.' },
});
app.post('/api/auth/email-only', emailOnlyLimiter, (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email.' });
    }
    const now = Date.now();
    upsertEmailOnlyStmt.run(email, now, now);
    const userId = 'e:' + email;
    const token  = createSession(userId, email);
    console.log(`[Auth] Email-only signup: ${email} (sessions active: ${sessionCount()})`);
    res.json({
      success: true,
      token,
      userId,
      userName: email,
      tier: 'email_only',
    });
  } catch (err) {
    console.error('[Auth] Email-only signup error:', err);
    res.status(500).json({ success: false, error: 'Sign-up failed' });
  }
});

// ── Google OAuth — validate Supabase token and create pquote session
app.post('/api/auth/google', authLimiter, async (req, res) => {
  const { access_token, email, name } = req.body;
  if (!access_token || !email) {
    return res.status(400).json({ success: false, error: 'Missing token or email' });
  }

  // Validate the Supabase access token by calling Supabase's user endpoint
  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://ywqidkugtavzqqhehppg.supabase.co';
    const supabaseAnon = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3cWlka3VndGF2enFxaGVocHBnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4MDI2NjMsImV4cCI6MjA5MDM3ODY2M30.ULTGwCFcukaU2SuKeM9OtdOI5pFV3wln_mz1zvRVQiQ';

    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'apikey': supabaseAnon
      }
    });

    if (!userRes.ok) {
      console.log('[Auth] Google token validation failed:', userRes.status);
      return res.status(401).json({ success: false, error: 'Invalid Google token' });
    }

    const userData = await userRes.json();
    const userEmail = userData.email;
    if (!userEmail) {
      console.log('[Auth] Google token validated but no email on user record');
      return res.status(401).json({ success: false, error: 'No email on Google account' });
    }

    if (!isAllowedGoogleEmail(userEmail)) {
      console.log('[Auth] Google email not in allowlist:', userEmail);
      return res.status(403).json({ success: false, error: 'This Google account is not authorized for pquote. Contact the admin to be added.' });
    }

    const userName = userData.user_metadata?.full_name || name || userEmail;
    const emailLc  = userEmail.toLowerCase();

    // ── Auth source canonicalization
    //
    // Without this, a user who first signed up with email/password and later
    // signed in with Google saw an empty quote list — the DB-user account
    // owns rows under user_id = <email>, while Google login was minting a
    // separate user_id = "g:<email>". Now Google login looks up matching
    // accounts and reuses the existing user_id, so the user stays bound to
    // the same data regardless of which method they used today.
    //
    // Resolution priority (most authoritative first):
    //   1. DB user with matching email   → user_id = email (unchanged from signup path)
    //   2. QMACH_USERS entry with id     → user_id = that id (rare; usually bare strings)
    //   3. New Google user               → user_id = g:<email> (legacy default)
    let userId;
    let source;
    const dbUser = getUserByEmailStmt.get(emailLc);
    if (dbUser) {
      userId = dbUser.id;
      source = 'db_user_link';
    } else {
      const envUser = USERS.find(u => (u.id || '').toLowerCase() === emailLc);
      if (envUser) {
        userId = envUser.id;
        source = 'env_user_link';
      } else {
        userId = 'g:' + emailLc;
        source = 'google_new';
      }
    }

    const token = createSession(userId, userName);
    console.log(`[Auth] Google login: ${userName} (${emailLc}) → ${userId} [${source}], sessions active: ${sessionCount()}`);
    res.json({ success: true, token, userId, userName });
  } catch (err) {
    console.error('[Auth] Google auth error:', err.message);
    res.status(500).json({ success: false, error: 'Google auth failed' });
  }
});

// ── Auth middleware — protect all /api/ routes except auth + config + health
//    Attaches req.userId for downstream route handlers.
//
//    "Open" paths don't REQUIRE auth, but we still attempt session resolution
//    on them so endpoints can flex behavior when the caller is signed in.
//    /voice/analyze and /voice/price specifically need this — without it,
//    full-tier users get treated as anon (blurred prices, Turnstile gate,
//    no per-user cap, no KB calibration). Required paths still 401 if no
//    session is found.
app.use('/api/', (req, res, next) => {
  const openPaths = new Set([
    '/auth', '/auth/check', '/auth/google', '/auth/login', '/auth/signup',
    '/auth/logout', '/auth/email-only',
    '/config',
    '/voice/analyze', '/voice/price',
  ]);
  const isOpen = openPaths.has(req.path);

  // Fresh install with zero users anywhere — grant open access so the app
  // boots without config. Flips to "auth required" the moment any user
  // signs up or QMACH_USERS is set.
  if (isOpenAccess()) {
    req.userId = 'default';
    return next();
  }

  // Always try the session — when present, attaches req.userId/userName so
  // open-path handlers (analyze/price) can branch on tier.
  const sess = getSession(req);
  if (sess) {
    req.userId = sess.userId;
    req.userName = sess.userName;
    return next();
  }

  if (isOpen) return next();
  res.status(401).json({ error: 'Unauthorized — please log in' });
});

// ══════════════════════════════════════════
//  QUOTES ROUTES — scoped by user_id
// ══════════════════════════════════════════

// GET all quotes (with optional search) — user's own quotes only
app.get('/api/quotes', (req, res) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;
    const userId = req.userId;
    // Soft-delete filter — caller passes ?include_trash=1 to see trashed
    // quotes, ?trash_only=1 to see ONLY trashed (a /trash listing). Default
    // (neither flag) hides trashed quotes from every consumer.
    const trashOnly    = req.query.trash_only === '1';
    const includeTrash = req.query.include_trash === '1' || trashOnly;
    const trashClause  = trashOnly ? 'deleted_at IS NOT NULL'
                       : (includeTrash ? '1=1' : 'deleted_at IS NULL');
    let quotes;
    const LIST_COLS = 'id, client_name, project_type, total, created_at, address, line_items, deleted_at';
    if (search) {
      quotes = db.prepare(`
        SELECT ${LIST_COLS} FROM quotes
        WHERE user_id = ? AND ${trashClause}
          AND (client_name LIKE ? OR project_type LIKE ? OR address LIKE ? OR notes LIKE ?)
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(userId, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, parseInt(limit), parseInt(offset));
    } else {
      quotes = db.prepare(`
        SELECT ${LIST_COLS} FROM quotes WHERE user_id = ? AND ${trashClause}
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(userId, parseInt(limit), parseInt(offset));
    }
    const total = db.prepare(`SELECT COUNT(*) as count FROM quotes WHERE user_id = ? AND ${trashClause}`).get(userId);
    res.json({ quotes, total: total.count });
  } catch (err) {
    console.error('GET /api/quotes error:', err);
    res.status(500).json({ error: 'Failed to fetch quotes' });
  }
});

// GET single quote — must belong to user
app.get('/api/quotes/:id', (req, res) => {
  try {
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    res.json(quote);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

// POST create quote — assigned to current user. Quota-gated for free users.
app.post('/api/quotes', checkQuoteQuota, (req, res) => {
  try {
    const {
      client_name, project_type, area, unit, price_per_unit,
      total, notes, address, lat, lng, polygon_geojson, qty,
      ai_narrative, line_items, markup, tax_rate
    } = req.body;

    if (!client_name) {
      return res.status(400).json({ error: 'Missing required field: client_name' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO quotes
        (id, client_name, project_type, area, unit, price_per_unit, total, notes,
         address, lat, lng, polygon_geojson, qty, ai_narrative, line_items, markup, user_id, tax_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, client_name, project_type || 'custom',
      parseFloat(area) || 0, unit || 'sqft',
      parseFloat(price_per_unit) || 0,
      parseFloat(total) || 0,
      notes || '',
      address || '', lat || null, lng || null,
      polygon_geojson ? JSON.stringify(polygon_geojson) : null,
      parseInt(qty) || 1,
      ai_narrative || '',
      line_items ? JSON.stringify(line_items) : null,
      parseFloat(markup) || 0,
      req.userId,
      parseFloat(tax_rate) || 0
    );

    const created = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
    bumpUsage(req.userId, 'quote'); // count toward free-tier monthly cap
    res.status(201).json(created);
  } catch (err) {
    console.error('POST /api/quotes error:', err);
    res.status(500).json({ error: 'Failed to create quote' });
  }
});

// PUT update quote — must belong to user
app.put('/api/quotes/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM quotes WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: 'Quote not found' });

    const fields = ['client_name','project_type','area','unit','price_per_unit','total','notes','address','lat','lng','polygon_geojson','qty','ai_narrative','line_items','markup','tax_rate'];
    const updates = [];
    const values = [];

    fields.forEach(f => {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        values.push((f === 'polygon_geojson' || f === 'line_items') ? JSON.stringify(req.body[f]) : req.body[f]);
      }
    });

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id);
    values.push(req.userId);
    db.prepare(`UPDATE quotes SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`).run(...values);

    res.json(db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id));
  } catch (err) {
    res.status(500).json({ error: 'Failed to update quote' });
  }
});

// DELETE quote — soft delete (sets deleted_at). Use ?purge=1 to hard-delete.
// Soft delete is the default so users can recover from accidental taps via
// POST /api/quotes/:id/restore. Hard delete is for admin / cleanup workflows.
app.delete('/api/quotes/:id', (req, res) => {
  try {
    const purge = req.query.purge === '1';
    const result = purge
      ? db.prepare('DELETE FROM quotes WHERE id = ? AND user_id = ?').run(req.params.id, req.userId)
      : db.prepare('UPDATE quotes SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
          .run(Date.now(), req.params.id, req.userId);
    if (result.changes === 0) return res.status(404).json({ error: 'Quote not found' });
    res.json({ success: true, soft: !purge });
  } catch (err) {
    console.error('DELETE /api/quotes/:id error:', err);
    res.status(500).json({ error: 'Failed to delete quote' });
  }
});

// Restore a soft-deleted quote.
app.post('/api/quotes/:id/restore', (req, res) => {
  try {
    const r = db.prepare('UPDATE quotes SET deleted_at = NULL WHERE id = ? AND user_id = ?')
      .run(req.params.id, req.userId);
    if (r.changes === 0) return res.status(404).json({ error: 'Quote not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to restore quote' });
  }
});

// GET stats — user's own stats only
app.get('/api/stats', (req, res) => {
  try {
    const userId = req.userId;
    const stats = {
      total_quotes: db.prepare('SELECT COUNT(*) as c FROM quotes WHERE user_id = ? AND deleted_at IS NULL').get(userId).c,
      total_value: db.prepare('SELECT SUM(total) as s FROM quotes WHERE user_id = ? AND deleted_at IS NULL').get(userId).s || 0,
      avg_quote: db.prepare('SELECT AVG(total) as a FROM quotes WHERE user_id = ? AND deleted_at IS NULL').get(userId).a || 0,
      this_month: db.prepare(`SELECT COUNT(*) as c FROM quotes WHERE user_id = ? AND deleted_at IS NULL AND created_at >= date('now','start of month')`).get(userId).c,
      // Revenue by type attributes each service to its actual project_type
      // (multi-service quotes used to dump everything onto items[0]'s type).
      // Legacy quotes without line_items fall back to the top-level columns.
      by_type: db.prepare(`
        WITH expanded AS (
          SELECT
            json_extract(li.value, '$.type') AS project_type,
            CAST(COALESCE(json_extract(li.value, '$.subtotal'), 0) AS REAL) AS revenue
          FROM quotes q, json_each(q.line_items) li
          WHERE q.user_id = ?
            AND q.deleted_at IS NULL
            AND q.line_items IS NOT NULL
            AND q.line_items != ''
            AND q.line_items != '[]'
          UNION ALL
          SELECT project_type, total AS revenue
          FROM quotes
          WHERE user_id = ?
            AND deleted_at IS NULL
            AND (line_items IS NULL OR line_items = '' OR line_items = '[]')
        )
        SELECT project_type, COUNT(*) AS count, SUM(revenue) AS revenue
        FROM expanded
        WHERE project_type IS NOT NULL
        GROUP BY project_type
        ORDER BY revenue DESC
      `).all(userId, userId)
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ══════════════════════════════════════════
//  ADMIN — gated by ADMIN_USER_ID (or legacy BACKUP_ADMIN_ID)
// ══════════════════════════════════════════
// All admin endpoints (backup + user mgmt) require an authenticated user
// whose req.userId matches the configured admin id. If neither env var is
// set, every admin endpoint is disabled — explicit opt-in.
const ADMIN_ID = process.env.ADMIN_USER_ID || process.env.BACKUP_ADMIN_ID;

function adminGate(req, res, next) {
  if (!ADMIN_ID) return res.status(403).json({ error: 'Admin endpoints disabled (set ADMIN_USER_ID)' });
  if (req.userId !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── Backup download/list (existing, now uses the shared gate).
app.get('/api/backup/download', adminGate, (req, res) => {
  if (!backup.latestBackup()) {
    const r = backup.runDailyBackup();
    if (r.error) return res.status(500).json({ error: 'Backup generation failed' });
  }
  const latest = backup.latestBackup();
  if (!latest) return res.status(404).json({ error: 'No backup available' });
  res.download(latest);
});

app.get('/api/backup/list', adminGate, (req, res) => {
  res.json({ backups: backup.listBackups() });
});

app.post('/api/admin/backup/run', adminGate, (req, res) => {
  const r = backup.runDailyBackup();
  if (r.error) return res.status(500).json({ error: r.error });
  res.json(r);
});

// ── Users: merges three sources — configured password users (QMACH_USERS),
// distinct user_ids that have saved quotes, and user_ids with live sessions.
app.get('/api/admin/users', adminGate, (req, res) => {
  try {
    const now = Date.now();
    const quoteStats = db.prepare(`
      SELECT user_id, COUNT(*) AS quote_count, SUM(total) AS total_value, MAX(created_at) AS last_quote_at
      FROM quotes GROUP BY user_id
    `).all();
    const sessionStats = db.prepare(`
      SELECT user_id, COUNT(*) AS active_sessions, MAX(created_at) AS last_session_at
      FROM sessions WHERE expires_at > ? GROUP BY user_id
    `).all(now);

    const byId = new Map();
    const ensure = (id) => {
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          name: id.startsWith('g:') ? id.slice(2) : id,
          source: id.startsWith('g:') ? 'google_oauth' : 'unknown',
          quote_count: 0, total_value: 0, last_quote_at: null,
          active_sessions: 0, last_session_at: null
        });
      }
      return byId.get(id);
    };
    for (const u of USERS) {
      const e = ensure(u.id);
      e.name = u.name || u.id;
      e.source = 'qmach_users';
    }
    for (const q of quoteStats) {
      const e = ensure(q.user_id);
      e.quote_count = q.quote_count;
      e.total_value = q.total_value || 0;
      e.last_quote_at = q.last_quote_at;
    }
    for (const s of sessionStats) {
      const e = ensure(s.user_id);
      e.active_sessions = s.active_sessions;
      e.last_session_at = s.last_session_at;
    }
    const users = [...byId.values()].sort((a, b) =>
      (b.quote_count - a.quote_count) || (a.id > b.id ? 1 : -1)
    );
    res.json({ users, total: users.length, admin_id: ADMIN_ID });
  } catch (err) {
    console.error('admin/users error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// ── Sessions: live (non-expired) sessions across all users.
app.get('/api/admin/sessions', adminGate, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT token, user_id, user_name, created_at, expires_at
      FROM sessions WHERE expires_at > ? ORDER BY created_at DESC
    `).all(Date.now());
    // Redact the token — admin should see sessions exist, not steal them.
    const safe = rows.map(r => ({
      token_prefix: r.token.slice(0, 8) + '…',
      token_hash: r.token, // kept server-side for the revoke call
      user_id: r.user_id,
      user_name: r.user_name,
      created_at: r.created_at,
      expires_at: r.expires_at
    }));
    res.json({ sessions: safe, total: safe.length });
  } catch (err) {
    console.error('admin/sessions error:', err);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

// ── Revoke all sessions for a given user_id.
app.delete('/api/admin/sessions/user/:userId', adminGate, (req, res) => {
  try {
    const r = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.params.userId);
    res.json({ revoked: r.changes });
  } catch (err) {
    res.status(500).json({ error: 'Revoke failed' });
  }
});

// ── Revoke a specific session token.
app.delete('/api/admin/sessions/:token', adminGate, (req, res) => {
  try {
    const r = db.prepare('DELETE FROM sessions WHERE token = ?').run(req.params.token);
    res.json({ revoked: r.changes });
  } catch (err) {
    res.status(500).json({ error: 'Revoke failed' });
  }
});

// ══════════════════════════════════════════
//  BILLING ROUTES (Stripe)
// ══════════════════════════════════════════
// All three endpoints require an authenticated user whose req.userId exists
// in the `users` table (DB-registered accounts). Env-based QMACH_USERS and
// Google OAuth users don't have a users row — they get a 403 explaining they
// need an email-registered account before they can subscribe.

function getBillingUser(req) {
  if (!req.userId) return null;
  return db.prepare(`
    SELECT id, email, first_name, last_name,
           stripe_customer_id, stripe_subscription_id, plan, subscription_status, current_period_end
      FROM users WHERE id = ?
  `).get(req.userId);
}

// GET /api/billing/status — what's the current user's plan + renewal date?
// Returns { configured, plan, status, current_period_end, has_customer }.
// `configured` lets the client hide the upgrade button entirely when the
// server hasn't been wired up yet (no STRIPE_SECRET_KEY).
app.get('/api/billing/status', (req, res) => {
  const configured = !!(stripe && STRIPE_PRICE_PRO);
  const u = getBillingUser(req);
  if (!u) {
    return res.json({
      configured,
      plan: 'free',
      status: null,
      current_period_end: null,
      has_customer: false,
      registered: false,
    });
  }
  // Monthly usage counters (only meaningful for free users; Pro users see
  // them too but they aren't gated by them).
  const usage = {
    period: currentPeriod(),
    quotes: { used: getUsage(u.id, 'quote'), limit: FREE_QUOTES_PER_MONTH },
    ai:     { used: getUsage(u.id, 'ai'),    limit: FREE_AI_PER_MONTH },
  };
  res.json({
    configured,
    plan: u.plan || 'free',
    status: u.subscription_status || null,
    current_period_end: u.current_period_end || null,
    has_customer: !!u.stripe_customer_id,
    registered: true,
    usage,
  });
});

// POST /api/billing/checkout — create a Stripe Checkout session and return
// its URL. Client redirects to it. Creates the Stripe customer on first call
// and stores customer.id on the user row immediately (so a webhook race
// can't drop the linkage).
app.post('/api/billing/checkout', async (req, res) => {
  if (!stripe)            return res.status(503).json({ error: 'Stripe not configured on server' });
  if (!STRIPE_PRICE_PRO)  return res.status(503).json({ error: 'STRIPE_PRICE_PRO_MONTHLY not set' });
  const u = getBillingUser(req);
  if (!u) return res.status(403).json({ error: 'Billing requires an email-registered account. Please sign up first.' });

  try {
    let customerId = u.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: u.email,
        name:  `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
        metadata: { pquote_user_id: u.id },
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, u.id);
    }

    const base = resolveBaseUrl(req);
    // Client can hint where to land after Checkout. 'app' routes signup-flow
    // upgrades straight into the app instead of the standalone receipt page.
    // Any other value (or missing) uses the default /billing receipt page.
    const returnTo = String(req.body?.return_to || '');
    const successPath = returnTo === 'app'
      ? '/app?subscribed=1'
      : BILLING_SUCCESS_PATH;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: u.id,
      line_items: [{ price: STRIPE_PRICE_PRO, quantity: 1 }],
      success_url: base + successPath + (successPath.includes('?') ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  base + BILLING_CANCEL_PATH,
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/billing/portal — open the Stripe-hosted Customer Portal so the
// user can manage payment methods, cancel, or view invoices. Requires a
// pre-existing customer (created on first checkout).
app.post('/api/billing/portal', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured on server' });
  const u = getBillingUser(req);
  if (!u) return res.status(403).json({ error: 'Billing requires an email-registered account.' });
  if (!u.stripe_customer_id) return res.status(400).json({ error: 'No subscription yet — start with Checkout first.' });

  try {
    const base = resolveBaseUrl(req);
    const session = await stripe.billingPortal.sessions.create({
      customer: u.stripe_customer_id,
      return_url: base + '/billing',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe] portal error:', err.message);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// ══════════════════════════════════════════
//  ACCOUNT ROUTES — profile + password + preferences
// ══════════════════════════════════════════
// All three endpoints require a DB-registered account (Google OAuth and
// env users have no users row to update). Returning 403 for those gives
// the client a clean signal to render an explainer.

// GET /api/account — what's on file for the current user?
app.get('/api/account', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const u = db.prepare(`
    SELECT id, email, first_name, last_name, plan,
           business_name, default_tax_rate, default_region, logo_filename
      FROM users WHERE id = ?
  `).get(req.userId);
  if (!u) return res.status(403).json({ error: 'account_not_registered', message: 'Account settings require an email-registered account.' });
  res.json({
    id:               u.id,
    email:            u.email,
    first_name:       u.first_name,
    last_name:        u.last_name,
    plan:             u.plan || 'free',
    business_name:    u.business_name || '',
    default_tax_rate: u.default_tax_rate ?? null,
    default_region:   u.default_region   || '',
    has_logo:         !!u.logo_filename,
  });
});

// PUT /api/account — update profile + business preferences. Email is
// intentionally NOT editable (changing it invalidates Stripe customer
// linkage + auth cookies); password has its own endpoint with re-auth.
app.put('/api/account', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(req.userId);
  if (!u) return res.status(403).json({ error: 'account_not_registered' });

  const firstName    = String(req.body?.first_name    || '').trim().slice(0, 80);
  const lastName     = String(req.body?.last_name     || '').trim().slice(0, 80);
  const businessName = String(req.body?.business_name || '').trim().slice(0, 120);
  const region       = String(req.body?.default_region|| '').trim().slice(0, 80);
  const taxRateRaw   = req.body?.default_tax_rate;

  if (!firstName) return res.status(400).json({ error: 'First name required' });
  if (!lastName)  return res.status(400).json({ error: 'Last name required' });

  let taxRate = null;
  if (taxRateRaw !== null && taxRateRaw !== undefined && taxRateRaw !== '') {
    taxRate = parseFloat(taxRateRaw);
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 30) {
      return res.status(400).json({ error: 'Tax rate must be a number between 0 and 30 (percent)' });
    }
  }

  db.prepare(`
    UPDATE users
       SET first_name = ?, last_name = ?,
           business_name = ?, default_tax_rate = ?, default_region = ?
     WHERE id = ?
  `).run(firstName, lastName, businessName || null, taxRate, region || null, req.userId);

  res.json({ success: true });
});

// POST /api/account/password — re-auth with current pw, then rotate hash.
// Out of scope: invalidating other live sessions for this user. The session
// table is keyed by token, not user_id, so we'd need a separate sweep —
// follow-up if password rotation needs to mean "kick all other devices".
app.post('/api/account/password', authLimiter, (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const u = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.userId);
  if (!u) return res.status(403).json({ error: 'account_not_registered' });

  const current = String(req.body?.current_password || '');
  const next    = String(req.body?.new_password || '');
  if (!current || !next) return res.status(400).json({ error: 'Both current and new password required' });
  if (next.length < 8 || next.length > 72
      || !/[A-Z]/.test(next) || !/[0-9]/.test(next) || !/[^A-Za-z0-9]/.test(next)) {
    return res.status(400).json({ error: 'New password must be 8–72 chars with an uppercase letter, a number, and a special character' });
  }
  if (current === next) {
    return res.status(400).json({ error: 'New password must differ from current password' });
  }

  let ok = false;
  try { ok = bcrypt.compareSync(current, u.password_hash); } catch {}
  if (!ok) return res.status(401).json({ error: 'Current password is wrong' });

  const newHash = bcrypt.hashSync(next, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.userId);
  console.log(`[Auth] Password changed for ${req.userId}`);
  res.json({ success: true });
});

// ── Logo upload (Pro feature). Files live on the Railway volume at
// $RAILWAY_VOLUME_MOUNT_PATH/logos/<hash>.<ext>. Filename is a sha256 of
// the user id so a) we don't leak emails into file paths, and b) we
// always know exactly which file is current per user.
const LOGOS_DIR  = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'), 'logos');
const MAX_LOGO_BYTES = 500 * 1024; // 500KB
const MIME_TO_EXT = {
  'image/png':     'png',
  'image/jpeg':    'jpg',
  'image/jpg':     'jpg',
  'image/webp':    'webp',
  'image/svg+xml': 'svg',
};
try { fs.mkdirSync(LOGOS_DIR, { recursive: true }); } catch {}

function logoBasenameForUser(userId) {
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 32);
}

// POST /api/account/logo — body is the raw image bytes (Content-Type set
// to image/png|jpeg|webp|svg+xml). Pro-gated. Replaces any prior logo.
//
// Using express.raw() inline so we don't pipe ALL traffic through a
// binary parser — only this specific route. The auth middleware runs
// first (it's app.use'd higher up), so req.userId is populated by the
// time we reach this handler.
app.post('/api/account/logo',
  express.raw({ type: 'image/*', limit: MAX_LOGO_BYTES + 1024 }),
  requirePro,
  (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({ error: 'No image data received' });
    }
    if (buf.length > MAX_LOGO_BYTES) {
      return res.status(413).json({ error: `Logo too large — max ${Math.round(MAX_LOGO_BYTES / 1024)}KB` });
    }
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = MIME_TO_EXT[ct];
    if (!ext) {
      return res.status(415).json({ error: 'Unsupported image type. Use PNG, JPG, WebP, or SVG.' });
    }
    // Atomic-ish replace: write to a temp filename then rename. Reduces the
    // window where a half-written file could be served.
    const base = logoBasenameForUser(req.userId);
    const final = path.join(LOGOS_DIR, `${base}.${ext}`);
    const tmp   = path.join(LOGOS_DIR, `${base}.${ext}.tmp`);
    try {
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, final);
    } catch (err) {
      console.error('[Logo] write failed:', err.message);
      try { fs.unlinkSync(tmp); } catch {}
      return res.status(500).json({ error: 'Could not save logo' });
    }
    // Clean up any old logo with a DIFFERENT extension (user re-uploaded
    // as PNG having previously uploaded SVG, etc).
    const newFilename = `${base}.${ext}`;
    const prior = db.prepare('SELECT logo_filename FROM users WHERE id = ?').get(req.userId);
    if (prior?.logo_filename && prior.logo_filename !== newFilename) {
      try { fs.unlinkSync(path.join(LOGOS_DIR, prior.logo_filename)); } catch {}
    }
    db.prepare('UPDATE users SET logo_filename = ? WHERE id = ?').run(newFilename, req.userId);
    res.json({ success: true, filename: newFilename, size: buf.length });
  }
);

// GET /api/account/logo — serve the current user's logo. Auth required;
// we return the binary with the right content-type so the browser can
// load it as <img src="..."> and the client can convert to a data: URI
// for PDF embedding.
app.get('/api/account/logo', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const u = db.prepare('SELECT logo_filename FROM users WHERE id = ?').get(req.userId);
  if (!u?.logo_filename) return res.status(404).json({ error: 'No logo on file' });
  const fp = path.join(LOGOS_DIR, u.logo_filename);
  if (!fs.existsSync(fp)) {
    // DB and disk drifted (rare — manual deletion, volume restore). Clear
    // the column so the client stops asking, return 404.
    db.prepare('UPDATE users SET logo_filename = NULL WHERE id = ?').run(req.userId);
    return res.status(404).json({ error: 'Logo file missing' });
  }
  // Cache per-user for an hour. private so CDNs/proxies don't cache.
  res.setHeader('Cache-Control', 'private, max-age=3600');
  const ext = u.logo_filename.split('.').pop().toLowerCase();
  const ctype = ext === 'svg' ? 'image/svg+xml'
              : ext === 'jpg' ? 'image/jpeg'
              : `image/${ext}`;
  res.setHeader('Content-Type', ctype);
  fs.createReadStream(fp).pipe(res);
});

// DELETE /api/account/logo — remove the user's logo file + clear the column.
// Not Pro-gated — a Pro user who downgrades should still be able to clean up,
// and a free user who somehow has a stale row should be able to clear it.
app.delete('/api/account/logo', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Unauthorized' });
  const u = db.prepare('SELECT logo_filename FROM users WHERE id = ?').get(req.userId);
  if (u?.logo_filename) {
    try { fs.unlinkSync(path.join(LOGOS_DIR, u.logo_filename)); } catch {}
    db.prepare('UPDATE users SET logo_filename = NULL WHERE id = ?').run(req.userId);
  }
  res.json({ success: true });
});

// ══════════════════════════════════════════
//  AI ROUTES (Claude)
// ══════════════════════════════════════════

// AI: Suggest pricing based on project type + area.
// Now feeds the prompt with two grounding inputs so the suggestion isn't
// generic vibes:
//   1. materials_kb rows for the industry — typical application rates,
//      coverage per gallon, per-square shingle costs, etc.
//   2. The user's own pricing calibration if they have prior quotes —
//      avg/min/max per-unit they've actually charged. Strongly anchors
//      "recommended" toward what THIS user typically charges.
app.post('/api/ai/suggest-price', checkAiQuota, async (req, res) => {
  try {
    const { project_type, area, unit, location } = req.body;
    if (!project_type || !area || !unit) {
      return res.status(400).json({ error: 'project_type, area, and unit required' });
    }

    const calibration = getPricingCalibration(req.userId, project_type);
    const materials   = getMaterialsForIndustry(project_type);

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 512,
      system: `You are a pricing expert for trades and contracting businesses.
You provide realistic market-rate pricing guidance for jobs.
When the user has past quotes, ANCHOR your "recommended" price to their actual pricing patterns rather than generic market ranges.
When materials_kb context is provided, use those rates as ground truth instead of guessing application/coverage rates.
Always respond with a JSON object only — no markdown, no explanation.`,
      messages: [{
        role: 'user',
        content: `Give me realistic pricing for this job:
Project type: ${project_type}
Area/measurement: ${area} ${unit}
Location hint: ${location || 'DFW Texas area'}

User's pricing calibration (their actual past pricing — anchor to this when set):
${JSON.stringify(calibration)}

Materials / application-rate reference (industry-typical numbers — use as ground truth):
${JSON.stringify(materials)}

Respond ONLY with this JSON structure:
{
  "low_per_unit": 0.00,
  "mid_per_unit": 0.00,
  "high_per_unit": 0.00,
  "low_total": 0.00,
  "mid_total": 0.00,
  "high_total": 0.00,
  "recommended_per_unit": 0.00,
  "reasoning": "brief 1-2 sentence explanation. Mention if anchored to user's past pricing.",
  "factors": ["factor1", "factor2", "factor3"]
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
    bumpUsage(req.userId, 'ai');
    res.json(parsed);
  } catch (err) {
    console.error('AI suggest-price error:', err);
    res.status(500).json({ error: 'AI pricing request failed' });
  }
});

// AI: Generate professional quote narrative
app.post('/api/ai/generate-narrative', checkAiQuota, async (req, res) => {
  try {
    const { client_name, project_type, area, unit, price_per_unit, total, notes, address, qty } = req.body;
    if (!client_name || !project_type) {
      return res.status(400).json({ error: 'client_name and project_type required' });
    }

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 600,
      system: `You are a professional estimator for a contracting company. 
Write clear, confident, professional quote narratives that build trust with clients.
Be concise — 3-4 short paragraphs max. No fluff. No markdown formatting.`,
      messages: [{
        role: 'user',
        content: `Write a professional quote narrative/cover letter for this job estimate:
Client: ${client_name}
Job type: ${project_type}
Measurement: ${area} ${unit}${qty > 1 ? ` × ${qty} passes` : ''}
Rate: $${price_per_unit} per ${unit}
Total: $${total}
${address ? `Location: ${address}` : ''}
${notes ? `Notes: ${notes}` : ''}

Write it from the contractor's perspective. Keep it professional but friendly. 
Include what the work entails, why the price is fair, and a closing sentence about quality/guarantee.`
      }]
    });

    bumpUsage(req.userId, 'ai');
    res.json({ narrative: message.content[0].text.trim() });
  } catch (err) {
    console.error('AI narrative error:', err);
    res.status(500).json({ error: 'AI narrative generation failed' });
  }
});

// AI: Voice quote — analyze transcript, infer industry, parse job, suggest gaps + add-ons
app.post('/api/voice/analyze', async (req, res) => {
  try {
    const { transcript, prior_context } = req.body;
    if (!transcript || typeof transcript !== 'string' || transcript.trim().length < 3) {
      return res.status(400).json({ error: 'transcript is required (min 3 chars)' });
    }
    if (transcript.trim().length > 5000) {
      return res.status(400).json({ error: 'transcript too long (max 5000 chars)' });
    }

    // ── Server-wide daily kill switch (covers everyone — auth or guest)
    if (!checkVoiceDailyCap()) {
      return res.status(503).json({
        error: 'daily_cap_reached',
        message: "Voice quotes are at capacity for today. Try again tomorrow.",
      });
    }

    // ── Cloudflare Turnstile (guests only; no-op if secret unset)
    //    Verifying first means a failing token short-circuits before we
    //    burn a guest-quota slot or hit the daily counter — a bot can't
    //    grief other guests by exhausting layers it can't pass anyway.
    const isGuest = !req.userId;
    if (isGuest && TURNSTILE_SECRET) {
      const tsToken = req.body?.cf_turnstile || req.headers['cf-turnstile-response'];
      const ts = await verifyTurnstile(tsToken, req.ip);
      if (!ts.ok) {
        return res.status(403).json({
          error: 'turnstile_failed',
          message: ts.error === 'turnstile_token_missing'
            ? 'Please complete the human-check before submitting.'
            : 'Human-check failed. Refresh the page and try again.',
          detail: ts.error,
        });
      }
    }

    // ── Guest quota — anonymous users get GUEST_VOICE_LIMIT analyses per
    // (cookie ⨉ IP) per 24h. We take the MAX of the two counters so to
    // bypass the limit a guest must rotate BOTH browser/cookies AND IP.
    let guestId = null;
    if (isGuest) {
      guestId = ensureGuestCookie(req, res);
      const ipUsed     = readGuestVoice(`ip:${req.ip}`);
      const cookieUsed = readGuestVoice(`gid:${guestId}`);
      const used       = Math.max(ipUsed, cookieUsed);
      if (used >= GUEST_VOICE_LIMIT) {
        // Anonymous user has used their one free taste. Let the frontend
        // present two options: drop an email (soft signup, unlocks more
        // range-only quotes + watermarked PDF) or full signup (precise
        // pricing, clean PDF, save history).
        return res.status(403).json({
          error: 'guest_limit_reached',
          message: `That's your free quote. Drop an email for a few more, or sign up for the real thing.`,
          remaining: 0,
          limit: GUEST_VOICE_LIMIT,
          // What the next tiers unlock — frontend uses these to render the
          // gate UI without hardcoding the same copy on the client.
          unlocks: {
            email_only: ['More voice quotes', 'PDF download (watermarked)'],
            full:       ['Precise prices, not just ranges', 'Clean PDF (no watermark)', 'Saved quote history', 'Map / satellite tracing on /app'],
          },
        });
      }
    } else {
      // ── Free-tier monthly cap — checked BEFORE the 24h cap so the more
      // restrictive limit hits first. Pro users skip this entirely.
      if (effectivePlan(req.userId) === 'free') {
        const monthUsed = getUsage(req.userId, 'ai');
        if (monthUsed >= FREE_AI_PER_MONTH) {
          return res.status(429).json({
            error: 'ai_limit_reached',
            message: `Free plan is limited to ${FREE_AI_PER_MONTH} AI actions per month. Upgrade to pquote Pro for unlimited.`,
            limit: FREE_AI_PER_MONTH,
            used: monthUsed,
            upgrade_url: '/billing',
          });
        }
      }
      // ── Per-user 24h quota — bounds a single signed-in user from draining
      // the global VOICE_DAILY_CAP on their own (script bug, abuse, etc).
      const userUsed = readVoiceQuota(`user:${req.userId}`, USER_VOICE_WINDOW);
      if (userUsed >= USER_VOICE_LIMIT) {
        return res.status(429).json({
          error: 'user_limit_reached',
          message: `You've used ${USER_VOICE_LIMIT} voice quotes in 24h — try again tomorrow.`,
          remaining: 0,
          limit: USER_VOICE_LIMIT,
        });
      }
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
        content: `Voice transcript: ${JSON.stringify(transcript.trim())}

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
    // Bump counters only on success so failed calls don't burn quota.
    bumpVoiceDaily();
    if (isGuest) {
      const ipNew     = bumpGuestVoice(`ip:${req.ip}`);
      const cookieNew = bumpGuestVoice(`gid:${guestId}`);
      const used      = Math.max(ipNew, cookieNew);
      parsed.__guest = {
        used,
        limit: GUEST_VOICE_LIMIT,
        remaining: Math.max(0, GUEST_VOICE_LIMIT - used),
      };
    } else {
      bumpVoiceQuota(`user:${req.userId}`, USER_VOICE_WINDOW);
      bumpUsage(req.userId, 'ai'); // count toward free-tier monthly cap
    }
    // Tier marker so the frontend can render range-only pricing + watermark
    // PDFs for non-full tiers without an extra /api/auth/check round-trip.
    parsed.__tier = getUserTier(req);
    res.json(parsed);
  } catch (err) {
    console.error('AI voice/analyze error:', err);
    res.status(500).json({ error: 'AI analyze request failed' });
  }
});

// AI: Voice quote — suggest price calibrated to user's past jobs
app.post('/api/voice/price', async (req, res) => {
  try {
    const { industry, parsed_job, addons } = req.body;
    if (!industry || typeof industry !== 'string' || industry.trim().length > 100 || !parsed_job) {
      return res.status(400).json({ error: 'industry (≤100 chars) and parsed_job required' });
    }

    // Server-wide daily kill switch — covers price calls too since they
    // also burn Anthropic tokens. No per-guest quota here (price is just
    // refinement within an in-progress quote, not a new "quote").
    if (!checkVoiceDailyCap()) {
      return res.status(503).json({
        error: 'daily_cap_reached',
        message: "Voice quotes are at capacity for today. Try again tomorrow.",
      });
    }

    // Per-user cap also applies to price calls — a runaway client refining
    // the same quote in a tight loop is exactly the abuse case this catches.
    if (req.userId) {
      // Free-tier monthly cap — more restrictive than the 24h cap below.
      if (effectivePlan(req.userId) === 'free') {
        const monthUsed = getUsage(req.userId, 'ai');
        if (monthUsed >= FREE_AI_PER_MONTH) {
          return res.status(429).json({
            error: 'ai_limit_reached',
            message: `Free plan is limited to ${FREE_AI_PER_MONTH} AI actions per month. Upgrade to pquote Pro for unlimited.`,
            limit: FREE_AI_PER_MONTH,
            used: monthUsed,
            upgrade_url: '/billing',
          });
        }
      }
      const userUsed = readVoiceQuota(`user:${req.userId}`, USER_VOICE_WINDOW);
      if (userUsed >= USER_VOICE_LIMIT) {
        return res.status(429).json({
          error: 'user_limit_reached',
          message: `You've used ${USER_VOICE_LIMIT} voice quotes in 24h — try again tomorrow.`,
          remaining: 0,
          limit: USER_VOICE_LIMIT,
        });
      }
    }

    const examples    = getRecentQuotesForIndustry(req.userId, industry, 5);
    const calibration = getPricingCalibration(req.userId, industry);
    const materials   = getMaterialsForIndustry(industry);

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 400,
      system: `You are Q, a pricing assistant for trades on pquote.
Suggest a fair ballpark price for the job.
Priority order for grounding the price:
  1. The user's pricing calibration (if present) — anchor to their avg per-unit.
  2. Materials_kb application/coverage rates — use as ground truth, never invent.
  3. DFW Texas area market range otherwise.
Always respond with a JSON object only — no markdown, no commentary.`,
      messages: [{
        role: 'user',
        content: `Industry: ${JSON.stringify(industry)}
Parsed job: ${JSON.stringify(parsed_job)}
Selected add-ons: ${JSON.stringify(addons || [])}

User's recent similar jobs (calibration examples):
${JSON.stringify(examples, null, 2)}

User's pricing calibration summary (anchor your "suggested_price" to avg_per_unit when set):
${JSON.stringify(calibration)}

Materials / application-rate reference (industry-typical, use as ground truth):
${JSON.stringify(materials)}

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
    bumpVoiceDaily(); // count toward server-wide daily cap
    if (req.userId) {
      bumpVoiceQuota(`user:${req.userId}`, USER_VOICE_WINDOW);
      bumpUsage(req.userId, 'ai'); // count toward free-tier monthly cap
    }
    // Tier-based pricing precision. Anon + email-only see range only — the
    // precise number is the conversion lever. Full-tier users (DB password,
    // Google, env-configured) see the exact suggested_price.
    const tier = getUserTier(req);
    parsed.__tier = tier;
    if (tier !== 'full') {
      parsed.suggested_price = null;
      parsed.price_blurred   = true;
    }
    res.json(parsed);
  } catch (err) {
    console.error('AI voice/price error:', err);
    res.status(500).json({ error: 'AI price request failed' });
  }
});

// AI: Chat assistant (streaming-capable)
app.post('/api/ai/chat', async (req, res) => {
  try {
    const { messages, context } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const systemPrompt = `You are Q-Assist, an expert field quoting assistant for contractors and service professionals. You help users estimate jobs accurately, set competitive pricing, scope work, and use the QUOTE machine app effectively.

You think and communicate like a senior estimator / field supervisor — practical, direct, and confident with numbers.

IMPORTANT RULES:
- Ask ONE clarifying question at a time before building an estimate
- Be specific: include price ranges, unit types, and scope details
- Never suggest a final price without confirming the measurement and job type first
- Keep responses concise but actionable
- Never share competitor pricing tools or external service links

JOB TYPE PRICING RANGES:
- Pressure washing (flat surface): $0.08-$0.25/sq ft
- Sealcoating: $0.12-$0.30/sq ft; crack fill adds $0.50-$2.00/lin ft
- Parking lot striping (re-stripe): $3-$8/stall; new layout $6-$15/stall
- Roofing: price per square (100 sq ft); factor material type + tear-off + slope
- Concrete (new pour): price by sq ft; include excavation, forming, pour, finish
- Landscaping (sod): price by sq ft; ask about grading and sprinkler conflicts
- Painting/coating exterior: $1.50-$4.00/sq ft; interior $1.00-$3.00/sq ft

INTAKE PROTOCOL - gather these one at a time if not already known:
1) Job type
2) Measurement available?
3) Unit preference
4) Location type (residential / commercial / industrial)
5) Special conditions

MEASUREMENT GUIDANCE:
- Sq Ft: default for most surface work
- Lin Ft: perimeter work (striping, edging, crack fill, fencing)
- Sq Yd: concrete flatwork or large asphalt
- Acres: large grounds or landscaping scale
- Key conversions: 1 sq yd = 9 sq ft | 1 acre = 43,560 sq ft | 1 roofing square = 100 sq ft

FIELD CONTEXT: These users are in the field. Keep it fast and practical. Bullets over paragraphs. Dollar amounts over percentages. One question per turn, never two.

${context ? `Current quote context: ${JSON.stringify(context)}` : ''}`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.slice(-10)
    });

    res.json({ reply: response.content[0].text.trim() });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'AI chat request failed' });
  }
});

// ── Config endpoint (send Mapbox token to frontend)
// Helper: is this request actually from one of our own pages? Used to deny
// anonymous scraping of /api/config — the response includes the Mapbox
// public token, which is fine to expose to OUR users but we'd rather not
// hand it out to a curl loop pulling tokens for free Mapbox usage.
//
// Rule: if Origin is set, it must be in CORS_ORIGINS. Else if Referer is
// set, its hostname must match one of CORS_ORIGINS. If neither header is
// set, allow — covers legitimate same-origin server-side fetches and avoids
// breaking unusual but benign clients. The check is pragmatic, not airtight:
// any browser request will set one of these; a determined scraper can spoof
// them. Mapbox URL-allowlist on the token itself is the proper backstop.
function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (origin) {
    return CORS_ORIGINS.includes(origin) || CORS_ORIGINS.includes('*');
  }
  const referer = req.headers.referer;
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      return CORS_ORIGINS.includes(refOrigin) || CORS_ORIGINS.includes('*');
    } catch { return false; }
  }
  return true;
}

app.get('/api/config', (req, res) => {
  if (!isSameOriginRequest(req)) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  res.json({
    mapboxToken: process.env.MAPBOX_TOKEN || '',
    version: '2.0.0',
    pzipEnabled: !!(process.env.PZIP_WEBHOOK_URL && process.env.PZIP_API_KEY),
    // Frontend uses this to decide whether to render the Turnstile widget.
    // The actual secret stays on the server; only the public site-key ships.
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
    // Signup form uses this to decide whether to render the Pro option on
    // the plan picker. False = no Stripe wiring on this deploy, so signup
    // can only create free accounts.
    billingConfigured: !!(stripe && STRIPE_PRICE_PRO),
  });
});

// ── Send a saved quote to pzip.ai as a draft invoice.
//    Requires two Railway env vars on this service:
//      PZIP_WEBHOOK_URL  (e.g. https://www.pzip.ai/api/invoices/from-pquote)
//      PZIP_API_KEY      (the pqk_... key generated in pzip Settings → Integrations)
//    The quote's line_items JSON, if present, is unpacked into invoice line
//    items; otherwise a single line item is synthesized from project_type +
//    total.  We pass the qmach quote UUID as external_id so retries on the
//    pzip side are idempotent — a second click creates no duplicate.
app.post('/api/quotes/:id/send-to-pzip', requirePro, async (req, res) => {
  try {
    const webhook = process.env.PZIP_WEBHOOK_URL;
    const apiKey  = process.env.PZIP_API_KEY;
    if (!webhook || !apiKey) {
      return res.status(503).json({ error: 'pzip integration not configured. Set PZIP_WEBHOOK_URL + PZIP_API_KEY env vars on this service.' });
    }

    const q = db.prepare('SELECT * FROM quotes WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    if (!q) return res.status(404).json({ error: 'Quote not found.' });

    // Unpack line_items if the quote has them; fall back to a single-line synth.
    //
    // qmach line items are AREA-PRICED: each row is { area, unit, price, ... }
    // where `price` is a per-unit rate (e.g. $0.10/sqft) and the line total is
    // area × price.  Each row also carries a precomputed `subtotal` field (the
    // line total) — we use it directly so our math always matches qmach's
    // display math.  Bug this fixes: earlier version mapped qty=1 + unit_price=
    // li.price, which produced $0.10 instead of $91.40 on an area-priced line.
    //
    // For the invoice we collapse each area-priced line into one invoice line
    // with qty=1, unit_price=subtotal, and annotate the description with the
    // area + per-unit basis so the customer sees what they're paying for.
    let lineItems = [];
    try {
      const parsed = JSON.parse(q.line_items || '[]');
      if (Array.isArray(parsed) && parsed.length) {
        lineItems = parsed.map(li => {
          const area      = parseFloat(li.area) || 0;
          const unitRate  = parseFloat(li.price) || 0;
          const storedSub = parseFloat(li.subtotal);
          const lineTotal = Number.isFinite(storedSub) ? storedSub : (area * unitRate);
          const label     = (li.label || li.type || q.project_type || 'Quoted service').toString().replace(/-/g, ' ');
          const unit      = li.unit || 'sqft';
          const basis     = area > 0 && unitRate > 0
            ? ` (${area.toLocaleString()} ${unit} @ $${unitRate.toFixed(2)}/${unit})`
            : '';
          return {
            description: label + basis,
            qty: 1,
            unit_price: Math.round(lineTotal * 100) / 100,
          };
        });
      }
    } catch (_) { /* malformed line_items — ignore, use synth below */ }

    if (!lineItems.length) {
      lineItems = [{
        description: q.project_type || 'Quoted service',
        qty: 1,
        unit_price: parseFloat(q.total) || 0,
      }];
    }

    // Tax: pquote stores tax_rate as a PERCENT (e.g. 8.25 for 8.25%); pzip's
    // webhook interprets its `tax_rate` field as a fraction (0..1). Send the
    // already-computed dollar amount under `tax` instead — pzip prefers that
    // and the unit is unambiguous. Reproduces pquote's client-side math:
    // taxAmount = subtotal * (rate / 100), rounded to cents.
    const ratePct  = parseFloat(q.tax_rate) || 0;
    const subtotal = lineItems.reduce((s, li) => s + (parseFloat(li.unit_price) || 0), 0);
    const taxAmt   = Math.round(subtotal * (ratePct / 100) * 100) / 100;

    const payload = {
      client_name:    q.client_name,
      client_address: q.address || undefined,
      project_type:   q.project_type || undefined,
      total:          parseFloat(q.total) || 0,
      tax:            taxAmt,
      line_items:     lineItems,
      notes:          q.notes || undefined,
      external_id:    `qmach:${q.id}`,
    };

    const r = await fetch(webhook, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pquote-Api-Key': apiKey,
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ error: data.error || `pzip returned ${r.status}` });
    }

    res.json({
      ok: true,
      duplicate: !!data.duplicate,
      invoice_num: data.invoice_num,
      view_url: data.view_url ? (webhook.replace(/\/api\/.*$/, '') + data.view_url) : null,
    });
  } catch (err) {
    console.error('POST /api/quotes/:id/send-to-pzip error:', err);
    res.status(500).json({ error: 'Failed to send quote to pzip' });
  }
});

// ── Build identifier — derived from the commit SHA so /version is always
// truthful about which build is running, with no manual bumping. Railway
// injects RAILWAY_GIT_COMMIT_SHA at runtime; locally we fall back to
// `git rev-parse` so dev sees a real SHA too. Only returns 'unknown' when
// neither is available (e.g. running from a tarball outside a git tree).
const APP_VERSION = (() => {
  const railwaySha = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (railwaySha) return railwaySha.slice(0, 7);
  try {
    return require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
})();
console.log(`[Boot] pquote APP_VERSION = ${APP_VERSION}`);

// ── Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Version endpoint — returns the build identifier above so we can verify
// deploys without having to inspect static-asset response headers.
app.get('/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ version: APP_VERSION, timestamp: new Date().toISOString() });
});

// ── Landing page (public — no auth)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// ── App entry point
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/voice', (req, res) => {
  // Explicit no-cache so the HTML (which references the cache-busted
  // voice.css?v= and voice.js?v=) is always fetched fresh. Otherwise
  // iOS Safari can serve a stale HTML with old asset URLs and the
  // cache-bust never reaches the device.
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'voice.html'));
});

// ── Admin UI (the page itself is public HTML; the API endpoints below
// enforce ADMIN_USER_ID. Non-admins loading the page see a "not authorized"
// message rendered by the page's client-side auth check.)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Billing (subscription management). Public HTML — client-side calls
// /api/billing/status which is auth-gated and renders a sign-in nudge for
// unauthenticated visitors.
app.get('/billing', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'billing.html'));
});

// ── Account settings (profile, password, business preferences).
app.get('/account', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'account.html'));
});

// ── Catch-all: serve the SPA for page navigations, 404 for missed asset paths.
// Paths that look like files (have an extension) didn't match express.static,
// so they're genuine missing assets — send the branded 404 instead of HTML.
app.get('*', (req, res) => {
  if (/\.[a-z0-9]{2,5}$/i.test(req.path)) {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start
app.listen(PORT, () => {
  console.log(`pquote running on port ${PORT}`);
  console.log(`Routes: / → landing.html, /app → index.html`);
  // Banner reflects what the runtime auth check will actually do at request
  // time: DB users count toward "auth required" too, not just env-configured
  // ones. The old message said "Open access" even when DB signups existed,
  // which was misleading since isOpenAccess() already treated those as real
  // accounts.
  const dbUserCount = (() => {
    try { return countUsersStmt.get().n; } catch { return 0; }
  })();
  if (USERS.length > 1) {
    console.log(`Auth: ✓ Env users (${USERS.length}: ${USERS.map(u => u.name || u.id).join(', ')})${dbUserCount ? ` + ${dbUserCount} DB user(s)` : ''}`);
  } else if (USERS.length === 1) {
    console.log(`Auth: ✓ Env user (${USERS[0].name || USERS[0].id})${dbUserCount ? ` + ${dbUserCount} DB user(s)` : ''}`);
  } else if (dbUserCount > 0) {
    console.log(`Auth: ✓ DB accounts (${dbUserCount} user${dbUserCount === 1 ? '' : 's'} — email + password)`);
  } else {
    console.log('Auth: ✗ Open access (no users yet — signup via /app or set QMACH_USERS)');
  }
  console.log(`AI:   ${process.env.ANTHROPIC_API_KEY ? '✓ Configured' : '✗ Set ANTHROPIC_API_KEY to enable'}`);
});
