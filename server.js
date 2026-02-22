require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ══════════════════════════════════════════
//  AUTH — password from Railway env var
// ══════════════════════════════════════════
const AUTH_PASSWORD = process.env.QMACH_PASSWORD || '';
const sessions = new Map(); // token → { created, expires }
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Clean expired sessions every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [token, sess] of sessions) {
    if (now > sess.expires) sessions.delete(token);
  }
}, 30 * 60 * 1000);

// ── Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "api.mapbox.com", "cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "api.mapbox.com", "fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "*.mapbox.com", "api.mapbox.com"],
      connectSrc: ["'self'", "api.mapbox.com", "events.mapbox.com", "*.tiles.mapbox.com"],
      workerSrc: ["blob:"],
      fontSrc: ["'self'", "fonts.gstatic.com", "fonts.googleapis.com"],
      frameSrc: ["'none'"]
    }
  }
}));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiters
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const aiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: 'Too many AI requests, slow down.' } });

app.use('/api/', apiLimiter);
app.use('/api/ai/', aiLimiter);

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
} catch (err) {
  console.error('[DB] Migration error:', err.message);
}

// ── Auth endpoint (no auth required)
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (!AUTH_PASSWORD) {
    // No password set — open access
    return res.json({ success: true, token: 'open', message: 'No password configured' });
  }
  if (password === AUTH_PASSWORD) {
    const token = uuidv4();
    sessions.set(token, { created: Date.now(), expires: Date.now() + SESSION_TTL });
    console.log(`[Auth] Login success, sessions active: ${sessions.size}`);
    return res.json({ success: true, token });
  }
  console.log(`[Auth] Login failed`);
  res.status(401).json({ success: false, error: 'Wrong password' });
});

// ── Auth check endpoint
app.get('/api/auth/check', (req, res) => {
  if (!AUTH_PASSWORD) return res.json({ valid: true });
  const token = req.headers['x-auth-token'];
  if (token && sessions.has(token) && Date.now() < sessions.get(token).expires) {
    return res.json({ valid: true });
  }
  res.status(401).json({ valid: false });
});

// ── Auth middleware — protect all /api/ routes except auth + config + health
app.use('/api/', (req, res, next) => {
  // Skip auth for these paths
  if (req.path === '/auth' || req.path === '/auth/check' || req.path === '/config') return next();
  // Skip if no password is configured
  if (!AUTH_PASSWORD) return next();
  const token = req.headers['x-auth-token'];
  if (token && sessions.has(token) && Date.now() < sessions.get(token).expires) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized — please log in' });
});

// ══════════════════════════════════════════
//  QUOTES ROUTES
// ══════════════════════════════════════════

// GET all quotes (with optional search)
app.get('/api/quotes', (req, res) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;
    let quotes;
    if (search) {
      quotes = db.prepare(`
        SELECT * FROM quotes
        WHERE client_name LIKE ? OR project_type LIKE ? OR address LIKE ? OR notes LIKE ?
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, parseInt(limit), parseInt(offset));
    } else {
      quotes = db.prepare(`
        SELECT * FROM quotes ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(parseInt(limit), parseInt(offset));
    }
    const total = db.prepare('SELECT COUNT(*) as count FROM quotes').get();
    res.json({ quotes, total: total.count });
  } catch (err) {
    console.error('GET /api/quotes error:', err);
    res.status(500).json({ error: 'Failed to fetch quotes' });
  }
});

// GET single quote
app.get('/api/quotes/:id', (req, res) => {
  try {
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    res.json(quote);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

// POST create quote
app.post('/api/quotes', (req, res) => {
  try {
    const {
      client_name, project_type, area, unit, price_per_unit,
      total, notes, address, lat, lng, polygon_geojson, qty,
      ai_narrative, line_items, markup
    } = req.body;

    if (!client_name) {
      return res.status(400).json({ error: 'Missing required field: client_name' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO quotes
        (id, client_name, project_type, area, unit, price_per_unit, total, notes,
         address, lat, lng, polygon_geojson, qty, ai_narrative, line_items, markup)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      parseFloat(markup) || 0
    );

    const created = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
    res.status(201).json(created);
  } catch (err) {
    console.error('POST /api/quotes error:', err);
    res.status(500).json({ error: 'Failed to create quote' });
  }
});

// PUT update quote
app.put('/api/quotes/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM quotes WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Quote not found' });

    const fields = ['client_name','project_type','area','unit','price_per_unit','total','notes','address','lat','lng','polygon_geojson','qty','ai_narrative','line_items','markup'];
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
    db.prepare(`UPDATE quotes SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);

    res.json(db.prepare('SELECT * FROM quotes WHERE id = ?').get(req.params.id));
  } catch (err) {
    res.status(500).json({ error: 'Failed to update quote' });
  }
});

// DELETE quote
app.delete('/api/quotes/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM quotes WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Quote not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete quote' });
  }
});

// GET stats
app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      total_quotes: db.prepare('SELECT COUNT(*) as c FROM quotes').get().c,
      total_value: db.prepare('SELECT SUM(total) as s FROM quotes').get().s || 0,
      avg_quote: db.prepare('SELECT AVG(total) as a FROM quotes').get().a || 0,
      this_month: db.prepare(`SELECT COUNT(*) as c FROM quotes WHERE created_at >= date('now','start of month')`).get().c,
      by_type: db.prepare(`SELECT project_type, COUNT(*) as count, SUM(total) as revenue FROM quotes GROUP BY project_type ORDER BY revenue DESC`).all()
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
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
- Pressure washing (flat surface): $0.08–$0.25/sq ft
- Sealcoating: $0.12–$0.30/sq ft; crack fill adds $0.50–$2.00/lin ft
- Parking lot striping (re-stripe): $3–$8/stall; new layout $6–$15/stall
- Roofing: price per square (100 sq ft); factor material type + tear-off + slope
- Concrete (new pour): price by sq ft; include excavation, forming, pour, finish
- Landscaping (sod): price by sq ft; ask about grading and sprinkler conflicts
- Painting/coating exterior: $1.50–$4.00/sq ft; interior $1.00–$3.00/sq ft

INTAKE PROTOCOL — gather these one at a time if not already known:
1) Job type (pressure washing / sealcoating / striping / roofing / concrete / landscaping / painting / other)
2) Measurement available? (drawn on map / manually entered / estimated on-site)
3) Unit preference (sq ft / lin ft / sq yd / acres)
4) Location type (residential / commercial / industrial)
5) Special conditions (slopes, obstacles, contamination, access issues)

JOB TYPE ROUTING:
- "Parking lot" → likely striping + sealcoating combo — ask if both or just one
- "Driveway" → clarify concrete vs asphalt, size, condition
- "Roof" → clarify flat vs pitched, material, repair vs replacement
- "Building exterior" → pressure washing or painting — ask which
- Large acreage + mowing → landscaping / grounds maintenance

PRESSURE WASHING:
- Flat concrete/asphalt: $0.08–$0.25/sq ft depending on condition and equipment
- Building exterior: price by sq ft of surface area — factor stories, lift/ladder, chemical treatment
- Roof wash: price by sq ft of roof area — soft wash vs pressure wash affects safety and pricing
- Chemical treatment (pre-treat, neutralize, rinse) each adds cost as a separate line item

SEALCOATING:
- Fresh seal on weathered asphalt: 2 coats typical
- Confirm: crack fill included? Edging? Oil spot treatment? Each is a separate line item
- Crack fill: $0.50–$2.00/lin ft; oil spot: $15–$40/each

PARKING LOT STRIPING:
- Re-stripe (existing layout visible): $3–$8/stall or price per lin ft of paint
- New layout: add layout/design time, stencils, ADA compliance
- Line items: arrows, ADA stalls, fire lane, curb paint — each separate

ROOFING:
- Always price by square (100 sq ft) or sq ft — clarify with user
- Material type matters (shingle, metal, TPO, tile) — affects labor and material cost
- Tear-off required? Adds significant labor. Slope > 7/12 adds safety/time premium

CONCRETE:
- New pour: sq ft — include excavation, forming, pour, finish, cure
- Repair: lin ft for cracks, sq ft for spalling patches
- Decorative/coating: sq ft — ask about current surface condition

LANDSCAPING:
- Maintenance: per visit by sq ft or lot size
- Sod: sq ft — ask about grading, sprinkler conflicts
- Mulch/beds: cubic yard or sq ft at given depth
- Hardscape (pavers, walls): sq ft or lin ft depending on element

PAINTING / COATING:
- Exterior: sq ft of paintable surface (not floor area)
- Ask: prep level (pressure wash, scrape, prime), number of coats, paint grade

MEASUREMENT GUIDANCE:
- Sq Ft: default for most surface work
- Lin Ft: perimeter work (striping, edging, crack fill, fencing)
- Sq Yd: concrete flatwork or large asphalt (matches contractor convention)
- Acres: large grounds or landscaping scale
- Key conversions: 1 sq yd = 9 sq ft | 1 acre = 43,560 sq ft | 1 roofing square = 100 sq ft

MARKUP GUIDANCE:
- 0%: margin already built into $/unit rate
- 5–10%: light overhead recovery (fuel, consumables, admin)
- 15–20%: standard contractor overhead + profit
- 25%+: complex jobs, subcontractor coordination, premium positioning

APP HELP — QUOTE MACHINE:
- Draw tool (✏️): tap corners on satellite map → Done → all 4 units auto-fill instantly
- Any unit box (Sq Ft / Lin Ft / Sq Yd / Acres) can be manually edited — all others update in real time
- 📐 Map button on each line item pulls the measured area in that item's selected unit
- Multiple line items = multi-service quote with individual rates per item
- 💾 Save stores the quote with all measurements; ✏️ Edit reloads it fully adjustable
- PDF (branded) for professional client delivery; PDF (plain) for clean no-logo version
- 📤 Share sends via text, email, or clipboard copy

SCOPE OF WORK STRUCTURE (when writing narratives):
1) What service is being performed and on what surface
2) Preparation steps included
3) Materials or process details (brief)
4) What is NOT included
5) Close with: "This estimate is based on site conditions at time of visit. Final pricing subject to on-site inspection."

RESPONSE FORMAT for diagnostic/intake turns:
1) One-sentence summary of what you understand so far
2) ONE question or action step only — never two
3) Why it matters (1–2 sentences)
4) Likely next steps (ranked, brief)

RESPONSE FORMAT for direct pricing questions (measurement + job type already known):
1) Price range: low / mid / high with $/unit
2) Estimated total at mid rate
3) Key variables that push price up or down
4) Suggested line item breakdown if multi-component job

FIELD CONTEXT: These users are in the field. Keep it fast and practical. Bullets over paragraphs. Dollar amounts over percentages. One question per turn, never two. If a question can be answered in one sentence, use one sentence.

${context ? `Current quote context: ${JSON.stringify(context)}` : ''}`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.slice(-10) // keep last 10 turns for context
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
    version: '1.0.0'
  });
});

// ── Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Catch-all SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start
app.listen(PORT, () => {
  console.log(`QUOTE machine running on port ${PORT}`);
  console.log(`Auth: ${AUTH_PASSWORD ? '✓ Password protected' : '✗ Open access (set QMACH_PASSWORD to enable)'}`);
  console.log(`AI:   ${process.env.ANTHROPIC_API_KEY ? '✓ Configured' : '✗ Set ANTHROPIC_API_KEY to enable'}`);
});
