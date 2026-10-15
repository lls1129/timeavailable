'use strict';
/*
 * Platform-neutral API for timeavailable. Used by server.js (Node + SQLite)
 * and worker.js (Cloudflare Worker + Durable Object SQLite).
 *
 * handle(req, store, env) takes a plain request description and an async
 * storage adapter and returns { status, body }.
 */
const Slots = require('../public/slots.js');

const LIMITS = { dates: 120, slotsPerPoll: 8000, title: 120, description: 2000, name: 60, password: 100, responses: 500 };

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg) => { throw new HttpError(400, msg); };

// ---------- crypto (WebCrypto: available in Node >= 20 and in Workers) ----------
const subtle = globalThis.crypto.subtle;
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const randomToken = (bytes) => b64u(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
const PBKDF2_ITER = 100000;
async function pbkdf2(password, salt, iter) {
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(password) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64u(salt)}$${b64u(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}
async function verifyPassword(password, stored) {
  const [, iter, salt, hash] = String(stored).split('$');
  const got = b64u(await pbkdf2(password, unb64u(salt), Number(iter)));
  return safeEqual(got, hash);
}

// ---------- validation ----------
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
  if (!Number.isInteger(slotMin) || slotMin < 5 || slotMin > 1440) bad('Start-time step must be 5–1440 minutes');
  const durationMin = body.durationMin == null ? slotMin : Number(body.durationMin);
  if (!Number.isInteger(durationMin) || durationMin < slotMin || durationMin > 1440) bad('Meeting length must be at least one step and at most 24 hours');
  if (durationMin % slotMin !== 0) bad(`Meeting length (${durationMin} min) must be a multiple of the start-time step (${slotMin} min)`);
  if (durationMin > endMin - startMin) bad('Meeting length is longer than the daily time window');
  const allowMaybe = body.allowMaybe !== false;
  const excluded = Array.isArray(body.excluded) ? body.excluded.map(Number).filter(Number.isFinite) : [];
  const cfg = { title, description, tz, dates, startMin, endMin, slotMin, durationMin, allowMaybe, excluded: [] };
  const all = Slots.generate({ ...cfg, excluded: [] });
  const allSet = new Set(all);
  cfg.excluded = [...new Set(excluded.filter((t) => allSet.has(t)))].sort((a, b) => a - b);
  const slots = Slots.generate(cfg);
  if (!slots.length) bad('The grid has no time slots');
  if (slots.length > LIMITS.slotsPerPoll) bad(`Too many time slots (${slots.length}, max ${LIMITS.slotsPerPoll}). Use a larger step or fewer dates.`);
  return cfg;
}

function validateSlots(raw, cfg) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) bad('slots must be an object');
  const valid = new Set(Slots.generate(cfg));
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const t = Number(k);
    if (!valid.has(t)) continue;
    const level = v === 2 ? 2 : v === 1 ? 1 : 0;
    if (level === 0) continue;
    out[t] = cfg.allowMaybe ? level : 1;
  }
  return out;
}

// A scheduled time: a contiguous range of the poll's own slots.
function validateFinal(f, cfg) {
  if (f === null) return null;
  if (!f || typeof f !== 'object') bad('final must be an object or null');
  const start = Number(f.start), end = Number(f.end);
  const ms = cfg.slotMin * 60000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || (end - start) % ms !== 0) bad('Invalid final time range');
  const valid = new Set(Slots.generate(cfg));
  for (let t = start; t < end; t += ms) if (!valid.has(t)) bad('Final time must be made of slots in this poll');
  return { start, end };
}

const ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

// ---------- request handling ----------
/*
 * req: { method, path (e.g. '/api/polls/abc'), header(name) -> string|undefined, json() -> Promise<any> }
 * store: async adapter, see server.js / worker.js
 * env: { googleClientId, newPollId? (id to use for a new poll, chosen by the caller) }
 */
async function handle(req, store, env) {
  const parts = req.path.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  const adminHeader = req.header('x-admin-key');

  if (parts.length === 2 && parts[1] === 'config' && method === 'GET') return ok({ googleClientId: env.googleClientId || '', limits: LIMITS });
  if (parts[1] !== 'polls') throw new HttpError(404, 'Not found');

  if (parts.length === 2 && method === 'POST') {
    const cfg = validateConfig(await req.json());
    const id = env.newPollId || randomToken(8), adminKey = randomToken(24);
    await store.insertPoll({ id, adminKey, config: cfg, createdAt: Date.now() });
    return { status: 201, body: { id, adminKey } };
  }

  const id = parts[2] || '';
  if (!ID_RE.test(id)) throw new HttpError(404, 'Poll not found');
  const poll = await store.getPoll(id);
  if (!poll) throw new HttpError(404, 'Poll not found');
  const isAdmin = safeEqual(adminHeader, poll.adminKey);
  const requireAdmin = () => { if (!isAdmin) throw new HttpError(403, 'Admin key required'); };

  if (parts.length === 3) {
    if (method === 'GET') {
      const responses = (await store.listResponses(id)).map((r) => ({ id: r.id, name: r.name, slots: r.slots, updatedAt: r.updatedAt, locked: !!r.passHash }));
      return ok({ id, config: poll.config, createdAt: poll.createdAt, responses, isAdmin });
    }
    if (method === 'PATCH') {
      requireAdmin();
      const body = await req.json();
      const cfg = { ...poll.config };
      if (body.title !== undefined) cfg.title = cleanText(body.title, LIMITS.title, 'Title', true);
      if (body.description !== undefined) cfg.description = cleanText(body.description, LIMITS.description, 'Description', false);
      if (body.closed !== undefined) cfg.closed = !!body.closed;
      if (body.final !== undefined) cfg.final = validateFinal(body.final, cfg);
      await store.updatePollConfig(id, cfg);
      return ok({ ok: true });
    }
    if (method === 'DELETE') { requireAdmin(); await store.deletePoll(id); return ok({ ok: true }); }
    throw new HttpError(405, 'Method not allowed');
  }

  // Sign in with a name (and optional password). Creates the response if the name is new.
  if (parts.length === 4 && parts[3] === 'login' && method === 'POST') {
    const body = await req.json();
    const name = cleanText(body.name, LIMITS.name, 'Name', true);
    const password = cleanText(body.password, LIMITS.password, 'Password', false);
    const existing = await store.findByName(id, name);
    if (existing) {
      if (existing.passHash) {
        if (!password) throw new HttpError(401, `"${existing.name}" is protected by a password. Enter it to continue.`, { needsPassword: true });
        if (!(await verifyPassword(password, existing.passHash))) throw new HttpError(403, 'Wrong password for that name.', { needsPassword: true });
      } else if (password) {
        // First time a password is given for an open name: set it.
        await store.setPassword(existing.id, await hashPassword(password));
      }
      return ok({ id: existing.id, editKey: existing.editKey, name: existing.name, slots: existing.slots, locked: !!(existing.passHash || password), isNew: false });
    }
    if (poll.config.closed) throw new HttpError(403, 'This poll is closed');
    if ((await store.countResponses(id)) >= LIMITS.responses) throw new HttpError(403, 'This poll has reached the maximum number of responses');
    const rid = randomToken(8), editKey = randomToken(18), now = Date.now();
    const passHash = password ? await hashPassword(password) : null;
    await store.insertResponse({ id: rid, pollId: id, name, editKey, passHash, slots: {}, createdAt: now, updatedAt: now });
    return { status: 201, body: { id: rid, editKey, name, slots: {}, locked: !!password, isNew: true } };
  }

  if (parts[3] !== 'responses') throw new HttpError(404, 'Not found');

  // Legacy direct submit (no sign-in): creates a response with slots in one call.
  if (parts.length === 4 && method === 'POST') {
    if (poll.config.closed) throw new HttpError(403, 'This poll is closed');
    const body = await req.json();
    const name = cleanText(body.name, LIMITS.name, 'Name', true);
    const slots = validateSlots(body.slots, poll.config);
    if (await store.findByName(id, name)) throw new HttpError(409, 'Someone already answered with that name. Sign in with that name to edit it, or pick a different name.');
    if ((await store.countResponses(id)) >= LIMITS.responses) throw new HttpError(403, 'This poll has reached the maximum number of responses');
    const rid = randomToken(8), editKey = randomToken(18), now = Date.now();
    await store.insertResponse({ id: rid, pollId: id, name, editKey, passHash: null, slots, createdAt: now, updatedAt: now });
    return { status: 201, body: { id: rid, editKey } };
  }

  if (parts.length === 5) {
    const resp = await store.getResponse(id, parts[4]);
    if (!resp) throw new HttpError(404, 'Response not found');
    const isOwner = safeEqual(req.header('x-edit-key'), resp.editKey);
    if (!isOwner && !isAdmin) throw new HttpError(403, 'Sign in with this name to edit it');
    if (method === 'PUT') {
      if (poll.config.closed && !isAdmin) throw new HttpError(403, 'This poll is closed');
      const body = await req.json();
      const name = body.name === undefined ? resp.name : cleanText(body.name, LIMITS.name, 'Name', true);
      const dup = await store.findByName(id, name);
      if (dup && dup.id !== resp.id) throw new HttpError(409, 'Someone else already uses that name');
      const slots = validateSlots(body.slots, poll.config);
      await store.updateResponse(resp.id, { name, slots, updatedAt: Date.now() });
      return ok({ ok: true });
    }
    if (method === 'DELETE') { await store.deleteResponse(id, resp.id); return ok({ ok: true }); }
    throw new HttpError(405, 'Method not allowed');
  }
  throw new HttpError(404, 'Not found');
}
const ok = (body) => ({ status: 200, body });

function errorResponse(e) {
  if (e instanceof HttpError) return { status: e.status, body: { error: e.message, ...(e.extra || {}) } };
  console.error(e);
  return { status: 500, body: { error: 'Internal server error' } };
}

// Shared browser-facing headers. The CSP is what makes the privacy promise checkable:
// the page can only talk to this origin, Google sign-in, and the free/busy endpoint.
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

// Same-origin + JSON checks for write requests (CSRF protection without cookies).
function checkWrite(method, headers) {
  if (['GET', 'HEAD'].includes(method)) return;
  const origin = headers('origin'), host = headers('host');
  if (origin && host) { try { if (new URL(origin).host !== host) throw new HttpError(403, 'Cross-origin requests are not allowed'); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(403, 'Bad origin'); } }
  const ct = headers('content-type') || '';
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
}

const configScript = (googleClientId) => `window.TA_CONFIG = ${JSON.stringify({ static: false, googleClientId: googleClientId || '' })};\n`;

module.exports = { handle, errorResponse, checkWrite, HttpError, LIMITS, SECURITY_HEADERS, configScript, validateConfig, validateSlots, validateFinal, randomToken, safeEqual };
