'use strict';
/*
 * timeavailable — Node.js server (>= 22.13): static files + JSON API on top of
 * the built-in node:sqlite. The API itself lives in lib/api.js and is shared
 * with the Cloudflare Worker (worker.js).
 *
 * The server only ever stores poll definitions and the availability grid each
 * participant chooses to submit. Google Calendar access happens entirely in the
 * browser; no token or event data reaches this server.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const api = require('./lib/api.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const MAX_BODY = 512 * 1024;

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'timeavailable.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY, admin_key TEXT NOT NULL, config TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS responses (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    name TEXT NOT NULL, edit_key TEXT NOT NULL, pass_hash TEXT, slots TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS responses_poll ON responses(poll_id);
`);
try { db.exec('ALTER TABLE responses ADD COLUMN pass_hash TEXT'); } catch { /* column exists */ }
const q = {
  insertPoll: db.prepare('INSERT INTO polls (id, admin_key, config, created_at) VALUES (?, ?, ?, ?)'),
  getPoll: db.prepare('SELECT id, admin_key, config, created_at FROM polls WHERE id = ?'),
  updatePoll: db.prepare('UPDATE polls SET config = ? WHERE id = ?'),
  deletePoll: db.prepare('DELETE FROM polls WHERE id = ?'),
  listResponses: db.prepare('SELECT id, name, slots, pass_hash, updated_at FROM responses WHERE poll_id = ? ORDER BY created_at'),
  countResponses: db.prepare('SELECT COUNT(*) AS n FROM responses WHERE poll_id = ?'),
  getResponse: db.prepare('SELECT id, name, edit_key, pass_hash FROM responses WHERE id = ? AND poll_id = ?'),
  findByName: db.prepare('SELECT id, name, edit_key, pass_hash, slots FROM responses WHERE poll_id = ? AND lower(name) = lower(?)'),
  insertResponse: db.prepare('INSERT INTO responses (id, poll_id, name, edit_key, pass_hash, slots, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  updateResponse: db.prepare('UPDATE responses SET name = ?, slots = ?, updated_at = ? WHERE id = ?'),
  setPassword: db.prepare('UPDATE responses SET pass_hash = ? WHERE id = ?'),
  deleteResponse: db.prepare('DELETE FROM responses WHERE id = ? AND poll_id = ?'),
};
const store = {
  async insertPoll(p) { q.insertPoll.run(p.id, p.adminKey, JSON.stringify(p.config), p.createdAt); },
  async getPoll(id) { const r = q.getPoll.get(id); return r ? { id: r.id, adminKey: r.admin_key, config: JSON.parse(r.config), createdAt: r.created_at } : null; },
  async updatePollConfig(id, cfg) { q.updatePoll.run(JSON.stringify(cfg), id); },
  async deletePoll(id) { q.deletePoll.run(id); },
  async listResponses(pollId) { return q.listResponses.all(pollId).map((r) => ({ id: r.id, name: r.name, slots: JSON.parse(r.slots), passHash: r.pass_hash, updatedAt: r.updated_at })); },
  async countResponses(pollId) { return q.countResponses.get(pollId).n; },
  async getResponse(pollId, rid) { const r = q.getResponse.get(rid, pollId); return r ? { id: r.id, name: r.name, editKey: r.edit_key, passHash: r.pass_hash } : null; },
  async findByName(pollId, name) { const r = q.findByName.get(pollId, name); return r ? { id: r.id, name: r.name, editKey: r.edit_key, passHash: r.pass_hash, slots: JSON.parse(r.slots) } : null; },
  async insertResponse(r) { q.insertResponse.run(r.id, r.pollId, r.name, r.editKey, r.passHash, JSON.stringify(r.slots), r.createdAt, r.updatedAt); },
  async updateResponse(rid, u) { q.updateResponse.run(u.name, JSON.stringify(u.slots), u.updatedAt, rid); },
  async setPassword(rid, hash) { q.setPassword.run(hash, rid); },
  async deleteResponse(pollId, rid) { q.deleteResponse.run(rid, pollId); },
};

// ---------- http ----------
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store', ...headers,
  });
  res.end(data);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new api.HttpError(413, 'Request too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new api.HttpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
function serveFile(res, file, status = 200) {
  const ext = path.extname(file);
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(status, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300', ...api.SECURITY_HEADERS });
    res.end(data);
  });
}
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (/^\/p\/[A-Za-z0-9_-]+\/?$/.test(p)) return serveFile(res, path.join(PUBLIC_DIR, 'poll.html'));
  if (p === '/healthz') return send(res, 200, 'ok');
  const m = p.match(/^\/p\/([^/]+\.[a-z]+)$/); // relative assets referenced from /p/<id>
  if (m) p = '/' + m[1];
  if (p === '/config.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache', ...api.SECURITY_HEADERS });
    return res.end(api.configScript(GOOGLE_CLIENT_ID));
  }
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
      api.checkWrite(req.method, (h) => req.headers[h]);
      const r = await api.handle({ method: req.method, path: url.pathname, header: (h) => req.headers[h], json: () => readJson(req) }, store, { googleClientId: GOOGLE_CLIENT_ID });
      send(res, r.status, r.body);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, url);
    } else send(res, 405, 'Method not allowed');
  } catch (e) {
    const r = api.errorResponse(e);
    send(res, r.status, r.body);
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`timeavailable listening on http://${HOST}:${PORT}  (data: ${DATA_DIR}, Google sign-in: ${GOOGLE_CLIENT_ID ? 'enabled' : 'disabled'})`));
}
module.exports = { server, db };
