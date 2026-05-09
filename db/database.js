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
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

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

module.exports = db;
