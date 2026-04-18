const fs = require('fs');
const path = require('path');
const db = require('./database');

// Daily SQLite snapshots into <volume>/backups/pquote-YYYY-MM-DD.db.
// VACUUM INTO produces a consistent single-file copy even under WAL, without
// blocking readers for any meaningful time on a DB this size. These live on
// the same Railway volume as the primary DB — protects against app-level
// corruption / accidental row deletion, NOT against volume loss. For offsite
// safety, pair with the /api/backup/download endpoint and pull a copy
// periodically from a second machine.

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const RETAIN_DAYS = 14;

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function todayStamp() { return new Date().toISOString().slice(0, 10); }

function backupPath(stamp) { return path.join(BACKUP_DIR, `pquote-${stamp}.db`); }

function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => /^pquote-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort(); // lexical sort matches chronological for ISO dates
}

function pruneOld() {
  const files = listBackups();
  const excess = files.length - RETAIN_DAYS;
  if (excess <= 0) return 0;
  let removed = 0;
  for (let i = 0; i < excess; i++) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, files[i])); removed++; } catch {}
  }
  return removed;
}

function runDailyBackup() {
  try {
    const stamp = todayStamp();
    const dest = backupPath(stamp);
    if (fs.existsSync(dest)) return { skipped: true, path: dest };
    // VACUUM INTO requires the destination to NOT exist.
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const removed = pruneOld();
    console.log(`[Backup] ${stamp} ok${removed ? ` (pruned ${removed})` : ''}`);
    return { created: true, path: dest, pruned: removed };
  } catch (err) {
    console.error('[Backup] Failed:', err.message);
    return { error: err.message };
  }
}

function latestBackup() {
  const files = listBackups();
  return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
}

// Run shortly after boot (first-time install, or catch-up if the process was
// down all day) and then check hourly — runDailyBackup short-circuits when
// today's snapshot already exists, so the hourly check is essentially free.
setTimeout(runDailyBackup, 30 * 1000);
setInterval(runDailyBackup, 60 * 60 * 1000);

module.exports = { runDailyBackup, latestBackup, listBackups, BACKUP_DIR };
