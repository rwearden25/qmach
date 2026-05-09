const db = require('./database');

// Returns up to `limit` most recent saved quotes for this user matching
// either the chosen project_type OR the inferred_industry from a prior
// voice quote. Used by the voice analyze + price endpoints to inject
// worked examples (calibrated to the user's actual pricing) into Q's prompt.
function getRecentQuotesForIndustry(userId, industry, limit = 5) {
  if (!userId || !industry) return [];
  const rows = db.prepare(`
    SELECT id, project_type, area, unit, price_per_unit, total, line_items, notes, created_at
    FROM quotes
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND (project_type = ? OR inferred_industry = ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, industry, industry, limit);

  return rows.map(r => ({
    id: r.id,
    project_type: r.project_type,
    area: r.area,
    unit: r.unit,
    price_per_unit: r.price_per_unit,
    total: r.total,
    line_items: r.line_items ? safeJsonParse(r.line_items) : null,
    notes: r.notes || '',
    created_at: r.created_at,
  }));
}

// Compute per-unit pricing summary across the user's recent jobs in an
// industry. Returns { count, avg_per_unit, min, max } for use in AI prompts —
// this is what makes "calibrated to your pricing" actually work; the prompt
// can say "this user typically charges $0.18/sqft for pressure washing" and
// the model anchors its suggestion to that number instead of a generic
// market range.
function getPricingCalibration(userId, industry, limit = 20) {
  if (!userId || !industry) return null;
  const rows = db.prepare(`
    SELECT price_per_unit, area, total, unit
    FROM quotes
    WHERE user_id = ?
      AND deleted_at IS NULL
      AND (project_type = ? OR inferred_industry = ?)
      AND price_per_unit > 0
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, industry, industry, limit);
  if (!rows.length) return null;
  const ppu = rows.map(r => r.price_per_unit).filter(n => n > 0);
  if (!ppu.length) return null;
  const avg = ppu.reduce((s, n) => s + n, 0) / ppu.length;
  return {
    count: ppu.length,
    avg_per_unit: Math.round(avg * 1000) / 1000,
    min_per_unit: Math.min(...ppu),
    max_per_unit: Math.max(...ppu),
    typical_unit: rows[0].unit,
  };
}

// Lookup industry-specific materials / application-rate context for AI
// prompts. Returns rows from materials_kb that the model can use as ground
// truth (e.g., "1 gallon of paint covers 250-400 sqft" instead of guessing).
function getMaterialsForIndustry(industry, region = 'US') {
  if (!industry) return [];
  return db.prepare(`
    SELECT key, label, value_low, value_mid, value_high, unit, source
    FROM materials_kb
    WHERE industry = ? AND (region = ? OR region = 'US')
    ORDER BY industry, key
  `).all(industry, region);
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = {
  getRecentQuotesForIndustry,
  getPricingCalibration,
  getMaterialsForIndustry,
};
