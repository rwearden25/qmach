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

const sessions = new Map(); // token → { userId, userName, created, expires }
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
} catch (err) {
  console.error('[DB] Migration error:', err.message);
}

// ── Helper: find user by password
function findUserByPassword(password) {
  return USERS.find(u => u.password === password) || null;
}

// ── Helper: get session from request
function getSession(req) {
  const token = req.headers['x-auth-token'];
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess || Date.now() > sess.expires) return null;
  return sess;
}

// ══════════════════════════════════════════
//  AUTH ENDPOINTS
// ══════════════════════════════════════════

// ── Login
app.post('/api/auth', (req, res) => {
  const { password } = req.body;

  // No users configured — open access
  if (USERS.length === 0) {
    return res.json({ success: true, token: 'open', userId: 'default', userName: 'Admin', message: 'No password configured' });
  }

  // Find matching user
  const user = findUserByPassword(password);
  if (user) {
    const token = uuidv4();
    sessions.set(token, {
      userId: user.id,
      userName: user.name || user.id,
      created: Date.now(),
      expires: Date.now() + SESSION_TTL
    });
    console.log(`[Auth] Login: ${user.name || user.id} (${user.id}), sessions active: ${sessions.size}`);
    return res.json({
      success: true,
      token,
      userId: user.id,
      userName: user.name || user.id
    });
  }

  console.log('[Auth] Login failed — wrong password');
  res.status(401).json({ success: false, error: 'Wrong password' });
});

// ── Auth check — also returns user info
app.get('/api/auth/check', (req, res) => {
  if (USERS.length === 0) return res.json({ valid: true, userId: 'default', userName: 'Admin' });
  const sess = getSession(req);
  if (sess) {
    return res.json({ valid: true, userId: sess.userId, userName: sess.userName });
  }
  res.status(401).json({ valid: false });
});

// ── Auth middleware — protect all /api/ routes except auth + config + health
//    Attaches req.userId for downstream route handlers
app.use('/api/', (req, res, next) => {
  // Skip auth for these paths
  if (req.path === '/auth' || req.path === '/auth/check' || req.path === '/config') return next();

  // No users configured — open access, default user
  if (USERS.length === 0) {
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
//  QUOTES ROUTES — scoped by user_id
// ══════════════════════════════════════════

// GET all quotes (with optional search) — user's own quotes only
app.get('/api/quotes', (req, res) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;
    const userId = req.userId;
    let quotes;
    if (search) {
      quotes = db.prepare(`
        SELECT * FROM quotes
        WHERE user_id = ? AND (client_name LIKE ? OR project_type LIKE ? OR address LIKE ? OR notes LIKE ?)
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(userId, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, parseInt(limit), parseInt(offset));
    } else {
      quotes = db.prepare(`
        SELECT * FROM quotes WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
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
      ai_narrative, line_items, markup
    } = req.body;

    if (!client_name) {
      return res.status(400).json({ error: 'Missing required field: client_name' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO quotes
        (id, client_name, project_type, area, unit, price_per_unit, total, notes,
         address, lat, lng, polygon_geojson, qty, ai_narrative, line_items, markup, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      req.userId
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
      by_type: db.prepare(`SELECT project_type, COUNT(*) as count, SUM(total) as revenue FROM quotes WHERE user_id = ? GROUP BY project_type ORDER BY revenue DESC`).all(userId)
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
    version: '2.0.0'
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
  if (USERS.length > 1) {
    console.log(`Auth: ✓ Multi-user (${USERS.length} users: ${USERS.map(u => u.name || u.id).join(', ')})`);
  } else if (USERS.length === 1) {
    console.log(`Auth: ✓ Single-user (${USERS[0].name || USERS[0].id})`);
  } else {
    console.log('Auth: ✗ Open access (set QMACH_USERS or QMACH_PASSWORD)');
  }
  console.log(`AI:   ${process.env.ANTHROPIC_API_KEY ? '✓ Configured' : '✗ Set ANTHROPIC_API_KEY to enable'}`);
});
