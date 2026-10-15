/*
 * timeavailable on Cloudflare Workers.
 * - Static files come from the `public/` assets binding.
 * - Each poll lives in its own Durable Object with built-in SQLite storage
 *   (free plan friendly, no external database to create).
 * The API logic is shared with the Node server: see lib/api.js.
 */
import { DurableObject } from 'cloudflare:workers';
import api from './lib/api.js';

const withHeaders = (res, extra = {}) => {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...api.SECURITY_HEADERS, ...extra })) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p.startsWith('/api/')) {
        api.checkWrite(request.method, (h) => request.headers.get(h));
        const parts = p.split('/').filter(Boolean);
        if (parts[1] === 'config') return json(200, { googleClientId: env.GOOGLE_CLIENT_ID || '', limits: api.LIMITS });
        if (parts[1] !== 'polls') return json(404, { error: 'Not found' });
        let id = parts[2];
        if (!id) {
          if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
          id = api.randomToken(8); // the new poll's Durable Object creates it
        }
        if (!/^[A-Za-z0-9_-]{6,32}$/.test(id)) return json(404, { error: 'Poll not found' });
        const stub = env.POLLS.get(env.POLLS.idFromName(id));
        const headers = new Headers(request.headers);
        headers.set('X-Poll-Id', id);
        return stub.fetch(new Request(request, { headers }));
      }
      if (p === '/healthz') return new Response('ok');
      let assetPath = p;
      if (/^\/p\/[A-Za-z0-9_-]+\/?$/.test(p)) assetPath = '/poll.html';
      else { const m = p.match(/^\/p\/([^/]+\.[a-z]+)$/); if (m) assetPath = '/' + m[1]; } // relative assets from /p/<id>
      if (assetPath === '/config.js') return withHeaders(new Response(api.configScript(env.GOOGLE_CLIENT_ID), { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } }));
      const res = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), { method: 'GET', headers: request.headers }));
      if (res.status === 404) return withHeaders(await env.ASSETS.fetch(new Request(new URL('/404.html', url.origin))), {});
      return withHeaders(res, assetPath.endsWith('.html') ? { 'Cache-Control': 'no-cache' } : {});
    } catch (e) {
      const r = api.errorResponse(e);
      return json(r.status, r.body);
    }
  },
};

export class PollStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, admin_key TEXT NOT NULL, config TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS responses (id TEXT PRIMARY KEY, poll_id TEXT NOT NULL, name TEXT NOT NULL, edit_key TEXT NOT NULL, pass_hash TEXT, slots TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    `);
    const sql = this.sql;
    this.store = {
      async insertPoll(p) { sql.exec('INSERT INTO polls (id, admin_key, config, created_at) VALUES (?, ?, ?, ?)', p.id, p.adminKey, JSON.stringify(p.config), p.createdAt); },
      async getPoll(id) { const r = sql.exec('SELECT * FROM polls WHERE id = ?', id).toArray()[0]; return r ? { id: r.id, adminKey: r.admin_key, config: JSON.parse(r.config), createdAt: r.created_at } : null; },
      async updatePollConfig(id, cfg) { sql.exec('UPDATE polls SET config = ? WHERE id = ?', JSON.stringify(cfg), id); },
      async deletePoll(id) { sql.exec('DELETE FROM responses WHERE poll_id = ?', id); sql.exec('DELETE FROM polls WHERE id = ?', id); },
      async listResponses(pollId) { return sql.exec('SELECT id, name, slots, pass_hash, updated_at FROM responses WHERE poll_id = ? ORDER BY created_at', pollId).toArray().map((r) => ({ id: r.id, name: r.name, slots: JSON.parse(r.slots), passHash: r.pass_hash, updatedAt: r.updated_at })); },
      async countResponses(pollId) { return sql.exec('SELECT COUNT(*) AS n FROM responses WHERE poll_id = ?', pollId).one().n; },
      async getResponse(pollId, rid) { const r = sql.exec('SELECT id, name, edit_key, pass_hash FROM responses WHERE id = ? AND poll_id = ?', rid, pollId).toArray()[0]; return r ? { id: r.id, name: r.name, editKey: r.edit_key, passHash: r.pass_hash } : null; },
      async findByName(pollId, name) { const r = sql.exec('SELECT id, name, edit_key, pass_hash, slots FROM responses WHERE poll_id = ? AND lower(name) = lower(?)', pollId, name).toArray()[0]; return r ? { id: r.id, name: r.name, editKey: r.edit_key, passHash: r.pass_hash, slots: JSON.parse(r.slots) } : null; },
      async insertResponse(r) { sql.exec('INSERT INTO responses (id, poll_id, name, edit_key, pass_hash, slots, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', r.id, r.pollId, r.name, r.editKey, r.passHash, JSON.stringify(r.slots), r.createdAt, r.updatedAt); },
      async updateResponse(rid, u) { sql.exec('UPDATE responses SET name = ?, slots = ?, updated_at = ? WHERE id = ?', u.name, JSON.stringify(u.slots), u.updatedAt, rid); },
      async setPassword(rid, hash) { sql.exec('UPDATE responses SET pass_hash = ? WHERE id = ?', hash, rid); },
      async deleteResponse(pollId, rid) { sql.exec('DELETE FROM responses WHERE id = ? AND poll_id = ?', rid, pollId); },
    };
  }
  async fetch(request) {
    const url = new URL(request.url);
    const id = request.headers.get('X-Poll-Id');
    try {
      let bodyText = null;
      const r = await api.handle({
        method: request.method, path: url.pathname, header: (h) => request.headers.get(h) ?? undefined,
        json: async () => { bodyText = bodyText ?? await request.text(); if (!bodyText) return {}; try { return JSON.parse(bodyText); } catch { throw new api.HttpError(400, 'Invalid JSON'); } },
      }, this.store, { googleClientId: this.env.GOOGLE_CLIENT_ID || '', newPollId: id });
      return json(r.status, r.body);
    } catch (e) {
      const r = api.errorResponse(e);
      return json(r.status, r.body);
    }
  }
}
