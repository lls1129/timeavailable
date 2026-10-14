'use strict';
/*
 * timeavailable — find common free time.
 * Zero-dependency Node.js (>= 22.13) server: static files + JSON API on
 * top of the built-in node:sqlite.
 *
 * The server only ever stores poll definitions and the availability grid
 * each participant chooses to submit. Google Calendar access happens
 * entirely in the browser; no token or event data reaches this server.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const Slots = require('./public/slots.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const MAX_BODY = 512 * 1024;
const LIMITS = { dates: 120, slotsPerPoll: 8000, title: 120, description: 2000, name: 60, responses: 500 };

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'timeavailable.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    admin_key TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS responses (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    edit_key TEXT NOT NULL,
    slots TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS responses_poll ON responses(poll_id);
`);
const stmts = {
  insertPoll: db.prepare('INSERT INTO polls (id, admin_key, config, created_at) VALUES (?, ?, ?, ?)'),
  getPoll: db.prepare('SELECT id, admin_key, config, created_at FROM polls WHERE id = ?'),
  updatePoll: db.prepare('UPDATE polls SET config = ? WHERE id = ?'),
  deletePoll: db.prepare('DELETE FROM polls WHERE id = ?'),
  listResponses: db.prepare('SELECT id, name, slots, updated_at FROM responses WHERE poll_id = ? ORDER BY created_at'),
  countResponses: db.prepare('SELECT COUNT(*) AS n FROM responses WHERE poll_id = ?'),
  getResponse: db.prepare('SELECT id, poll_id, name, edit_key FROM responses WHERE id = ? AND poll_id = ?'),
  findByName: db.prepare('SELECT id FROM responses WHERE poll_id = ? AND lower(name) = lower(?)'),
  insertResponse: db.prepare('INSERT INTO responses (id, poll_id, name, edit_key, slots, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateResponse: db.prepare('UPDATE responses SET name = ?, slots = ?, updated_at = ? WHERE id = ?'),
  deleteResponse: db.prepare('DELETE FROM responses WHERE id = ? AND poll_id = ?'),
};

const token = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function cleanText(v, max, field, required) {
  if (v == null) v = '';
  if (typeof v !== 'string') bad(`${field} must be text`);
  v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (required && !v) bad(`${field} is required`);
  if (v.length > max) bad(`${field} is too long (max ${max} characters)`);
  return v;
}

function validateConfig(body) {
  const title = cleanText(body.title, LIMITS.title, 'Title', true);
  const description = cleanText(body.description, LIMITS.description, 'Description', false);
  const tz = typeof body.tz === 'string' ? body.tz : '';
  if (!tz || !Slots.isValidTz(tz)) bad('Invalid timezone');
  if (!Array.isArray(body.dates) || !body.dates.length) bad('Pick at least one date');
  if (body.dates.length > LIMITS.dates) bad(`Too many dates (max ${LIMITS.dates})`);
  const dates = [...new Set(body.dates)];
  for (const d of dates) if (typeof d !== 'string' || !Slots.isValidDate(d)) bad(`Invalid date: ${d}`);
  dates.sort();
  const startMin = Number(body.startMin), endMin = Number(body.endMin), slotMin = Number(body.slotMin);
  if (!Number.isInteger(startMin) || startMin < 0 || startMin >= 1440) bad('Invalid start time');
  if (!Number.isInteger(endMin) || endMin <= startMin || endMin > 1440) bad('End time must be after start time');
  if (!Number.isInteger(slotMin) || slotMin < 5 || slotMin > 1440) bad('Slot length must be 5–1440 minutes');
  const allowMaybe = body.allowMaybe !== false;
  const excluded = Array.isArray(body.excluded) ? body.excluded.map(Number).filter(Number.isFinite) : [];
  const cfg = { title, description, tz, dates, startMin, endMin, slotMin, allowMaybe, excluded: [] };
  const all = Slots.generate({ ...cfg, excluded: [] });
  const allSet = new Set(all);
  cfg.excluded = [...new Set(excluded.filter((t) => allSet.has(t)))].sort((a, b) => a - b);
  const slots = Slots.generate(cfg);
  if (!slots.length) bad('The grid has no time slots');
  if (slots.length > LIMITS.slotsPerPoll) bad(`Too many time slots (${slots.length}, max ${LIMITS.slotsPerPoll}). Use longer slots or fewer dates.`);
  return cfg;
}

function validateSlots(raw, cfg) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) bad('slots must be an object');
  const valid = new Set(Slots.generate(cfg));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const t = Number(k);
    if (!valid.has(t)) continue; // silently drop slots not in the grid
    const level = v === 2 ? 2 : v === 1 ? 1 : 0;
    if (level === 0) continue;
    out[t] = cfg.allowMaybe ? level : 1;
  }
  return out;
}

function loadPoll(id) {
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(id)) throw new HttpError(404, 'Poll not found');
  const row = stmts.getPoll.get(id);
  if (!row) throw new HttpError(404, 'Poll not found');
  return { id: row.id, adminKey: row.admin_key, config: JSON.parse(row.config), createdAt: row.created_at };
}

function publicPoll(poll, req) {
  const responses = stmts.listResponses.all(poll.id).map((r) => ({
    id: r.id, name: r.name, slots: JSON.parse(r.slots), updatedAt: r.updated_at,
  }));
  const isAdmin = safeEqual(req.headers['x-admin-key'], poll.adminKey);
  return { id: poll.id, config: poll.config, createdAt: poll.createdAt, responses, isAdmin };
}

function requireAdmin(req, poll) {
  if (!safeEqual(req.headers['x-admin-key'], poll.adminKey)) throw new HttpError(403, 'Admin key required');
}

// ---------- API ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts.length === 2 && parts[1] === 'config' && method === 'GET') {
    return send(res, 200, { googleClientId: GOOGLE_CLIENT_ID, limits: LIMITS });
  }

  if (parts[1] !== 'polls') throw new HttpError(404, 'Not found');

  if (parts.length === 2 && method === 'POST') {
    const body = await readJson(req);
    const cfg = validateConfig(body);
    const id = token(8), adminKey = token(24);
    stmts.insertPoll.run(id, adminKey, JSON.stringify(cfg), Date.now());
    return send(res, 201, { id, adminKey });
  }

  const poll = loadPoll(parts[2] || '');

  if (parts.length === 3) {
    if (method === 'GET') return send(res, 200, publicPoll(poll, req));
    if (method === 'PATCH') {
      requireAdmin(req, poll);
      const body = await readJson(req);
      const cfg = { ...poll.config };
      if (body.title !== undefined) cfg.title = cleanText(body.title, LIMITS.title, 'Title', true);
      if (body.description !== undefined) cfg.description = cleanText(body.description, LIMITS.description, 'Description', false);
      if (body.closed !== undefined) cfg.closed = !!body.closed;
      stmts.updatePoll.run(JSON.stringify(cfg), poll.id);
      return send(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      requireAdmin(req, poll);
      stmts.deletePoll.run(poll.id);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (parts[3] !== 'responses') throw new HttpError(404, 'Not found');

  if (parts.length === 4 && method === 'POST') {
    if (poll.config.closed) throw new HttpError(403, 'This poll is closed');
    const body = await readJson(req);
    const name = cleanText(body.name, LIMITS.name, 'Name', true);
    const slots = validateSlots(body.slots, poll.config);
    if (stmts.findByName.get(poll.id, name)) throw new HttpError(409, 'Someone already answered with that name. If that was you, open your edit link or pick a different name.');
    if (stmts.countResponses.get(poll.id).n >= LIMITS.responses) throw new HttpError(403, 'This poll has reached the maximum number of responses');
    const id = token(8), editKey = token(18), now = Date.now();
    stmts.insertResponse.run(id, poll.id, name, editKey, JSON.stringify(slots), now, now);
    return send(res, 201, { id, editKey });
  }

  if (parts.length === 5) {
    const resp = stmts.getResponse.get(parts[4], poll.id);
    if (!resp) throw new HttpError(404, 'Response not found');
    const isOwner = safeEqual(req.headers['x-edit-key'], resp.edit_key);
    const isAdmin = safeEqual(req.headers['x-admin-key'], poll.adminKey);
    if (!isOwner && !isAdmin) throw new HttpError(403, 'Edit key required');
    if (method === 'PUT') {
      if (poll.config.closed && !isAdmin) throw new HttpError(403, 'This poll is closed');
      const body = await readJson(req);
      const name = cleanText(body.name, LIMITS.name, 'Name', true);
      const dup = stmts.findByName.get(poll.id, name);
      if (dup && dup.id !== resp.id) throw new HttpError(409, 'Someone else already uses that name');
      const slots = validateSlots(body.slots, poll.config);
      stmts.updateResponse.run(name, JSON.stringify(slots), Date.now(), resp.id);
      return send(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      stmts.deleteResponse.run(resp.id, poll.id);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed');
  }
  throw new HttpError(404, 'Not found');
}

// ---------- static ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "connect-src 'self' https://accounts.google.com/gsi/ https://www.googleapis.com/calendar/v3/freeBusy https://oauth2.googleapis.com/revoke https://accounts.google.com/o/oauth2/revoke",
  "frame-src https://accounts.google.com/gsi/",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data:",
  "base-uri 'self'", "form-action 'self'", "object-src 'none'", "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function serveFile(res, file, status = 200) {
  const ext = path.extname(file);
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (/^\/p\/[A-Za-z0-9_-]+\/?$/.test(p)) return serveFile(res, path.join(PUBLIC_DIR, 'poll.html'));
  if (p === '/healthz') return send(res, 200, 'ok');
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return serveFile(res, path.join(PUBLIC_DIR, '404.html'), 404);
    serveFile(res, file);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(req.method)) {
        // Same-origin only: browsers always send Origin on cross-site writes.
        const origin = req.headers.origin;
        if (origin && req.headers.host && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin requests are not allowed');
        const ct = req.headers['content-type'] || '';
        if (!ct.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
      }
      await api(req, res, url);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url);
    } else {
      send(res, 405, 'Method not allowed');
    }
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Internal server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`timeavailable listening on http://${HOST}:${PORT}  (data: ${DATA_DIR}, Google sign-in: ${GOOGLE_CLIENT_ID ? 'enabled' : 'disabled'})`);
  });
}
module.exports = { server, db };
