require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { v4: uuidv4 } = require('uuid');
const db = require('./db/database');
const backup = require('./db/backup');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway / any reverse proxy terminates TLS and forwards X-Forwarded-For.
// Required so express-rate-limit sees the real client IP instead of the proxy.
app.set('trust proxy', 1);

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

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SESSIONS = 1000; // prevent session DoS

// Sessions live in SQLite (table defined in db/database.js) so a deploy/restart
// doesn't force every signed-in user to re-authenticate.
const insertSessionStmt = db.prepare('INSERT INTO sessions (token, user_id, user_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
const getSessionStmt    = db.prepare('SELECT user_id, user_name, created_at, expires_at FROM sessions WHERE token = ?');
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token = ?');
const pruneSessionsStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
const countSessionsStmt = db.prepare('SELECT COUNT(*) AS n FROM sessions');
const oldestSessionStmt = db.prepare('SELECT token FROM sessions ORDER BY created_at ASC LIMIT 1');

function createSession(userId, userName) {
  // Evict oldest if at capacity (DoS prevention).
  if (countSessionsStmt.get().n >= MAX_SESSIONS) {
    const oldest = oldestSessionStmt.get();
    if (oldest) deleteSessionStmt.run(oldest.token);
  }
  const token = uuidv4();
  const now = Date.now();
  insertSessionStmt.run(token, userId, userName || userId, now, now + SESSION_TTL);
  return token;
}

function sessionCount() { return countSessionsStmt.get().n; }

// Prune expired rows every 30 min. Also runs once at boot to clear anything
// left over from a previous deploy.
pruneSessionsStmt.run(Date.now());
setInterval(() => {
  try { pruneSessionsStmt.run(Date.now()); } catch {}
}, 30 * 60 * 1000);

// ── Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "api.mapbox.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "api.mapbox.com", "fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "*.mapbox.com", "api.mapbox.com"],
      connectSrc: ["'self'", "api.mapbox.com", "events.mapbox.com", "*.tiles.mapbox.com", "*.supabase.co", "cdn.jsdelivr.net"],
      workerSrc: ["'self'", "blob:"],
      fontSrc: ["'self'", "fonts.gstatic.com", "fonts.googleapis.com"],
      frameSrc: ["'none'"]
    }
  }
}));
// Pin CORS to known origins by default. `CORS_ORIGIN` (comma-separated) can
// override. Same-origin requests (no Origin header) are always allowed.
const CORS_ORIGINS = (process.env.CORS_ORIGIN ||
  'https://pquote.ai,https://www.pquote.ai,http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl, same-origin, server-to-server
    cb(null, CORS_ORIGINS.includes(origin) || CORS_ORIGINS.includes('*'));
  },
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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
  // Per-quote tax rate. Existing rows backfilled to 0 — users can re-save to correct.
  if (!cols.includes('tax_rate')) {
    db.exec('ALTER TABLE quotes ADD COLUMN tax_rate REAL NOT NULL DEFAULT 0');
    console.log('[DB] Added tax_rate column');
  }
} catch (err) {
  console.error('[DB] Migration error:', err.message);
}

// ── Helper: find user by password (timing-safe)
function findUserByPassword(password) {
  if (!password) return null;
  return USERS.find(u => {
    if (password.length !== u.password.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(password), Buffer.from(u.password));
    } catch { return false; }
  }) || null;
}

// ── Helper: get session from request
function getSession(req) {
  const token = req.headers['x-auth-token'];
  if (!token) return null;
  const row = getSessionStmt.get(token);
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    try { deleteSessionStmt.run(token); } catch {}
    return null;
  }
  return { userId: row.user_id, userName: row.user_name, created: row.created_at, expires: row.expires_at };
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
    const token = createSession(user.id, user.name || user.id);
    console.log(`[Auth] Login: ${user.name || user.id} (${user.id}), sessions active: ${sessionCount()}`);
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

// ── Google OAuth — validate Supabase token and create pquote session
app.post('/api/auth/google', async (req, res) => {
  const { access_token, email, name } = req.body;
  if (!access_token || !email) {
    return res.status(400).json({ success: false, error: 'Missing token or email' });
  }

  // Validate the Supabase access token by calling Supabase's user endpoint
  try {
    const supabaseUrl = process.env.SUPABASE_URL || 'https://ywqidkugtavzqqhehppg.supabase.co';
    const supabaseAnon = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3cWlka3VndGF2enFxaGVocHBnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4MDI2NjMsImV4cCI6MjA5MDM3ODY2M30.ULTGwCFcukaU2SuKeM9OtdOI5pFV3wln_mz1zvRVQiQ';

    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'apikey': supabaseAnon
      }
    });

    if (!userRes.ok) {
      console.log('[Auth] Google token validation failed:', userRes.status);
      return res.status(401).json({ success: false, error: 'Invalid Google token' });
    }

    const userData = await userRes.json();
    const userEmail = userData.email;
    if (!userEmail) {
      console.log('[Auth] Google token validated but no email on user record');
      return res.status(401).json({ success: false, error: 'No email on Google account' });
    }
    const userName = userData.user_metadata?.full_name || name || userEmail;

    // Use email as user_id for Google users (prefix with 'g:' to distinguish from password users)
    const userId = 'g:' + userEmail;

    const token = createSession(userId, userName);
    console.log(`[Auth] Google login: ${userName} (${userEmail}), sessions active: ${sessionCount()}`);
    res.json({ success: true, token, userId, userName });
  } catch (err) {
    console.error('[Auth] Google auth error:', err.message);
    res.status(500).json({ success: false, error: 'Google auth failed' });
  }
});

// ── Auth middleware — protect all /api/ routes except auth + config + health
//    Attaches req.userId for downstream route handlers
app.use('/api/', (req, res, next) => {
  // Skip auth for these paths
  if (req.path === '/auth' || req.path === '/auth/check' || req.path === '/auth/google' || req.path === '/config') return next();

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
    // Project only what the list + export consumers use. Drops polygon_geojson
    // and ai_narrative (the two heaviest blobs) — loadQuote uses /api/quotes/:id
    // for the full row.
    const LIST_COLS = 'id, client_name, project_type, total, created_at, address, line_items';
    if (search) {
      quotes = db.prepare(`
        SELECT ${LIST_COLS} FROM quotes
        WHERE user_id = ? AND (client_name LIKE ? OR project_type LIKE ? OR address LIKE ? OR notes LIKE ?)
        ORDER BY created_at DESC LIMIT ? OFFSET ?
      `).all(userId, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, parseInt(limit), parseInt(offset));
    } else {
      quotes = db.prepare(`
        SELECT ${LIST_COLS} FROM quotes WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
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
      ai_narrative, line_items, markup, tax_rate
    } = req.body;

    if (!client_name) {
      return res.status(400).json({ error: 'Missing required field: client_name' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO quotes
        (id, client_name, project_type, area, unit, price_per_unit, total, notes,
         address, lat, lng, polygon_geojson, qty, ai_narrative, line_items, markup, user_id, tax_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      req.userId,
      parseFloat(tax_rate) || 0
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

    const fields = ['client_name','project_type','area','unit','price_per_unit','total','notes','address','lat','lng','polygon_geojson','qty','ai_narrative','line_items','markup','tax_rate'];
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
      // Revenue by type attributes each service to its actual project_type
      // (multi-service quotes used to dump everything onto items[0]'s type).
      // Legacy quotes without line_items fall back to the top-level columns.
      by_type: db.prepare(`
        WITH expanded AS (
          SELECT
            json_extract(li.value, '$.type') AS project_type,
            CAST(COALESCE(json_extract(li.value, '$.subtotal'), 0) AS REAL) AS revenue
          FROM quotes q, json_each(q.line_items) li
          WHERE q.user_id = ?
            AND q.line_items IS NOT NULL
            AND q.line_items != ''
            AND q.line_items != '[]'
          UNION ALL
          SELECT project_type, total AS revenue
          FROM quotes
          WHERE user_id = ?
            AND (line_items IS NULL OR line_items = '' OR line_items = '[]')
        )
        SELECT project_type, COUNT(*) AS count, SUM(revenue) AS revenue
        FROM expanded
        WHERE project_type IS NOT NULL
        GROUP BY project_type
        ORDER BY revenue DESC
      `).all(userId, userId)
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ══════════════════════════════════════════
//  BACKUP — admin-only database download
// ══════════════════════════════════════════
// Endpoint is disabled unless BACKUP_ADMIN_ID is set. Value must match
// req.userId exactly. Returns the latest on-volume snapshot (see db/backup.js).
// Pull it regularly from a second machine for offsite safety.
app.get('/api/backup/download', (req, res) => {
  const adminId = process.env.BACKUP_ADMIN_ID;
  if (!adminId) return res.status(403).json({ error: 'Backup endpoint disabled (BACKUP_ADMIN_ID not set)' });
  if (req.userId !== adminId) return res.status(403).json({ error: 'Forbidden' });
  const file = backup.latestBackup();
  if (!file) {
    // If no snapshot exists yet (e.g. fresh deploy, first-run window),
    // take one on-demand so the caller gets something useful.
    const r = backup.runDailyBackup();
    if (r.error) return res.status(500).json({ error: 'Backup generation failed' });
  }
  const latest = backup.latestBackup();
  if (!latest) return res.status(404).json({ error: 'No backup available' });
  res.download(latest);
});

app.get('/api/backup/list', (req, res) => {
  const adminId = process.env.BACKUP_ADMIN_ID;
  if (!adminId) return res.status(403).json({ error: 'Backup endpoint disabled (BACKUP_ADMIN_ID not set)' });
  if (req.userId !== adminId) return res.status(403).json({ error: 'Forbidden' });
  res.json({ backups: backup.listBackups() });
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

// ── Landing page (public — no auth)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// ── App entry point
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Catch-all: serve the SPA for page navigations, 404 for missed asset paths.
// Paths that look like files (have an extension) didn't match express.static,
// so they're genuine missing assets — send the branded 404 instead of HTML.
app.get('*', (req, res) => {
  if (/\.[a-z0-9]{2,5}$/i.test(req.path)) {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start
app.listen(PORT, () => {
  console.log(`pquote running on port ${PORT}`);
  console.log(`Routes: / → landing.html, /app → index.html`);
  if (USERS.length > 1) {
    console.log(`Auth: ✓ Multi-user (${USERS.length} users: ${USERS.map(u => u.name || u.id).join(', ')})`);
  } else if (USERS.length === 1) {
    console.log(`Auth: ✓ Single-user (${USERS[0].name || USERS[0].id})`);
  } else {
    console.log('Auth: ✗ Open access (set QMACH_USERS or QMACH_PASSWORD)');
  }
  console.log(`AI:   ${process.env.ANTHROPIC_API_KEY ? '✓ Configured' : '✗ Set ANTHROPIC_API_KEY to enable'}`);
});
