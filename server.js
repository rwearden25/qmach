require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('./db/database');
const backup = require('./db/backup');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway / any reverse proxy terminates TLS and forwards X-Forwarded-For.
// Required so express-rate-limit sees the real client IP instead of the proxy.
app.set('trust proxy', 1);

// ── Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
const insertUserStmt          = db.prepare('INSERT INTO users (id, email, password_hash, first_name, last_name, created_at, email_verified, verify_token, verify_sent_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)');
const getUserByEmailStmt      = db.prepare('SELECT id, email, password_hash, first_name, last_name, email_verified FROM users WHERE email = ?');
const getUserByVerifyStmt     = db.prepare('SELECT id, email FROM users WHERE verify_token = ?');
const setUserVerifiedStmt     = db.prepare('UPDATE users SET email_verified = 1, verify_token = NULL, verify_sent_at = NULL WHERE id = ?');
const setUserVerifyTokenStmt  = db.prepare('UPDATE users SET verify_token = ?, verify_sent_at = ? WHERE id = ?');
const setUserPasswordStmt     = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
const deleteUserStmt          = db.prepare('DELETE FROM users WHERE id = ?');
const deleteUserQuotesStmt    = db.prepare('DELETE FROM quotes WHERE user_id = ?');
const deleteUserSessionsStmt  = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const countUsersStmt          = db.prepare('SELECT COUNT(*) AS n FROM users');

// Password-reset one-shot tokens.
const insertResetStmt         = db.prepare('INSERT INTO password_resets (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
const getResetStmt            = db.prepare('SELECT token, user_id, expires_at FROM password_resets WHERE token = ?');
const deleteResetStmt         = db.prepare('DELETE FROM password_resets WHERE token = ?');
const deleteResetsByUserStmt  = db.prepare('DELETE FROM password_resets WHERE user_id = ?');
const pruneResetsStmt         = db.prepare('DELETE FROM password_resets WHERE expires_at < ?');

// Prune stale reset tokens on boot + hourly.
pruneResetsStmt.run(Date.now());
setInterval(() => { try { pruneResetsStmt.run(Date.now()); } catch {} }, 60 * 60 * 1000);

// Google account merge: one-shot migration that collapses legacy 'g:<email>'
// user_ids onto '<email>' whenever a DB user with that email exists. This
// unifies quotes saved via Google OAuth with the same person's DB account
// without requiring the user to do anything. Runs at boot; subsequent Google
// logins go through mergeGoogleLogin() below which keeps things unified.
try {
  const rows = db.prepare(`
    SELECT DISTINCT q.user_id AS gid, SUBSTR(q.user_id, 3) AS email
    FROM quotes q
    WHERE q.user_id LIKE 'g:%'
      AND EXISTS (SELECT 1 FROM users u WHERE u.email = SUBSTR(q.user_id, 3))
  `).all();
  const stmt = db.prepare('UPDATE quotes SET user_id = ? WHERE user_id = ?');
  let migrated = 0;
  for (const r of rows) { migrated += stmt.run(r.email, r.gid).changes; }
  if (migrated > 0) console.log(`[Auth] Merged ${migrated} Google-scoped quote(s) onto DB accounts`);
} catch (err) {
  console.error('[Auth] Google merge migration error:', err.message);
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
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "api.mapbox.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "api.mapbox.com", "fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "*.mapbox.com", "api.mapbox.com"],
      connectSrc: ["'self'", "api.mapbox.com", "events.mapbox.com", "*.tiles.mapbox.com", "*.supabase.co", "cdn.jsdelivr.net"],
      workerSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "fonts.gstatic.com", "fonts.googleapis.com"],
      frameSrc: ["'none'"]
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
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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
} catch (err) {
  console.error('[DB] Migration error:', err.message);
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

// ── Email delivery — Resend first, console log fallback.
// Set RESEND_API_KEY + MAIL_FROM on Railway to enable real email. Without
// those, we still log the message body (including verification/reset URLs)
// to stdout so the admin can fish links out of Railway logs during setup.
// All callers await this, but we never throw — a failed email shouldn't
// break signup or password-reset requests.
const MAIL_FROM  = process.env.MAIL_FROM || 'pquote <onboarding@resend.dev>';
const APP_ORIGIN = process.env.APP_ORIGIN || 'https://pquote.ai';

async function sendEmail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log('──────── [Email — not sent, no RESEND_API_KEY]');
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:\n${text.split('\n').map(l => '    ' + l).join('\n')}`);
    console.log('────────');
    return { ok: false, reason: 'not_configured' };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, text })
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`[Email] Resend ${r.status}:`, body);
      return { ok: false, reason: 'resend_error' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[Email] send failed:', err.message);
    return { ok: false, reason: 'network' };
  }
}

// ── Signup — first name, last name, email, password. Creates a DB user,
// hashes the password with bcrypt, generates a verification token, and
// returns a session token. The verify email is best-effort — signup
// succeeds even if the SMTP call fails, and the user gets a "resend"
// button inside the app.
app.post('/api/auth/signup', authLimiter, async (req, res) => {
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
    const verifyToken = uuidv4();
    try {
      insertUserStmt.run(email, email, hash, firstName, lastName, Date.now(), verifyToken, Date.now());
    } catch (err) {
      // Two signups racing for the same email — the pre-check above passed
      // for both, but the UNIQUE index catches the second INSERT. Return
      // 409 instead of a generic 500 so the client shows the right error.
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(409).json({ success: false, error: 'An account with that email already exists' });
      }
      throw err;
    }

    // Fire-and-forget the verify email; don't block the HTTP response.
    const verifyUrl = `${APP_ORIGIN}/api/auth/verify?token=${verifyToken}`;
    sendEmail(email, 'Confirm your pquote email',
      `Welcome to pquote, ${firstName}!\n\nConfirm your email to remove the reminder banner in the app:\n${verifyUrl}\n\nIf you didn't sign up, ignore this message.\n`
    ).catch(() => {});

    const token = createSession(email, userName);
    console.log(`[Auth] Signup: ${userName} (${email}), sessions active: ${sessionCount()}`);
    res.status(201).json({ success: true, token, userId: email, userName, emailVerified: false });
  } catch (err) {
    console.error('[Auth] Signup error:', err);
    res.status(500).json({ success: false, error: 'Signup failed' });
  }
});

// ── Verify email via the link delivered in the signup/resend email.
// This is a GET (triggered by a plain click in the user's mailbox) — on
// success we redirect to /app so they land back in the product. On failure
// we redirect to /app?verify=failed so the client can show a toast.
app.get('/api/auth/verify', (req, res) => {
  const token = String(req.query?.token || '').trim();
  if (!token) return res.redirect('/app?verify=failed');
  const user = getUserByVerifyStmt.get(token);
  if (!user) return res.redirect('/app?verify=failed');
  try {
    setUserVerifiedStmt.run(user.id);
    console.log(`[Auth] Email verified: ${user.email}`);
    return res.redirect('/app?verify=ok');
  } catch (err) {
    console.error('[Auth] verify error:', err);
    return res.redirect('/app?verify=failed');
  }
});

// ── Resend verification email — requires an authenticated session so a
// stranger can't spam someone's inbox by guessing addresses.
app.post('/api/auth/resend-verification', authLimiter, async (req, res) => {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ success: false, error: 'Not signed in' });
  const u = getUserByEmailStmt.get(sess.userId);
  if (!u) return res.status(404).json({ success: false, error: 'Not a DB account' });
  if (u.email_verified) return res.json({ success: true, already: true });
  const verifyToken = uuidv4();
  setUserVerifyTokenStmt.run(verifyToken, Date.now(), u.id);
  const verifyUrl = `${APP_ORIGIN}/api/auth/verify?token=${verifyToken}`;
  sendEmail(u.email, 'Confirm your pquote email',
    `Confirm your email to remove the reminder banner:\n${verifyUrl}\n`
  ).catch(() => {});
  res.json({ success: true });
});

// ── Forgot password — issues a one-shot reset token by email. We always
// respond 200 even if the email is unknown, so an attacker can't enumerate
// accounts by watching the response difference.
app.post('/api/auth/forgot', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.json({ success: true }); // no-op, don't leak
  const u = getUserByEmailStmt.get(email);
  if (u) {
    deleteResetsByUserStmt.run(u.id); // invalidate any pending token for this user
    const token = uuidv4();
    const now = Date.now();
    insertResetStmt.run(token, u.id, now, now + 60 * 60 * 1000); // 1h TTL
    const resetUrl = `${APP_ORIGIN}/app?reset=${token}`;
    sendEmail(email, 'Reset your pquote password',
      `Open this link within one hour to set a new password:\n${resetUrl}\n\nIf you didn't ask for a reset, ignore this email.\n`
    ).catch(() => {});
  }
  res.json({ success: true });
});

// ── Complete password reset — consumes the token, updates the hash,
// revokes all existing sessions for the user.
app.post('/api/auth/reset', authLimiter, (req, res) => {
  const token    = String(req.body?.token || '').trim();
  const password = String(req.body?.password || '');
  if (!token) return res.status(400).json({ success: false, error: 'Missing token' });
  if (password.length < 8 || password.length > 72
      || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return res.status(400).json({ success: false, error: 'Password must be 8–72 characters with an uppercase letter, a number, and a special character' });
  }
  const row = getResetStmt.get(token);
  if (!row) return res.status(400).json({ success: false, error: 'Invalid or expired reset link' });
  if (Date.now() > row.expires_at) {
    try { deleteResetStmt.run(token); } catch {}
    return res.status(400).json({ success: false, error: 'Reset link expired — request a new one' });
  }
  const hash = bcrypt.hashSync(password, 10);
  setUserPasswordStmt.run(hash, row.user_id);
  deleteResetStmt.run(token);
  deleteUserSessionsStmt.run(row.user_id);
  console.log(`[Auth] Password reset: ${row.user_id}`);
  res.json({ success: true });
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
      return res.json({ success: true, token, userId: u.id, userName, emailVerified: !!u.email_verified });
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

// ── Auth check — also returns user info and DB verification state.
app.get('/api/auth/check', (req, res) => {
  if (isOpenAccess()) return res.json({ valid: true, userId: 'default', userName: 'Admin', emailVerified: true });
  const sess = getSession(req);
  if (sess) {
    // emailVerified only meaningful for DB users. Google users (no DB row)
    // are trusted via the OAuth provider. Env users are trusted via config.
    const u = getUserByEmailStmt.get(sess.userId);
    const emailVerified = u ? !!u.email_verified : true;
    return res.json({ valid: true, userId: sess.userId, userName: sess.userName, emailVerified });
  }
  res.status(401).json({ valid: false });
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
    const userEmailLower = userEmail.toLowerCase();

    // Account merge: if a DB user exists with this email, sign the Google
    // user into that DB account (same user_id = the email). Otherwise
    // keep the legacy 'g:<email>' scheme for Google-only accounts. Any
    // pre-existing 'g:<email>' quotes are reparented onto the DB account
    // here as well, in case new quotes were saved before the boot-time
    // migration got a chance to run.
    const dbUser = getUserByEmailStmt.get(userEmailLower);
    let userId;
    if (dbUser) {
      userId = dbUser.id;
      try {
        const merged = db.prepare('UPDATE quotes SET user_id = ? WHERE user_id = ?')
          .run(userId, 'g:' + userEmailLower);
        if (merged.changes > 0) console.log(`[Auth] Merged ${merged.changes} Google quote(s) onto DB account ${userId}`);
      } catch {}
    } else {
      userId = 'g:' + userEmailLower;
    }

    const token = createSession(userId, userName);
    console.log(`[Auth] Google login: ${userName} (${userEmail}), sessions active: ${sessionCount()}`);
    res.json({ success: true, token, userId, userName, emailVerified: true });
  } catch (err) {
    console.error('[Auth] Google auth error:', err.message);
    res.status(500).json({ success: false, error: 'Google auth failed' });
  }
});

// ── Auth middleware — protect all /api/ routes except auth + config + health
//    Attaches req.userId for downstream route handlers
app.use('/api/', (req, res, next) => {
  // Skip auth for these paths
  const open = [
    '/auth', '/auth/check', '/auth/google',
    '/auth/login', '/auth/signup', '/auth/logout',
    '/auth/verify', '/auth/forgot', '/auth/reset',
    '/config'
  ];
  if (open.includes(req.path)) return next();

  // Fresh install with zero users anywhere — grant open access so the app
  // boots without config. Flips to "auth required" the moment any user
  // signs up or QMACH_USERS is set.
  if (isOpenAccess()) {
    req.userId = 'default';
    return next();
  }

  const sess = getSession(req);
  if (sess) {
    req.userId = sess.userId;
    req.userName = sess.userName;
    return next();
  }

  res.status(401).json({ error: 'Unauthorized — please log in' });
});

// ══════════════════════════════════════════
//  ACCOUNT — view profile, delete account
// ══════════════════════════════════════════

// Return the signed-in user's profile (DB users only — env and Google
// users get a minimal payload). Used by the in-app Account Settings modal.
app.get('/api/account/me', (req, res) => {
  const u = getUserByEmailStmt.get(req.userId);
  if (u) {
    return res.json({
      userId: u.id,
      email: u.email,
      firstName: u.first_name,
      lastName: u.last_name,
      emailVerified: !!u.email_verified,
      source: 'db'
    });
  }
  const source = typeof req.userId === 'string' && req.userId.startsWith('g:') ? 'google'
               : req.userId === 'default' ? 'open'
               : 'env';
  res.json({ userId: req.userId, email: null, firstName: null, lastName: null, emailVerified: true, source });
});

// Delete the current user's account: removes the user row (if DB-backed),
// all of their quotes, all of their sessions, and any pending reset tokens.
// Non-DB accounts (Google/env) can still trigger quote deletion via this
// endpoint, but the user row check is skipped.
app.delete('/api/account/me', (req, res) => {
  const userId = req.userId;
  if (!userId || userId === 'default') {
    return res.status(400).json({ success: false, error: 'No account to delete' });
  }
  try {
    const tx = db.transaction((id) => {
      deleteUserQuotesStmt.run(id);
      deleteUserSessionsStmt.run(id);
      deleteResetsByUserStmt.run(id);
      deleteUserStmt.run(id); // no-op if not a DB user
    });
    tx(userId);
    console.log(`[Auth] Account deleted: ${userId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Account] delete error:', err);
    res.status(500).json({ success: false, error: 'Delete failed' });
  }
});

// ══════════════════════════════════════════
//  QUOTES ROUTES — scoped by user_id
// ══════════════════════════════════════════

// GET all quotes (with optional search) — user's own quotes only
app.get('/api/quotes', (req, res) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;
    const userId = req.userId;
    let quotes;
    // Project only what the list + export consumers use. Drops polygon_geojson
    // and ai_narrative (the two heaviest blobs) — loadQuote uses /api/quotes/:id
    // for the full row.
    const LIST_COLS = 'id, client_name, project_type, total, created_at, address, line_items';
    if (search) {
      quotes = db.prepare(`
        SELECT ${LIST_COLS} FROM quotes
        WHERE user_id = ? AND (client_name LIKE ? OR project_type LIKE ? OR address LIKE ? OR notes LIKE ?)
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(userId, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, parseInt(limit), parseInt(offset));
    } else {
      quotes = db.prepare(`
        SELECT ${LIST_COLS} FROM quotes WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(userId, parseInt(limit), parseInt(offset));
    }
    const total = db.prepare('SELECT COUNT(*) as count FROM quotes WHERE user_id = ?').get(userId);
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

// POST create quote — assigned to current user
app.post('/api/quotes', (req, res) => {
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

// DELETE quote — must belong to user
app.delete('/api/quotes/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM quotes WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
    if (result.changes === 0) return res.status(404).json({ error: 'Quote not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete quote' });
  }
});

// GET stats — user's own stats only
app.get('/api/stats', (req, res) => {
  try {
    const userId = req.userId;
    const stats = {
      total_quotes: db.prepare('SELECT COUNT(*) as c FROM quotes WHERE user_id = ?').get(userId).c,
      total_value: db.prepare('SELECT SUM(total) as s FROM quotes WHERE user_id = ?').get(userId).s || 0,
      avg_quote: db.prepare('SELECT AVG(total) as a FROM quotes WHERE user_id = ?').get(userId).a || 0,
      this_month: db.prepare(`SELECT COUNT(*) as c FROM quotes WHERE user_id = ? AND created_at >= date('now','start of month')`).get(userId).c,
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
            AND q.line_items IS NOT NULL
            AND q.line_items != ''
            AND q.line_items != '[]'
          UNION ALL
          SELECT project_type, total AS revenue
          FROM quotes
          WHERE user_id = ?
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
//  AI ROUTES (Claude)
// ══════════════════════════════════════════

// AI: Suggest pricing based on project type + area
app.post('/api/ai/suggest-price', async (req, res) => {
  try {
    const { project_type, area, unit, location } = req.body;
    if (!project_type || !area || !unit) {
      return res.status(400).json({ error: 'project_type, area, and unit required' });
    }

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 512,
      system: `You are a pricing expert for trades and contracting businesses. 
You provide realistic market-rate pricing guidance for jobs. 
Always respond with a JSON object only — no markdown, no explanation.`,
      messages: [{
        role: 'user',
        content: `Give me realistic pricing for this job:
Project type: ${project_type}
Area/measurement: ${area} ${unit}
Location hint: ${location || 'DFW Texas area'}

Respond ONLY with this JSON structure:
{
  "low_per_unit": 0.00,
  "mid_per_unit": 0.00,
  "high_per_unit": 0.00,
  "low_total": 0.00,
  "mid_total": 0.00,
  "high_total": 0.00,
  "recommended_per_unit": 0.00,
  "reasoning": "brief 1-2 sentence explanation",
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
    res.json(parsed);
  } catch (err) {
    console.error('AI suggest-price error:', err);
    res.status(500).json({ error: 'AI pricing request failed' });
  }
});

// AI: Generate professional quote narrative
app.post('/api/ai/generate-narrative', async (req, res) => {
  try {
    const { client_name, project_type, area, unit, price_per_unit, total, notes, address, qty } = req.body;
    if (!client_name || !project_type) {
      return res.status(400).json({ error: 'client_name and project_type required' });
    }

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-6',
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

    res.json({ narrative: message.content[0].text.trim() });
  } catch (err) {
    console.error('AI narrative error:', err);
    res.status(500).json({ error: 'AI narrative generation failed' });
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
      model: 'claude-opus-4-6',
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
app.get('/api/config', (req, res) => {
  res.json({
    mapboxToken: process.env.MAPBOX_TOKEN || '',
    version: '2.0.0',
    pzipEnabled: !!(process.env.PZIP_WEBHOOK_URL && process.env.PZIP_API_KEY),
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
app.post('/api/quotes/:id/send-to-pzip', async (req, res) => {
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

    const payload = {
      client_name:    q.client_name,
      client_address: q.address || undefined,
      project_type:   q.project_type || undefined,
      total:          parseFloat(q.total) || 0,
      tax_rate:       parseFloat(q.tax_rate) || 0,
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

// ── Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Landing page (public — no auth)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// ── App entry point
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Admin UI (the page itself is public HTML; the API endpoints below
// enforce ADMIN_USER_ID. Non-admins loading the page see a "not authorized"
// message rendered by the page's client-side auth check.)
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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
  if (USERS.length > 1) {
    console.log(`Auth: ✓ Multi-user (${USERS.length} users: ${USERS.map(u => u.name || u.id).join(', ')})`);
  } else if (USERS.length === 1) {
    console.log(`Auth: ✓ Single-user (${USERS[0].name || USERS[0].id})`);
  } else {
    console.log('Auth: ✗ Open access (set QMACH_USERS or QMACH_PASSWORD)');
  }
  console.log(`AI:   ${process.env.ANTHROPIC_API_KEY ? '✓ Configured' : '✗ Set ANTHROPIC_API_KEY to enable'}`);
});
