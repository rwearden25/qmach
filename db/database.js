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
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_quotes_client ON quotes(client_name);
  CREATE INDEX IF NOT EXISTS idx_quotes_type   ON quotes(project_type);
  CREATE INDEX IF NOT EXISTS idx_quotes_date   ON quotes(created_at DESC);
`);

console.log(`SQLite database initialized at: ${DB_PATH}`);

module.exports = db;
