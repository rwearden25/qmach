const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Railway provides /data as persistent volume mount point
// Fall back to local ./data for dev
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'quotemachine.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS quotes (
    id              TEXT PRIMARY KEY,
    client_name     TEXT NOT NULL,
    project_type    TEXT NOT NULL,
    area            REAL NOT NULL DEFAULT 0,
    unit            TEXT NOT NULL DEFAULT 'sqft',
    price_per_unit  REAL NOT NULL DEFAULT 0,
    total           REAL NOT NULL DEFAULT 0,
    qty             INTEGER NOT NULL DEFAULT 1,
    markup          REAL NOT NULL DEFAULT 0,
    notes           TEXT DEFAULT '',
    address         TEXT DEFAULT '',
    lat             REAL,
    lng             REAL,
    polygon_geojson TEXT,
    ai_narrative    TEXT DEFAULT '',
    line_items      TEXT,
    tax_rate        REAL NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_quotes_client ON quotes(client_name);
  CREATE INDEX IF NOT EXISTS idx_quotes_type   ON quotes(project_type);
  CREATE INDEX IF NOT EXISTS idx_quotes_date   ON quotes(created_at DESC);

  -- Auth sessions. Persisted to SQLite so deploys/restarts don't force
  -- every signed-in user to re-authenticate. TTL + cap enforced in server.js.
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    user_name  TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  -- Registered users (email + bcrypt password). The older env-based
  -- QMACH_USERS flow is still honored in server.js as a fallback; new
  -- signups land here. user_id in quotes/sessions = the user's email.
  --
  -- Billing columns are populated by Stripe webhook events. plan is the
  -- product slug ('free' | 'pro'), subscription_status mirrors the Stripe
  -- subscription.status value, and current_period_end is a unix-ms
  -- timestamp used by /api/billing/status to render the renewal date.
  CREATE TABLE IF NOT EXISTS users (
    id                     TEXT PRIMARY KEY,
    email                  TEXT UNIQUE NOT NULL,
    password_hash          TEXT NOT NULL,
    first_name             TEXT NOT NULL,
    last_name              TEXT NOT NULL,
    created_at             INTEGER NOT NULL,
    stripe_customer_id     TEXT,
    stripe_subscription_id TEXT,
    plan                   TEXT NOT NULL DEFAULT 'free',
    subscription_status    TEXT,
    current_period_end     INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  -- idx_users_stripe_customer is created in server.js AFTER the ALTER TABLE
  -- migration adds the column. Putting it here breaks boot on existing DBs
  -- where the table predates the billing columns: CREATE TABLE IF NOT EXISTS
  -- is a no-op for those, the column never gets added by this file, and the
  -- index then fails with "no such column: stripe_customer_id".

  -- Voice-endpoint spend counters. Persisted (was in-memory) so a Railway
  -- restart doesn't reset the daily kill-switch or hand every guest fresh
  -- quota. Keys are namespaced strings:
  --   daily:YYYY-MM-DD  → server-wide daily voice call count (UTC)
  --   ip:<addr>         → per-IP guest analyses (24h window)
  --   gid:<cookie>      → per-cookie guest analyses (24h window)
  --   user:<userId>     → per-authenticated-user analyses (24h window)
  -- first_at is when the row was opened; readers expire rows past their window.
  CREATE TABLE IF NOT EXISTS voice_quota (
    key      TEXT PRIMARY KEY,
    count    INTEGER NOT NULL DEFAULT 0,
    first_at INTEGER NOT NULL,
    last_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_voice_quota_first_at ON voice_quota(first_at);

  -- Reusable materials / application-rate knowledge base (seeded from
  -- a JSON file at boot — see seedMaterialsKB in server.js). Used by
  -- the AI prompts on /voice/analyze, /voice/price, and /api/ai/suggest-price
  -- so suggested pricing reflects real material economics rather than
  -- generic "what does Q know from training data" guesses.
  --
  -- key       — short stable identifier ("paint_coverage_sqft_per_gal")
  -- low/mid/high — tier values (typical industry range)
  -- unit      — what the value is denominated in
  -- region    — 'US' for now; reserved for "DFW", "Northeast", etc.
  CREATE TABLE IF NOT EXISTS materials_kb (
    id         TEXT PRIMARY KEY,
    industry   TEXT NOT NULL,
    key        TEXT NOT NULL,
    label      TEXT NOT NULL,
    value_low  REAL,
    value_mid  REAL,
    value_high REAL,
    unit       TEXT,
    region     TEXT NOT NULL DEFAULT 'US',
    source     TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_materials_kb_industry ON materials_kb(industry, region);

  -- Soft (email-only) signups. The conversion funnel has three tiers:
  --   anon       → 1 voice quote, range-only pricing, no PDF
  --   email_only → unlimited (per per-user cap) quotes, range-only pricing, watermarked PDF
  --   full       → email + password (or Google), precise pricing, clean PDF
  -- This table just tracks the marketing list. Sessions for these users
  -- are minted with user_id = 'e:<email>' (mirrors the 'g:' Google convention).
  CREATE TABLE IF NOT EXISTS email_only_signups (
    email      TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );
`);

console.log(`SQLite database initialized at: ${DB_PATH}`);

// ── Seed materials_kb from db/materials_seed.json on every boot. UPSERT
// semantics so editing the JSON + redeploying refreshes the rows
// (deterministic id from industry+key). Safe to run on startup; the
// table is small (<200 rows expected).
try {
  const seedPath = path.join(__dirname, 'materials_seed.json');
  if (fs.existsSync(seedPath)) {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const upsert = db.prepare(`
      INSERT INTO materials_kb (id, industry, key, label, value_low, value_mid, value_high, unit, region, source, created_at)
      VALUES (@id, @industry, @key, @label, @value_low, @value_mid, @value_high, @unit, @region, @source, @created_at)
      ON CONFLICT(id) DO UPDATE SET
        label      = excluded.label,
        value_low  = excluded.value_low,
        value_mid  = excluded.value_mid,
        value_high = excluded.value_high,
        unit       = excluded.unit,
        region     = excluded.region,
        source     = excluded.source
    `);
    const now = Date.now();
    let n = 0;
    db.transaction(() => {
      for (const r of seed.rows || []) {
        if (!r.industry || !r.key) continue;
        const region = r.region || 'US';
        upsert.run({
          id: `${r.industry}:${r.key}:${region}`,
          industry: r.industry,
          key: r.key,
          label: r.label || r.key,
          value_low:  r.value_low  ?? null,
          value_mid:  r.value_mid  ?? null,
          value_high: r.value_high ?? null,
          unit: r.unit || '',
          region,
          source: r.source || '',
          created_at: now,
        });
        n++;
      }
    })();
    console.log(`[KB] materials_kb seeded (${n} rows)`);
  }
} catch (err) {
  console.error('[KB] materials_kb seed failed:', err.message);
}

module.exports = db;
