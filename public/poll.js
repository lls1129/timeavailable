(() => {
  const pollId = location.pathname.split('/').filter(Boolean)[1];
  const params = new URLSearchParams(location.search);
  const S = { poll: null, slots: [], viewTz: browserTz(), brush: 1, mine: new Map(), rid: null, editKey: null, adminKey: null, pinned: null, dirty: false, config: null, google: null };

  // Admin key: from URL (then remembered) or from local storage.
  if (params.get('admin')) { S.adminKey = params.get('admin'); }
  else { const a = store(`ta:admin:${pollId}`); if (a && a.adminKey) S.adminKey = a.adminKey; }
  const hdrs = () => (S.adminKey ? { 'X-Admin-Key': S.adminKey } : {});

  async function load(initial) {
    try {
      const poll = await api('GET', `/api/polls/${pollId}`, undefined, hdrs());
      S.poll = poll;
      S.slots = Slots.generate(poll.config);
      if (poll.isAdmin) store(`ta:admin:${pollId}`, { adminKey: S.adminKey, title: poll.config.title, createdAt: poll.createdAt });
      else if (S.adminKey) { S.adminKey = null; storeRemove(`ta:admin:${pollId}`); }
      if (initial) initOnce();
      renderAll();
    } catch (e) {
      if (initial) { $('#loading').innerHTML = `<h1>Poll not found</h1><p class="muted">${e.message}</p><a class="btn primary" href="/">Create a new poll</a>`; }
    }
  }

  const datesOnly = () => S.poll.config.slotMin >= 1440;
  const slotMs = () => S.poll.config.slotMin * 60000;

  function initOnce() {
    $('#loading').classList.add('hidden'); $('#app').classList.remove('hidden');
    document.title = `${S.poll.config.title} — timeavailable`;
    fillTzSelect($('#view-tz'), S.viewTz);
    $('#view-tz').addEventListener('change', () => { S.viewTz = $('#view-tz').value; renderAll(); });

    // restore own response / draft
    const saved = store(`ta:resp:${pollId}`);
    if (saved && S.poll.responses.some((r) => r.id === saved.rid)) {
      S.rid = saved.rid; S.editKey = saved.editKey;
      const r = S.poll.responses.find((x) => x.id === saved.rid);
      $('#name').value = r.name;
      S.mine = new Map(Object.entries(r.slots).map(([k, v]) => [Number(k), v]));
    } else {
      storeRemove(`ta:resp:${pollId}`);
      const draft = store(`ta:draft:${pollId}`);
      if (draft) { $('#name').value = draft.name || ''; S.mine = new Map(Object.entries(draft.slots || {}).map(([k, v]) => [Number(k), v])); }
    }

    $$('#brush button').forEach((b) => b.addEventListener('click', () => { S.brush = Number(b.dataset.level); $$('#brush button').forEach((x) => x.classList.toggle('active', x === b)); }));
    if (!S.poll.config.allowMaybe) $('#brush-maybe').classList.add('hidden');
    $('#clear-mine').addEventListener('click', () => { S.mine.clear(); markDirty(); renderMine(); });
    $('#save').addEventListener('click', save);
    $('#name').addEventListener('input', markDirty);
    $('#copy-link').addEventListener('click', () => copyText(`${location.origin}/p/${pollId}`));
    $('#toggle-closed').addEventListener('click', async () => {
      try { await api('PATCH', `/api/polls/${pollId}`, { closed: !S.poll.config.closed }, hdrs()); await load(false); toast(S.poll.config.closed ? 'Poll closed' : 'Poll reopened', 'ok'); }
      catch (e) { toast(e.message, 'error'); }
    });
    $('#delete-poll').addEventListener('click', async () => {
      if (!confirm('Delete this poll and all responses? This cannot be undone.')) return;
      try { await api('DELETE', `/api/polls/${pollId}`, undefined, hdrs()); storeRemove(`ta:admin:${pollId}`); storeRemove(`ta:resp:${pollId}`); location.href = '/'; }
      catch (e) { toast(e.message, 'error'); }
    });
    $('#min-people').addEventListener('change', renderBest);
    $('#count-maybe').addEventListener('change', renderBest);
    $('#min-len').addEventListener('change', renderBest);
    $('#google-more').addEventListener('click', () => $('#google-extra').classList.toggle('hidden'));

    // heat scale legend
    $('#heat-scale').replaceChildren(...[0.1, 0.3, 0.5, 0.7, 0.9].map((f) => { const i = el('i'); i.style.background = heatColor(f); return i; }));

    api('GET', '/api/config').then((c) => { if (c.googleClientId) setupGoogle(c.googleClientId); }).catch(() => {});
    window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
    setInterval(() => { if (document.visibilityState === 'visible') load(false); }, 30000);
  }

  function markDirty() {
    S.dirty = true;
    $('#mine-status').textContent = 'Unsaved changes';
    store(`ta:draft:${pollId}`, { name: $('#name').value, slots: Object.fromEntries(S.mine) });
  }

  function renderAll() {
    const cfg = S.poll.config;
    $('#title').textContent = cfg.title;
    $('#description').textContent = cfg.description || '';
    $('#description').classList.toggle('hidden', !cfg.description);
    const n = S.poll.responses.length;
    $('#meta').textContent = `${cfg.dates.length} date${cfg.dates.length === 1 ? '' : 's'} · ${datesOnly() ? 'whole days' : `${cfg.slotMin}-minute slots`} · ${n} response${n === 1 ? '' : 's'}`;
    $('#closed-badge').classList.toggle('hidden', !cfg.closed);
    $('#tz-note').textContent = S.viewTz === cfg.tz ? `This is the poll's timezone.` : `Poll was created in ${cfg.tz.replace(/_/g, ' ')}.`;
    $('#admin-bar').classList.toggle('hidden', !S.poll.isAdmin);
    $('#toggle-closed').textContent = cfg.closed ? 'Reopen poll' : 'Close poll';
    $('#closed-msg').classList.toggle('hidden', !cfg.closed);
    $('#editor').classList.toggle('hidden', !!cfg.closed && !S.poll.isAdmin);
    $('#count-badge').textContent = `${n} ${n === 1 ? 'person' : 'people'}`;
    renderMine(); renderGroup(); renderPeople(); renderBest();
  }

  // ---------- own grid ----------
  let mineCells = null;
  function renderMine() {
    const layout = layoutSlots(S.slots, S.viewTz, S.poll.config.slotMin);
    const { grid, cells } = renderGrid($('#mine-grid'), layout, { datesOnly: datesOnly(), slotMin: S.poll.config.slotMin });
    mineCells = cells;
    for (const [t, c] of cells) { const l = S.mine.get(t); if (l) c.classList.add('l' + l); }
    enablePainting(grid, cells, (t) => S.mine.get(t) || 0, (t, l) => { if (l) S.mine.set(t, l); else S.mine.delete(t); }, () => (S.poll.config.allowMaybe ? S.brush : 1), markDirty);
    if (!S.dirty) $('#mine-status').textContent = S.rid ? 'Submitted — you can edit and resubmit.' : '';
  }

  async function save() {
    const name = $('#name').value.trim();
    if (!name) { toast('Please enter your name', 'error'); $('#name').focus(); return; }
    const btn = $('#save'); btn.disabled = true;
    const body = { name, slots: Object.fromEntries(S.mine) };
    try {
      if (S.rid && S.editKey) {
        await api('PUT', `/api/polls/${pollId}/responses/${S.rid}`, body, { 'X-Edit-Key': S.editKey, ...hdrs() });
      } else {
        const r = await api('POST', `/api/polls/${pollId}/responses`, body);
        S.rid = r.id; S.editKey = r.editKey;
      }
      store(`ta:resp:${pollId}`, { rid: S.rid, editKey: S.editKey, name });
      storeRemove(`ta:draft:${pollId}`);
      S.dirty = false;
      toast('Saved! Your availability is in.', 'ok');
      await load(false);
    } catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; }
  }

  // ---------- group grid ----------
  function tally() {
    const N = S.poll.responses.length;
    const per = new Map(); // t -> { avail: [], maybe: [] }
    for (const t of S.slots) per.set(t, { avail: [], maybe: [] });
    for (const r of S.poll.responses) for (const [k, v] of Object.entries(r.slots)) {
      const e = per.get(Number(k)); if (!e) continue;
      (v === 2 ? e.maybe : e.avail).push(r.name);
    }
    return { N, per };
  }

  function renderGroup() {
    const { N, per } = tally();
    const layout = layoutSlots(S.slots, S.viewTz, S.poll.config.slotMin);
    const { grid, cells } = renderGrid($('#group-grid'), layout, { datesOnly: datesOnly(), slotMin: S.poll.config.slotMin, readonly: true });
    for (const [t, c] of cells) {
      const e = per.get(t);
      const frac = N ? (e.avail.length + 0.5 * e.maybe.length) / N : 0;
      c.style.background = heatColor(frac);
      if (S.pinned === t) c.classList.add('hl');
    }
    const show = (t) => {
      const e = per.get(t); if (!e) return;
      const { dayKey, minute } = Slots.localSlot(t, S.viewTz);
      const names = new Set(S.poll.responses.map((r) => r.name));
      const no = [...names].filter((x) => !e.avail.includes(x) && !e.maybe.includes(x));
      const when = datesOnly() ? fmtDay(dayKey, { long: true }) : `${fmtDay(dayKey, { long: true })}, ${fmtTime(minute)}–${fmtTime(minute + S.poll.config.slotMin)}`;
      $('#detail').replaceChildren(
        el('div', {}, el('b', {}, when), ' ', el('span', { class: 'muted' }, `${e.avail.length + e.maybe.length}/${N} free`)),
        el('div', { class: 'people' },
          e.avail.map((x) => el('span', { class: 'person avail' }, x)),
          e.maybe.map((x) => el('span', { class: 'person maybe' }, x, el('span', { class: 'muted small' }, ' if needed'))),
          no.map((x) => el('span', { class: 'person no' }, x))));
    };
    grid.addEventListener('pointerover', (e) => { const c = e.target.closest('.cell'); if (c && c.dataset.t && S.pinned == null) show(Number(c.dataset.t)); });
    grid.addEventListener('click', (e) => {
      const c = e.target.closest('.cell'); if (!c || !c.dataset.t) return;
      const t = Number(c.dataset.t);
      S.pinned = S.pinned === t ? null : t;
      for (const [tt, cc] of cells) cc.classList.toggle('hl', tt === S.pinned);
      show(t);
    });
    if (S.pinned != null) show(S.pinned);
    S._groupCells = cells;
  }

  function renderPeople() {
    const box = $('#people');
    if (!S.poll.responses.length) { box.replaceChildren(el('span', { class: 'muted small' }, 'No responses yet. Be the first!')); return; }
    box.replaceChildren(...S.poll.responses.map((r) => el('span', { class: 'person' + (r.id === S.rid ? ' avail' : '') }, r.name,
      S.poll.isAdmin ? el('button', { class: 'rm', title: 'Remove this response', onclick: async () => {
        if (!confirm(`Remove ${r.name}'s response?`)) return;
        try { await api('DELETE', `/api/polls/${pollId}/responses/${r.id}`, undefined, hdrs()); if (r.id === S.rid) { S.rid = null; S.editKey = null; storeRemove(`ta:resp:${pollId}`); } await load(false); }
        catch (e) { toast(e.message, 'error'); }
      } }, '×') : null)));
  }

  // ---------- best times ----------
  function renderBest() {
    const { N, per } = tally();
    const sel = $('#min-people');
    const prev = Number(sel.value);
    sel.replaceChildren(...Array.from({ length: Math.max(N, 1) }, (_, i) => el('option', { value: i + 1 }, String(i + 1))));
    sel.value = prev && prev <= N ? String(prev) : String(Math.max(N, 1));
    const k = Number(sel.value);
    const countMaybe = $('#count-maybe').checked;
    const lenSel = $('#min-len');
    $('#min-len-wrap').classList.toggle('hidden', datesOnly());
    if (!lenSel.options.length) {
      const sm = S.poll.config.slotMin;
      const opts = [sm, sm * 2, sm * 3, sm * 4, sm * 6, sm * 8].filter((v, i, a) => a.indexOf(v) === i && v <= 1440);
      lenSel.replaceChildren(...opts.map((m) => el('option', { value: m }, m >= 60 ? `${+(m / 60).toFixed(2)} h` : `${m} min`)));
    }
    const minLen = datesOnly() ? 1440 : Number(lenSel.value);
    const list = $('#best');
    if (!N) { list.replaceChildren(el('li', { class: 'muted small' }, 'Waiting for responses.')); return; }
    const count = (t) => { const e = per.get(t); return e.avail.length + (countMaybe ? e.maybe.length : 0); };
    // consecutive runs of qualifying slots
    const runs = [];
    let cur = null;
    for (const t of S.slots) {
      const ok = count(t) >= k;
      if (ok && cur && t === cur.end) { cur.end = t + slotMs(); cur.min = Math.min(cur.min, count(t)); cur.sum += count(t); cur.n++; }
      else if (ok) { cur = { start: t, end: t + slotMs(), min: count(t), sum: count(t), n: 1 }; runs.push(cur); }
      else cur = null;
    }
    const good = runs.filter((r) => r.end - r.start >= minLen * 60000);
    good.sort((a, b) => (b.min - a.min) || ((b.end - b.start) - (a.end - a.start)) || (a.start - b.start));
    if (!good.length) { list.replaceChildren(el('li', { class: 'muted small' }, 'No slot matches yet. Lower the number of people or the minimum length.')); return; }
    list.replaceChildren(...good.slice(0, 12).map((r) => {
      const a = Slots.localSlot(r.start, S.viewTz), b = Slots.localSlot(r.end - 1, S.viewTz);
      const endMin = Slots.localSlot(r.end, S.viewTz);
      const sameDay = a.dayKey === endMin.dayKey || (endMin.minute === 0 && b.dayKey === a.dayKey);
      let label;
      if (datesOnly()) label = r.n > 1 ? `${fmtDay(a.dayKey)} – ${fmtDay(b.dayKey)} (${r.n} days)` : fmtDay(a.dayKey, { long: true });
      else label = `${fmtDay(a.dayKey)}, ${fmtTime(a.minute)}–${fmtTime(endMin.minute === 0 && sameDay ? 1440 : endMin.minute)}${sameDay ? '' : ' (' + fmtDay(endMin.dayKey) + ')'}`;
      return el('li', { onclick: () => highlightRun(r) }, el('span', {}, label), el('span', { class: 'cnt' }, `${r.min}/${N}`));
    }));
  }
  function highlightRun(r) {
    for (const [t, c] of S._groupCells) c.classList.toggle('best', t >= r.start && t < r.end);
  }

  // ---------- Google Calendar (browser-only) ----------
  const SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
  function setupGoogle(clientId) {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
    s.onload = () => {
      try {
        S.google = google.accounts.oauth2.initTokenClient({
          client_id: clientId, scope: SCOPE, prompt: '',
          callback: onToken,
          error_callback: (e) => { if (e && e.type !== 'popup_closed') toast('Google sign-in failed: ' + (e.message || e.type), 'error'); busyBtn(false); },
        });
        $('#google-box').classList.remove('hidden');
        $('#google-import').addEventListener('click', () => { busyBtn(true); S.google.requestAccessToken(); });
      } catch (e) { console.warn('Google init failed', e); }
    };
    document.head.append(s);
  }
  function busyBtn(b) { const btn = $('#google-import'); btn.disabled = b; }

  async function onToken(resp) {
    if (!resp || resp.error || !resp.access_token) { toast('Google did not grant access.', 'error'); busyBtn(false); return; }
    const token = resp.access_token;
    try {
      const busy = await fetchBusy(token);
      applyBusy(busy);
    } catch (e) {
      toast('Could not read free/busy from Google: ' + e.message, 'error');
    } finally {
      busyBtn(false);
      // Drop the grant right away: we only needed it once.
      try { google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignore */ }
    }
  }

  async function fetchBusy(token) {
    const ids = [{ id: 'primary' }, ...$('#extra-cals').value.split(',').map((x) => x.trim()).filter(Boolean).map((id) => ({ id }))];
    const first = S.slots[0], last = S.slots[S.slots.length - 1] + slotMs();
    const CHUNK = 42 * 86400000; // keep each query comfortably sized
    const busy = [];
    for (let from = first; from < last; from += CHUNK) {
      const to = Math.min(from + CHUNK, last);
      const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: ids }),
      });
      if (!res.ok) { let msg = `HTTP ${res.status}`; try { msg = (await res.json()).error.message; } catch { /* ignore */ } throw new Error(msg); }
      const data = await res.json();
      for (const [id, cal] of Object.entries(data.calendars || {})) {
        if (cal.errors && cal.errors.length) toast(`Calendar ${id}: ${cal.errors[0].reason}`, 'error');
        for (const b of cal.busy || []) busy.push([Date.parse(b.start), Date.parse(b.end)]);
      }
    }
    return busy;
  }

  function applyBusy(busy) {
    const ms = slotMs();
    let free = 0;
    for (const t of S.slots) {
      const isBusy = busy.some(([s, e]) => s < t + ms && e > t);
      if (isBusy) S.mine.delete(t);
      else { free++; if (!S.mine.has(t)) S.mine.set(t, 1); }
    }
    markDirty(); renderMine();
    toast(`Marked ${free} of ${S.slots.length} slots as free from your calendar. Adjust anything, then submit.`, 'ok');
  }

  load(true);
})();
