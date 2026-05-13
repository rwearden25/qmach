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
  CREATE INDEX IF NOT EXISTS idx_users_email           ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
`);

console.log(`SQLite database initialized at: ${DB_PATH}`);

module.exports = db;
