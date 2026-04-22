#!/usr/bin/env node
// One-off: re-send pquote quotes with tax_rate > 0 to the pzip webhook so
// previously-created invoices with inflated tax (the 825%-instead-of-8.25%
// bug) get refreshed with correct totals.
//
// Usage (from pquote/ dir, with pzip env vars available):
//   railway run --service qmach node scripts/reconcile-pzip-invoices.js
//   railway run --service qmach node scripts/reconcile-pzip-invoices.js --apply
//
// Dry-run (default): prints each quote + the bad-vs-good totals so you can
// eyeball what changes before touching any invoices.
// --apply: actually POSTs to pzip. The webhook is idempotent — drafts get
// refreshed in place (same invoice_num, same share link); finalized invoices
// are returned as {duplicate:true} and NOT mutated.
//
// Safety note: pquote has no "sent_to_pzip" flag, so this script will attempt
// to POST every candidate quote. For quotes that were NEVER sent to pzip
// before, the webhook creates a new DRAFT invoice — report lists these as
// "new" so you can delete them from pzip if unwanted.

const path = require('path');
const fs   = require('fs');

const APPLY = process.argv.includes('--apply');

// Locate the DB the same way db/database.js does so this works both on
// Railway (volume mount) and locally.
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'quotemachine.db');
if (!fs.existsSync(DB_PATH)) {
  console.error(`[abort] DB not found at ${DB_PATH}`);
  process.exit(1);
}

const WEBHOOK = process.env.PZIP_WEBHOOK_URL;
const API_KEY = process.env.PZIP_API_KEY;
if (APPLY && (!WEBHOOK || !API_KEY)) {
  console.error('[abort] --apply requires PZIP_WEBHOOK_URL and PZIP_API_KEY env vars');
  process.exit(1);
}

const Database = require('better-sqlite3');
const db = new Database(DB_PATH, { readonly: !APPLY ? false : false });

// Same line-item mapping pquote/server.js uses when sending to pzip.
function buildLineItems(q) {
  let items = [];
  try {
    const parsed = JSON.parse(q.line_items || '[]');
    if (Array.isArray(parsed) && parsed.length) {
      items = parsed.map(li => {
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
  } catch (_) {}
  if (!items.length) {
    items = [{
      description: q.project_type || 'Quoted service',
      qty: 1,
      unit_price: parseFloat(q.total) || 0,
    }];
  }
  return items;
}

function buildPayload(q) {
  const items    = buildLineItems(q);
  const ratePct  = parseFloat(q.tax_rate) || 0;
  const subtotal = items.reduce((s, li) => s + (parseFloat(li.unit_price) || 0), 0);
  const taxAmt   = Math.round(subtotal * (ratePct / 100) * 100) / 100;
  const goodTotal = Math.round((subtotal + taxAmt) * 100) / 100;

  return {
    payload: {
      client_name:    q.client_name,
      client_address: q.address || undefined,
      project_type:   q.project_type || undefined,
      total:          parseFloat(q.total) || 0,
      tax:            taxAmt,
      line_items:     items,
      notes:          q.notes || undefined,
      external_id:    `qmach:${q.id}`,
    },
    diag: {
      subtotal,
      correct_tax:   taxAmt,
      correct_total: goodTotal,
      // What pzip computed BEFORE the fix (rate treated as a fraction, not percent)
      buggy_tax:     Math.round(subtotal * ratePct * 100) / 100,
      buggy_total:   Math.round((subtotal + subtotal * ratePct) * 100) / 100,
      rate_pct:      ratePct,
    },
  };
}

async function post(payload) {
  const r = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Pquote-Api-Key': API_KEY },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

(async () => {
  const rows = db.prepare(`
    SELECT id, client_name, project_type, total, tax_rate, line_items, notes, address
      FROM quotes
     WHERE COALESCE(tax_rate, 0) > 0
     ORDER BY created_at ASC
  `).all();

  console.log(`Found ${rows.length} quote(s) with tax_rate > 0`);
  console.log(APPLY ? 'Mode: --apply (will POST to pzip)' : 'Mode: dry-run (no changes)');
  console.log('━'.repeat(80));

  const buckets = { refreshed: [], duplicate: [], new_invoice: [], error: [] };

  for (const q of rows) {
    const { payload, diag } = buildPayload(q);
    const line = `qmach:${q.id}  ${q.client_name.padEnd(24).slice(0,24)}  ` +
                 `rate=${diag.rate_pct.toFixed(2)}%  ` +
                 `bad=$${diag.buggy_total.toFixed(2).padStart(10)}  ` +
                 `good=$${diag.correct_total.toFixed(2).padStart(10)}`;

    if (!APPLY) { console.log(line, ' [DRY]'); continue; }

    try {
      const { ok, status, data } = await post(payload);
      if (!ok) {
        buckets.error.push({ id: q.id, status, error: data.error });
        console.log(line, ` ✗ ${status} ${data.error || ''}`);
        continue;
      }
      if (data.duplicate)      { buckets.duplicate.push(q.id);   console.log(line, ' · duplicate (finalized — not mutated)'); }
      else if (data.refreshed) { buckets.refreshed.push(q.id);   console.log(line, ' ✓ refreshed'); }
      else                     { buckets.new_invoice.push({ id: q.id, invoice_num: data.invoice_num, view_url: data.view_url }); console.log(line, ` ⚠ NEW invoice ${data.invoice_num}`); }
    } catch (e) {
      buckets.error.push({ id: q.id, error: String(e) });
      console.log(line, ` ✗ ${e}`);
    }
  }

  console.log('━'.repeat(80));
  if (APPLY) {
    console.log(`Refreshed (drafts fixed in place):       ${buckets.refreshed.length}`);
    console.log(`Duplicate (finalized — handle manually): ${buckets.duplicate.length}`);
    console.log(`New invoice (was never sent before):     ${buckets.new_invoice.length}`);
    console.log(`Errors:                                   ${buckets.error.length}`);
    if (buckets.duplicate.length)   console.log('\nFinalized (consider voiding + reissuing):\n  ' + buckets.duplicate.join('\n  '));
    if (buckets.new_invoice.length) console.log('\nFresh drafts (delete if unwanted):\n' + buckets.new_invoice.map(x => `  ${x.invoice_num}  ${x.view_url}`).join('\n'));
    if (buckets.error.length)       console.log('\nErrors:\n' + buckets.error.map(x => `  qmach:${x.id}  ${x.status || ''} ${x.error}`).join('\n'));
  } else {
    console.log('Re-run with --apply to execute. The webhook will:');
    console.log('  • refresh draft invoices in place (corrected totals, same share link)');
    console.log('  • return duplicate:true for finalized invoices (no mutation)');
    console.log('  • create a NEW draft for quotes that were never sent to pzip before');
  }

  db.close();
})().catch(e => { console.error(e); process.exit(1); });
