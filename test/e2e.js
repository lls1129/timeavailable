/*
 * End-to-end browser test against a running deployment (server or Worker mode).
 *   npm install -D playwright && npx playwright install chromium
 *   BASE=https://your-deployment.example node test/e2e.js
 * Creates a poll named "Workshop", signs in as Ada/Bob, edits, sets a password, schedules a final time.
 */
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:3000';
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/Los_Angeles', ...opts });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/40[139]|Conflict/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror ' + e.message));
    page.on('dialog', (d) => d.accept());
    return page;
  };
  const drag = async (page, from, to) => { await from.scrollIntoViewIfNeeded(); await to.scrollIntoViewIfNeeded(); await from.scrollIntoViewIfNeeded(); const a = await from.boundingBox(), b = await to.boundingBox(); await page.mouse.move(a.x + 5, a.y + 5); await page.mouse.down(); await page.mouse.move(b.x + 5, b.y + 5, { steps: 8 }); await page.mouse.up(); };
  const host = await mk();
  await host.goto(BASE + '/');
  await host.fill('#title', 'Workshop'); await host.click('[data-quick="7"]');
  await host.selectOption('#duration', '180'); await host.selectOption('#slot', '30');
  await host.fill('#start', '09:00'); await host.fill('#end', '17:00'); await host.dispatchEvent('#end', 'change');
  console.log('preview:', await host.textContent('#preview-info'));
  await host.selectOption('#duration', '45');
  console.log('mismatch warn:', (await host.textContent('#preview-info')).includes('multiple'));
  await host.selectOption('#duration', '180');
  await host.click('#submit'); await host.waitForSelector('#done:not(.hidden)');
  const share = await host.inputValue('#share-link'), admin = await host.inputValue('#admin-link');

  // Ada signs in, selects, saves
  const p1 = await mk(); await p1.goto(share); await p1.waitForSelector('#app:not(.hidden)');
  console.log('signin visible:', await p1.isVisible('#signin'), 'editor hidden:', await p1.isHidden('#editor'), 'meta:', await p1.textContent('#meta'));
  await p1.fill('#login-name', 'Ada'); await p1.click('#login-go'); await p1.waitForSelector('#editor:not(.hidden)');
  console.log('whoami:', await p1.textContent('#whoami-name'));
  const cells = await p1.$$('#mine-grid .cell[data-t]'); const cols = (await p1.$$('#mine-grid .col-h')).length;
  await drag(p1, cells[2 * cols], cells[9 * cols + 2]);
  await p1.click('#save'); await p1.waitForFunction(() => /Saved/.test(document.querySelector('#mine-status').textContent));
  console.log('ada saved cells:', await p1.$$eval('#mine-grid .cell.l1', (n) => n.length), '(expect 24)');
  // Ada returns on another device: sign in with "ada"
  const p2 = await mk(); await p2.goto(share); await p2.waitForSelector('#app:not(.hidden)');
  await p2.fill('#login-name', 'ada'); await p2.click('#login-go'); await p2.waitForSelector('#editor:not(.hidden)');
  console.log('ada again loaded:', await p2.$$eval('#mine-grid .cell.l1', (n) => n.length), 'toast:', await p2.textContent('#toast'));
  const c2 = await p2.$$('#mine-grid .cell[data-t]'); const cols2 = (await p2.$$('#mine-grid .col-h')).length;
  await drag(p2, c2[2 * cols2], c2[3 * cols2]); // erase 2 cells
  await p2.click('#save'); await p2.waitForFunction(() => /Saved/.test(document.querySelector('#mine-status').textContent));
  await p1.reload(); await p1.waitForSelector('#editor:not(.hidden)');
  console.log('ada device1 after edit elsewhere:', await p1.$$eval('#mine-grid .cell.l1', (n) => n.length), '(expect 22)', 'responses:', await p1.$$eval('#people .person', (n) => n.length));
  // Bob with password; Cy tries Bob's name
  const p3 = await mk(); await p3.goto(share); await p3.waitForSelector('#app:not(.hidden)');
  await p3.fill('#login-name', 'Bob'); await p3.fill('#login-pass', 'pw'); await p3.click('#login-go'); await p3.waitForSelector('#editor:not(.hidden)');
  const c3 = await p3.$$('#mine-grid .cell[data-t]'); const cols3 = (await p3.$$('#mine-grid .col-h')).length;
  await drag(p3, c3[4 * cols3], c3[12 * cols3 + 1]); await p3.click('#save'); await p3.waitForFunction(() => /Saved/.test(document.querySelector('#mine-status').textContent));
  const p4 = await mk(); await p4.goto(share); await p4.waitForSelector('#app:not(.hidden)');
  await p4.fill('#login-name', 'bob'); await p4.click('#login-go'); await p4.waitForSelector('#login-error:not(.hidden)');
  console.log('bob without pw:', await p4.textContent('#login-error'));
  await p4.fill('#login-pass', 'wrong'); await p4.click('#login-go'); await p4.waitForFunction(() => /Wrong/.test(document.querySelector('#login-error').textContent));
  console.log('wrong pw:', await p4.textContent('#login-error'));
  // host: tap a slot to schedule a 3h meeting
  await host.goto(admin); await host.waitForSelector('#app:not(.hidden)');
  await host.click('#pick-final');
  console.log('pick hint:', await host.textContent('#group-hint'));
  const gc = await host.$$('#group-grid .cell[data-t]'); const gcols = (await host.$$('#group-grid .col-h')).length;
  await gc[5 * gcols + 1].scrollIntoViewIfNeeded(); await gc[5 * gcols + 1].click();
  console.log('confirm:', (await host.textContent('#confirm-text')).replace(/\s+/g, ' '));
  await host.click('#confirm-ok'); await host.waitForSelector('#final-banner:not(.hidden)');
  console.log('final:', await host.textContent('#final-when'), 'min-len default:', await host.$eval('#min-len', (s) => s.selectedOptions[0].textContent));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
