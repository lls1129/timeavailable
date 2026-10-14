'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-test-'));
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
const { server, db } = require('../server.js');
const Slots = require('../public/slots.js');

let base;
test.before(async () => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); db.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

const call = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
};

const cfg = { title: 'Kickoff', description: 'hi', tz: 'America/New_York', dates: ['2026-11-01', '2026-10-31'], startMin: 540, endMin: 720, slotMin: 30 };

test('timezone math handles DST (America/New_York, Nov 1 2026 fall back)', () => {
  // 2026-11-01 09:00 EST == 14:00 UTC (DST ends 2026-11-01 02:00); 2026-10-31 09:00 EDT == 13:00 UTC
  assert.strictEqual(Slots.zonedToUtc('2026-11-01', 540, 'America/New_York'), Date.UTC(2026, 10, 1, 14, 0));
  assert.strictEqual(Slots.zonedToUtc('2026-10-31', 540, 'America/New_York'), Date.UTC(2026, 9, 31, 13, 0));
  const ls = Slots.localSlot(Date.UTC(2026, 10, 1, 14, 0), 'America/New_York');
  assert.deepStrictEqual([ls.dayKey, ls.minute], ['2026-11-01', 540]);
  assert.strictEqual(Slots.generate(cfg).length, 12);
});

test('static pages and security headers', async () => {
  const home = await call('GET', '/');
  assert.strictEqual(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client/);
  const poll = await call('GET', '/p/abc123');
  assert.strictEqual(poll.status, 200);
  assert.match(poll.text, /Your availability/);
  const missing = await call('GET', '/nope');
  assert.strictEqual(missing.status, 404);
  const traversal = await fetch(base + '/..%2fserver.js');
  assert.notStrictEqual(traversal.status, 200);
  const conf = await call('GET', '/api/config');
  assert.strictEqual(conf.json.googleClientId, 'test-client-id');
});

test('full poll lifecycle', async () => {
  const bad = await call('POST', '/api/polls', { ...cfg, dates: [] });
  assert.strictEqual(bad.status, 400);
  const badTz = await call('POST', '/api/polls', { ...cfg, tz: 'Mars/Olympus' });
  assert.strictEqual(badTz.status, 400);

  const created = await call('POST', '/api/polls', { ...cfg, excluded: [Slots.zonedToUtc('2026-10-31', 540, cfg.tz), 12345] });
  assert.strictEqual(created.status, 201);
  const { id, adminKey } = created.json;

  const got = await call('GET', `/api/polls/${id}`);
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.json.isAdmin, false);
  assert.deepStrictEqual(got.json.config.dates, ['2026-10-31', '2026-11-01']);
  assert.strictEqual(got.json.config.excluded.length, 1, 'unknown excluded slots are dropped');
  assert.strictEqual(Slots.generate(got.json.config).length, 11);
  assert.ok(!('adminKey' in got.json));

  const asAdmin = await call('GET', `/api/polls/${id}`, undefined, { 'X-Admin-Key': adminKey });
  assert.strictEqual(asAdmin.json.isAdmin, true);

  const slots = Slots.generate(got.json.config);
  const mine = { [slots[1]]: 1, [slots[2]]: 2, [slots[3]]: 7, '999': 1 };
  const r1 = await call('POST', `/api/polls/${id}/responses`, { name: 'Ada', slots: mine });
  assert.strictEqual(r1.status, 201);
  const dup = await call('POST', `/api/polls/${id}/responses`, { name: 'ada', slots: {} });
  assert.strictEqual(dup.status, 409);

  let state = (await call('GET', `/api/polls/${id}`)).json;
  assert.strictEqual(state.responses.length, 1);
  assert.deepStrictEqual(state.responses[0].slots, { [slots[1]]: 1, [slots[2]]: 2 }, 'invalid levels and unknown slots dropped');
  assert.ok(!('editKey' in state.responses[0]));

  const noKey = await call('PUT', `/api/polls/${id}/responses/${r1.json.id}`, { name: 'Ada L', slots: {} });
  assert.strictEqual(noKey.status, 403);
  const upd = await call('PUT', `/api/polls/${id}/responses/${r1.json.id}`, { name: 'Ada L', slots: { [slots[0]]: 1 } }, { 'X-Edit-Key': r1.json.editKey });
  assert.strictEqual(upd.status, 200);
  state = (await call('GET', `/api/polls/${id}`)).json;
  assert.strictEqual(state.responses[0].name, 'Ada L');

  const closeNoAdmin = await call('PATCH', `/api/polls/${id}`, { closed: true });
  assert.strictEqual(closeNoAdmin.status, 403);
  await call('PATCH', `/api/polls/${id}`, { closed: true }, { 'X-Admin-Key': adminKey });
  const whileClosed = await call('POST', `/api/polls/${id}/responses`, { name: 'Bob', slots: {} });
  assert.strictEqual(whileClosed.status, 403);
  await call('PATCH', `/api/polls/${id}`, { closed: false }, { 'X-Admin-Key': adminKey });

  const r2 = await call('POST', `/api/polls/${id}/responses`, { name: 'Bob', slots: {} });
  assert.strictEqual(r2.status, 201);
  const delNoAuth = await call('DELETE', `/api/polls/${id}/responses/${r2.json.id}`);
  assert.strictEqual(delNoAuth.status, 403);
  const delAdmin = await call('DELETE', `/api/polls/${id}/responses/${r2.json.id}`, undefined, { 'X-Admin-Key': adminKey });
  assert.strictEqual(delAdmin.status, 200);

  const crossOrigin = await fetch(base + '/api/polls', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify(cfg) });
  assert.strictEqual(crossOrigin.status, 403);

  const delPoll = await call('DELETE', `/api/polls/${id}`, undefined, { 'X-Admin-Key': adminKey });
  assert.strictEqual(delPoll.status, 200);
  assert.strictEqual((await call('GET', `/api/polls/${id}`)).status, 404);
});
