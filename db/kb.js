const db = require('./database');

// Returns up to `limit` most recent saved quotes for this user matching
// either the chosen project_type OR the inferred_industry from a prior
// voice quote. Used by the voice analyze + price endpoints to inject
// worked examples (calibrated to the user's actual pricing) into Q's prompt.
function getRecentQuotesForIndustry(userId, industry, limit = 5) {
  if (!userId || !industry) return [];
  const rows = db.prepare(`
    SELECT id, project_type, area, unit, total, line_items, notes, created_at
    FROM quotes
    WHERE user_id = ?
      AND (project_type = ? OR inferred_industry = ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, industry, industry, limit);

  return rows.map(r => ({
    id: r.id,
    project_type: r.project_type,
    area: r.area,
    unit: r.unit,
    total: r.total,
    line_items: r.line_items ? safeJsonParse(r.line_items) : null,
    notes: r.notes || '',
    created_at: r.created_at,
  }));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

module.exports = { getRecentQuotesForIndustry };
