(() => {
  // Two storage modes share this page:
  //  - server mode: /p/<id>, data lives in the server's database
  //  - static mode: poll.html#<blob>, the poll and every answer live inside the link itself
  const STATIC = STATIC_MODE;
  let pollId = STATIC ? null : location.pathname.split('/').filter(Boolean)[1];
  const params = new URLSearchParams(location.search);
  const S = {
    poll: null, slots: [], layout: null, viewTz: browserTz(), brush: 1, mine: new Map(), rid: null, editKey: null, adminKey: null,
    pinned: null, dirty: false, google: null, busy: [], filter: null, page: 0, perPage: 7, pick: false, pending: null, isHost: false, tab: 'mine',
  };

  if (!STATIC) {
    if (params.get('admin')) { S.adminKey = params.get('admin'); }
    else { const a = store(`ta:admin:${pollId}`); if (a && a.adminKey) S.adminKey = a.adminKey; }
  }
  const hdrs = () => (S.adminKey ? { 'X-Admin-Key': S.adminKey } : {});
  const datesOnly = () => S.poll.config.slotMin >= 1440;
  const slotMs = () => S.poll.config.slotMin * 60000;
  const durationMin = () => S.poll.config.durationMin || S.poll.config.slotMin;
  const cfgKey = (cfg) => JSON.stringify({ ...cfg, final: undefined, closed: undefined });

  // ---- static-mode (de)serialisation ----
  const slotsToBits = (slots, list) => list.map((t) => slots[t] || 0).join('').replace(/0+$/, '');
  const bitsToSlots = (bits, list) => { const o = {}; for (let i = 0; i < bits.length && i < list.length; i++) { const v = Number(bits[i]); if (v) o[list[i]] = v; } return o; };
  async function readStatic(blob) {
    const st = await decodeState(blob);
    if (!st || !st.c || !Array.isArray(st.c.dates)) throw new Error('This link does not contain a poll.');
    const config = st.c;
    if (!Slots.isValidTz(config.tz)) throw new Error('Invalid timezone in link');
    const slots = Slots.generate(config);
    const responses = (st.r || []).map(([name, bits, updatedAt], i) => ({ id: 'r' + i, name: String(name), slots: bitsToSlots(String(bits || ''), slots), updatedAt: Number(updatedAt) || 0 }));
    return { config, slots, responses };
  }
  async function writeStatic() {
    const r = S.poll.responses.map((x) => [x.name, slotsToBits(x.slots, S.slots), x.updatedAt]);
    const blob = await encodeState({ c: S.poll.config, r });
    history.replaceState(null, '', location.pathname + location.search + '#' + blob);
    $('#static-link').value = location.href;
    return location.href;
  }

  async function load(initial) {
    try {
      if (STATIC) {
        const { config, slots, responses } = await readStatic(location.hash.slice(1));
        pollId = hashId(cfgKey(config));
        S.poll = { id: pollId, config, responses, isAdmin: false, createdAt: 0 };
        S.slots = slots;
        const saved = store(`ta:resp:${pollId}`);
        const mineResp = saved && responses.find((x) => x.name.toLowerCase() === String(saved.name || '').toLowerCase());
        S.rid = mineResp ? mineResp.id : null;
        S.isHost = !!store(`ta:host:${pollId}`);
      } else {
        const poll = await api('GET', `/api/polls/${pollId}`, undefined, hdrs());
        S.poll = poll;
        S.slots = Slots.generate(poll.config);
        S.isHost = !!poll.isAdmin;
        if (poll.isAdmin) store(`ta:admin:${pollId}`, { adminKey: S.adminKey, title: poll.config.title, createdAt: poll.createdAt });
        else if (S.adminKey) { S.adminKey = null; storeRemove(`ta:admin:${pollId}`); }
      }
      if (initial) initOnce();
      renderAll();
      if (initial) showTab(S.tab);
    } catch (e) {
      if (initial) { $('#loading').innerHTML = `<h1>Poll not found</h1><p class="muted">${String(e.message).replace(/</g, '&lt;')}</p><a class="btn primary" href="./">Create a new poll</a>`; }
      else toast(e.message, 'error');
    }
  }

  function initOnce() {
    $('#loading').classList.add('hidden'); $('#app').classList.remove('hidden');
    document.title = `${S.poll.config.title} — timeavailable`;
    fillTzSelect($('#view-tz'), S.viewTz);
    $('#view-tz').addEventListener('change', () => { S.viewTz = $('#view-tz').value; S.page = 0; renderAll(); });

    // restore own response / draft
    const saved = store(`ta:resp:${pollId}`);
    const mineResp = saved && (STATIC ? S.poll.responses.find((x) => x.id === S.rid) : S.poll.responses.find((r) => r.id === saved.rid));
    if (mineResp) {
      if (!STATIC) { S.rid = saved.rid; S.editKey = saved.editKey; }
      $('#name').value = mineResp.name;
      S.mine = new Map(Object.entries(mineResp.slots).map(([k, v]) => [Number(k), v]));
      const draft = store(`ta:draft:${pollId}`);
      if (draft && draft.rid === S.rid && draft.slots) S.mine = new Map(Object.entries(draft.slots).map(([k, v]) => [Number(k), v]));
    } else {
      if (!STATIC) storeRemove(`ta:resp:${pollId}`);
      const draft = store(`ta:draft:${pollId}`);
      if (STATIC && draft) { $('#name').value = draft.name || ''; S.mine = new Map(Object.entries(draft.slots || {}).map(([k, v]) => [Number(k), v])); }
      else if (STATIC && saved && saved.name) $('#name').value = saved.name;
      if (!STATIC && saved && saved.name) $('#login-name').value = saved.name;
    }
    $('#name-field').classList.toggle('hidden', !STATIC);
    $('#login-go').addEventListener('click', login);
    $('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
    $('#login-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
    $('#switch-user').addEventListener('click', () => { S.rid = null; S.editKey = null; S.mine = new Map(); S.dirty = false; storeRemove(`ta:resp:${pollId}`); storeRemove(`ta:draft:${pollId}`); $('#login-pass').value = ''; renderAll(); });

    $$('#brush button').forEach((b) => b.addEventListener('click', () => { S.brush = Number(b.dataset.level); $$('#brush button').forEach((x) => x.classList.toggle('active', x === b)); }));
    if (!S.poll.config.allowMaybe) { $('#brush-maybe').classList.add('hidden'); $('#legend-maybe').classList.add('hidden'); }
    $('#clear-mine').addEventListener('click', () => { S.mine.clear(); markDirty(); renderMine(); });
    $('#select-all').addEventListener('click', () => { const lvl = S.poll.config.allowMaybe ? S.brush : 1; for (const t of S.slots) if (!isBusy(t)) S.mine.set(t, lvl); markDirty(); renderMine(); });
    $('#save').addEventListener('click', save);
    $('#name').addEventListener('input', markDirty);
    $('#copy-link').addEventListener('click', () => copyText(`${location.origin}/p/${pollId}`));
    $('#toggle-closed').addEventListener('click', async () => {
      try { await api('PATCH', `/api/polls/${pollId}`, { closed: !S.poll.config.closed }, hdrs()); await load(false); toast(S.poll.config.closed ? 'Poll closed' : 'Poll reopened', 'ok'); }
      catch (e) { toast(e.message, 'error'); }
    });
    $('#delete-poll').addEventListener('click', async () => {
      if (!confirm('Delete this poll and all responses? This cannot be undone.')) return;
      try { await api('DELETE', `/api/polls/${pollId}`, undefined, hdrs()); storeRemove(`ta:admin:${pollId}`); storeRemove(`ta:resp:${pollId}`); location.href = './'; }
      catch (e) { toast(e.message, 'error'); }
    });
    $('#host-link').addEventListener('click', (e) => { e.preventDefault(); S.isHost = !S.isHost; store(`ta:host:${pollId}`, S.isHost); renderAll(); });
    $('#min-people').addEventListener('change', renderBest);
    $('#count-maybe').addEventListener('change', renderBest);
    $('#min-len').addEventListener('change', renderBest);
    $('#google-more').addEventListener('click', () => $('#google-extra').classList.toggle('hidden'));
    $('#static-copy').addEventListener('click', () => copyText($('#static-link').value));
    $('#static-sharebtn').addEventListener('click', () => shareOrCopy($('#static-link').value, S.poll.config.title));
    $('#combine-box').classList.toggle('hidden', !STATIC);
    $('#combine-toggle').addEventListener('click', () => $('#combine').classList.toggle('hidden'));
    $('#combine-go').addEventListener('click', combineLinks);
    $('#pick-final').addEventListener('click', () => setPick(!S.pick));
    $('#final-change').addEventListener('click', () => { setPick(true); showTab('group'); $('#group-grid').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    $('#final-clear').addEventListener('click', () => { if (confirm('Remove the scheduled time?')) saveFinal(null); });
    $('#confirm-cancel').addEventListener('click', () => { S.pending = null; setPick(false); });
    $('#confirm-ok').addEventListener('click', () => { if (S.pending) saveFinal(S.pending); });
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('#fab-save').addEventListener('click', save);
    // Floating save button while there are unsaved changes and the real button is off-screen.
    const saveBtn = $('#save');
    const fabCheck = () => { const r = saveBtn.getBoundingClientRect(); const off = r.bottom < 0 || r.top > innerHeight; $('#fab-save').classList.toggle('hidden', !(S.dirty && off && S.tab === 'mine' && !saveBtn.closest('.hidden'))); };
    window.addEventListener('scroll', fabCheck, { passive: true }); setInterval(fabCheck, 800);
    if (STATIC) $('#mine-hint').textContent += ' When you save, your answer is written into the link.';

    $('#heat-scale').replaceChildren(...[0.1, 0.3, 0.5, 0.7, 0.9].map((f) => { const i = el('i'); i.style.background = heatColor(f); return i; }));

    if (CFG.googleClientId) setupGoogle(CFG.googleClientId);
    window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (computePerPage()) { renderMine(); renderGroup(); } }, 120); });
    if (!STATIC) setInterval(() => { if (document.visibilityState === 'visible' && !S.pick) load(false); }, 30000);
    if (STATIC) window.addEventListener('hashchange', () => load(false));
  }

  async function login() {
    const name = $('#login-name').value.trim(), password = $('#login-pass').value;
    const err = $('#login-error'); err.classList.add('hidden');
    if (!name) { $('#login-name').focus(); return; }
    const btn = $('#login-go'); btn.disabled = true;
    try {
      const r = await api('POST', `/api/polls/${pollId}/login`, { name, password });
      S.rid = r.id; S.editKey = r.editKey;
      S.mine = new Map(Object.entries(r.slots || {}).map(([k, v]) => [Number(k), v]));
      S.dirty = false;
      store(`ta:resp:${pollId}`, { rid: r.id, editKey: r.editKey, name: r.name });
      storeRemove(`ta:draft:${pollId}`);
      $('#login-pass').value = '';
      await load(false);
      toast(r.isNew ? `Welcome, ${r.name}! Select when you're free, then save.` : `Welcome back, ${r.name}. Your saved availability is loaded.`, 'ok');
    } catch (e) {
      err.textContent = e.message; err.classList.remove('hidden');
      if (/password/i.test(e.message)) $('#login-pass').focus();
    } finally { btn.disabled = false; }
  }

  function showTab(tab) {
    S.tab = tab;
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#mine-card').classList.toggle('tab-hidden', tab !== 'mine');
    $('#group-card').classList.toggle('tab-hidden', tab !== 'group');
    if (computePerPage()) { renderMine(); renderGroup(); }
  }

  function computePerPage() {
    const w = Math.max($('#mine-grid').clientWidth, $('#group-grid').clientWidth) || 600;
    const n = daysThatFit(w, datesOnly());
    const changed = n !== S.perPage; S.perPage = n;
    return changed;
  }
  function nav(d) {
    const max = Math.max(0, S.layout.days.length - 1);
    S.page = Math.max(0, Math.min(max, S.page + d * S.perPage));
    renderMine(); renderGroup();
  }
  const pageOpts = () => ({ start: S.page, count: S.perPage });

  function markDirty() {
    S.dirty = true;
    $('#mine-status').textContent = 'Unsaved changes';
    $('#static-share').classList.add('hidden');
    store(`ta:draft:${pollId}`, { name: $('#name').value, rid: S.rid, slots: Object.fromEntries(S.mine) });
  }

  function renderAll() {
    const cfg = S.poll.config;
    S.layout = layoutSlots(S.slots, S.viewTz, cfg.slotMin);
    computePerPage();
    if (S.page > S.layout.days.length - 1) S.page = 0;
    $('#title').textContent = cfg.title;
    $('#description').textContent = cfg.description || '';
    $('#description').classList.toggle('hidden', !cfg.description);
    const n = S.poll.responses.length;
    const durLbl = (m) => (m % 60 === 0 ? `${m / 60} h` : m > 60 ? `${+(m / 60).toFixed(2)} h` : `${m} min`);
    $('#meta').textContent = `${cfg.dates.length} date${cfg.dates.length === 1 ? '' : 's'} · ${datesOnly() ? 'whole days' : `${durLbl(durationMin())} meeting, start every ${cfg.slotMin} min`} · ${n} response${n === 1 ? '' : 's'}`;
    $('#closed-badge').classList.toggle('hidden', !cfg.closed);
    $('#tz-note').textContent = S.viewTz === cfg.tz ? `This is the poll's timezone.` : `Poll was created in ${cfg.tz.replace(/_/g, ' ')}.`;
    $('#admin-bar').classList.toggle('hidden', !S.poll.isAdmin);
    $('#host-toggle').classList.toggle('hidden', !STATIC);
    $('#host-link').textContent = S.isHost ? 'Hide scheduling controls' : "I'm the host — show scheduling controls";
    $$('.host-only').forEach((x) => x.classList.toggle('hidden', !S.isHost));
    $('#toggle-closed').textContent = cfg.closed ? 'Reopen poll' : 'Close poll';
    $('#closed-msg').classList.toggle('hidden', !cfg.closed);
    const signedIn = STATIC || !!(S.rid && S.editKey);
    $('#signin').classList.toggle('hidden', signedIn || (!!cfg.closed && !S.poll.isAdmin));
    $('#editor').classList.toggle('hidden', !signedIn || (!!cfg.closed && !S.poll.isAdmin));
    $('#whoami').classList.toggle('hidden', STATIC || !signedIn);
    if (!STATIC && signedIn) { const me = S.poll.responses.find((r) => r.id === S.rid); $('#whoami-name').textContent = me ? me.name : ''; if (!me) { S.rid = null; S.editKey = null; storeRemove(`ta:resp:${pollId}`); } }
    $('#count-badge').textContent = `${n} ${n === 1 ? 'person' : 'people'}`;
    renderFinal(); renderMine(); renderGroup(); renderPeople(); renderBest();
  }

  // ---------- own grid ----------
  const isBusy = (t) => S.busy.some(([s, e]) => s < t + slotMs() && e > t);
  const setLevelClass = (c, lvl) => { c.classList.remove('l1', 'l2'); if (lvl) c.classList.add('l' + lvl); };
  function renderMine() {
    const { grid, cells } = renderGrid($('#mine-grid'), S.layout, { datesOnly: datesOnly(), page: pageOpts(), onNav: nav });
    for (const [t, c] of cells) { setLevelClass(c, S.mine.get(t) || 0); if (isBusy(t)) c.classList.add('busy'); }
    $('#legend-busy').classList.toggle('hidden', !S.busy.length);
    const editable = !S.poll.config.closed || S.poll.isAdmin;
    enableRectSelect(grid, cells, {
      onStart: (t) => { if (!editable) return null; const brush = S.poll.config.allowMaybe ? S.brush : 1; return (S.mine.get(t) || 0) === brush ? 0 : brush; },
      onPreview: (set, mode) => { for (const [t, c] of cells) { const inSet = set.has(t); setLevelClass(c, inSet ? mode : (S.mine.get(t) || 0)); c.classList.toggle('pv', inSet); c.classList.toggle('l0', inSet && mode === 0); } },
      onCommit: (set, mode) => {
        for (const t of set) { if (mode) S.mine.set(t, mode); else S.mine.delete(t); }
        for (const [t, c] of cells) { setLevelClass(c, S.mine.get(t) || 0); c.classList.remove('pv', 'l0'); }
        if (set.size) markDirty();
      },
    });
    if (!S.dirty) $('#mine-status').textContent = S.rid ? (STATIC ? 'Saved in this link — you can edit and save again.' : 'Saved — you can edit and save again.') : `${S.mine.size ? S.mine.size + ' slots selected. ' : ''}Not saved yet.`;
  }

  async function save() {
    const me = !STATIC && S.poll.responses.find((r) => r.id === S.rid);
    const name = STATIC ? $('#name').value.trim() : (me ? me.name : '');
    if (!name) { toast(STATIC ? 'Please enter your name' : 'Please sign in with your name first', 'error'); if (STATIC) $('#name').focus(); return; }
    const btn = $('#save'); btn.disabled = true;
    const slots = Object.fromEntries(S.mine);
    try {
      if (STATIC) {
        const existing = S.poll.responses.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (existing && existing.id !== S.rid && !confirm(`"${existing.name}" already answered. Replace their answer with yours?`)) { btn.disabled = false; return; }
        const rec = { id: existing ? existing.id : 'r' + S.poll.responses.length, name, slots, updatedAt: Date.now() };
        if (existing) Object.assign(existing, rec); else S.poll.responses.push(rec);
        await writeStatic();
        store(`ta:resp:${pollId}`, { name });
        storeRemove(`ta:draft:${pollId}`);
        S.dirty = false; $('#fab-save').classList.add('hidden');
        $('#static-share').classList.remove('hidden');
        $('#static-sharebtn').classList.toggle('hidden', !navigator.share);
        await load(false);
        $('#static-share').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        await api('PUT', `/api/polls/${pollId}/responses/${S.rid}`, { slots }, { 'X-Edit-Key': S.editKey, ...hdrs() });
        store(`ta:resp:${pollId}`, { rid: S.rid, editKey: S.editKey, name });
        storeRemove(`ta:draft:${pollId}`);
        S.dirty = false; $('#fab-save').classList.add('hidden');
        toast('Saved! Your availability is in.', 'ok');
        await load(false);
      }
    } catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; }
  }

  async function combineLinks() {
    const lines = $('#combine-input').value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
    let merged = 0, skipped = 0;
    const mine = cfgKey(S.poll.config);
    for (const line of lines) {
      const blob = blobFromLink(line); if (!blob) { skipped++; continue; }
      try {
        const { config, responses } = await readStatic(blob);
        if (cfgKey(config) !== mine) { skipped++; continue; }
        if (config.final && !S.poll.config.final) { S.poll.config.final = config.final; merged++; }
        for (const r of responses) {
          const ex = S.poll.responses.find((x) => x.name.toLowerCase() === r.name.toLowerCase());
          if (ex) { if (r.updatedAt > ex.updatedAt) { ex.slots = r.slots; ex.updatedAt = r.updatedAt; merged++; } }
          else { S.poll.responses.push({ ...r, id: 'r' + S.poll.responses.length }); merged++; }
        }
      } catch { skipped++; }
    }
    if (merged) { await writeStatic(); await load(false); $('#static-share').classList.remove('hidden'); }
    toast(`${merged} change${merged === 1 ? '' : 's'} merged${skipped ? `, ${skipped} link${skipped === 1 ? '' : 's'} skipped (not this poll)` : ''}.`, merged ? 'ok' : 'error');
    if (merged) $('#combine-input').value = '';
  }

  // ---------- group grid ----------
  function tally() {
    const N = S.poll.responses.length;
    const per = new Map();
    for (const t of S.slots) per.set(t, { avail: [], maybe: [] });
    for (const r of S.poll.responses) for (const [k, v] of Object.entries(r.slots)) {
      const e = per.get(Number(k)); if (!e) continue;
      (v === 2 ? e.maybe : e.avail).push(r.name);
    }
    return { N, per };
  }

  function renderGroup() {
    const { N, per } = tally();
    const fin = S.poll.config.final;
    const person = S.filter ? S.poll.responses.find((r) => r.name === S.filter) : null;
    const { grid, cells } = renderGrid($('#group-grid'), S.layout, {
      datesOnly: datesOnly(), page: pageOpts(), onNav: nav, readonly: true,
      cellContent: (t) => { if (person) return null; const e = per.get(t); const n = e.avail.length + e.maybe.length; return n ? n : null; },
    });
    grid.classList.toggle('pick', S.pick);
    for (const [t, c] of cells) {
      if (person) setLevelClass(c, person.slots[t] || 0);
      else { const e = per.get(t); const frac = N ? (e.avail.length + 0.5 * e.maybe.length) / N : 0; c.style.background = heatColor(frac); }
      if (fin && t >= fin.start && t < fin.end) c.classList.add('final');
      if (S.pinned === t) c.classList.add('hl');
      if (S.pending && t >= S.pending.start && t < S.pending.end) c.classList.add('fin');
    }
    $('#group-hint').textContent = S.pick ? `Tap a start time to schedule a ${durationMin() >= 60 ? +(durationMin() / 60).toFixed(2) + '-hour' : durationMin() + '-minute'} meeting there, or drag down a column for a custom length, then confirm below.` : person ? `Showing ${person.name}'s availability. Tap the name again to go back to the group view.` : 'Numbers show how many people are free. Tap a slot to see who; tap a name below to see one person\'s availability.';
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
    if (S.pick) {
      enableRectSelect(grid, cells, {
        sameColumn: true,
        onStart: () => 'pick',
        onPreview: (set) => { for (const [t, c] of cells) c.classList.toggle('fin', set.has(t)); },
        onCommit: (set) => {
          const sorted = [...set].sort((a, b) => a - b);
          if (!sorted.length) return;
          let end = sorted[0] + slotMs();
          if (sorted.length === 1) { // a single tap schedules a full meeting length from that slot
            const want = sorted[0] + durationMin() * 60000;
            const valid = new Set(S.slots);
            while (end < want && valid.has(end)) end += slotMs();
          } else for (let i = 1; i < sorted.length && sorted[i] === end; i++) end += slotMs();
          S.pending = { start: sorted[0], end };
          for (const [t, c] of cells) c.classList.toggle('fin', t >= S.pending.start && t < S.pending.end);
          showConfirm();
        },
      });
    } else {
      grid.addEventListener('pointerover', (e) => { const c = e.target.closest('.cell'); if (c && c.dataset.t && S.pinned == null) show(Number(c.dataset.t)); });
      grid.addEventListener('click', (e) => {
        const c = e.target.closest('.cell'); if (!c || !c.dataset.t) return;
        const t = Number(c.dataset.t);
        S.pinned = S.pinned === t ? null : t;
        for (const [tt, cc] of cells) cc.classList.toggle('hl', tt === S.pinned);
        show(t);
      });
    }
    if (S.pinned != null) show(S.pinned);
    S._groupCells = cells;
  }

  // ---------- final time ----------
  function rangeLabel(f) {
    const a = Slots.localSlot(f.start, S.viewTz), b = Slots.localSlot(f.end, S.viewTz);
    if (datesOnly()) { const last = Slots.localSlot(f.end - 1, S.viewTz); return a.dayKey === last.dayKey ? fmtDay(a.dayKey, { long: true }) : `${fmtDay(a.dayKey)} – ${fmtDay(last.dayKey)}`; }
    const endLbl = b.dayKey === a.dayKey ? fmtTime(b.minute) : (b.minute === 0 ? fmtTime(1440) : `${fmtTime(b.minute)} (${fmtDay(b.dayKey)})`);
    return `${fmtDay(a.dayKey, { long: true })}, ${fmtTime(a.minute)}–${endLbl}`;
  }
  function freeFor(f) {
    const { per } = tally();
    const all = [], some = [];
    for (const r of S.poll.responses) {
      let ok = true, maybe = false;
      for (let t = f.start; t < f.end; t += slotMs()) { const v = r.slots[t]; if (!v) { ok = false; break; } if (v === 2) maybe = true; }
      if (ok) (maybe ? some : all).push(r.name);
    }
    void per;
    return { all, some };
  }
  function setPick(on) {
    S.pick = on; if (!on) { S.pending = null; $('#confirm-bar').classList.add('hidden'); }
    $('#pick-final').textContent = on ? 'Cancel picking' : '📅 Pick the final time';
    renderGroup();
  }
  function showConfirm() {
    const f = S.pending; const { all, some } = freeFor(f);
    $('#confirm-text').replaceChildren(el('b', {}, rangeLabel(f)), el('div', { class: 'small muted' }, `${all.length}${some.length ? ` (+${some.length} if needed)` : ''} of ${S.poll.responses.length} free the whole time`));
    $('#confirm-bar').classList.remove('hidden');
    $('#confirm-bar').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  async function saveFinal(final) {
    try {
      if (STATIC) { S.poll.config.final = final; await writeStatic(); $('#static-share').classList.remove('hidden'); }
      else await api('PATCH', `/api/polls/${pollId}`, { final }, hdrs());
      S.pending = null; S.pick = false; $('#confirm-bar').classList.add('hidden'); $('#pick-final').textContent = '📅 Pick the final time';
      await load(false);
      toast(final ? 'Scheduled! Everyone opening the poll now sees the final time.' : 'Schedule removed.', 'ok');
      if (final) window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { toast(e.message, 'error'); }
  }
  const icsDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  function renderFinal() {
    const f = S.poll.config.final;
    $('#final-banner').classList.toggle('hidden', !f);
    if (!f) return;
    const cfg = S.poll.config;
    $('#final-when').textContent = rangeLabel(f) + (datesOnly() ? '' : ` (${S.viewTz.replace(/_/g, ' ')})`);
    const { all, some } = freeFor(f);
    $('#final-who').textContent = S.poll.responses.length ? `Free: ${all.join(', ') || '—'}${some.length ? ` · if needed: ${some.join(', ')}` : ''}` : '';
    const q = new URLSearchParams({ action: 'TEMPLATE', text: cfg.title, details: cfg.description || '', dates: `${icsDate(f.start)}/${icsDate(f.end)}` });
    $('#final-gcal').href = `https://calendar.google.com/calendar/render?${q}`;
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//timeavailable//EN', 'BEGIN:VEVENT', `UID:${pollId}-${f.start}@timeavailable`, `DTSTAMP:${icsDate(Date.now())}`, `DTSTART:${icsDate(f.start)}`, `DTEND:${icsDate(f.end)}`, `SUMMARY:${cfg.title.replace(/[,;\\]/g, '\\$&')}`, cfg.description ? `DESCRIPTION:${cfg.description.replace(/[,;\\]/g, '\\$&').replace(/\n/g, '\\n')}` : null, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
    $('#final-ics').href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);
  }

  function renderPeople() {
    const box = $('#people');
    if (!S.poll.responses.length) { box.replaceChildren(el('span', { class: 'muted small' }, 'No responses yet. Be the first!')); return; }
    const canRemove = S.poll.isAdmin || STATIC;
    if (S.filter && !S.poll.responses.some((r) => r.name === S.filter)) S.filter = null;
    box.replaceChildren(...S.poll.responses.map((r) => el('span', { class: 'person' + (r.name === S.filter ? ' active' : '') + (r.id === S.rid ? ' avail' : ''), role: 'button', tabindex: 0, title: 'Show this person\'s availability',
      onclick: () => { S.filter = S.filter === r.name ? null : r.name; renderGroup(); renderPeople(); } },
      r.name, r.id === S.rid ? el('span', { class: 'muted small' }, ' (you)') : null,
      canRemove ? el('button', { class: 'rm', title: 'Remove this response', onclick: async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove ${r.name}'s response?`)) return;
        try {
          if (STATIC) { S.poll.responses = S.poll.responses.filter((x) => x !== r); await writeStatic(); $('#static-share').classList.remove('hidden'); }
          else await api('DELETE', `/api/polls/${pollId}/responses/${r.id}`, undefined, hdrs());
          if (r.id === S.rid) { S.rid = null; S.editKey = null; storeRemove(`ta:resp:${pollId}`); }
          await load(false);
        } catch (err) { toast(err.message, 'error'); }
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
      const d = durationMin();
      const opts = [sm, sm * 2, sm * 3, sm * 4, d, d + sm, d * 2, sm * 8].filter((v, i, a) => a.indexOf(v) === i && v <= 1440).sort((a, b) => a - b);
      lenSel.replaceChildren(...opts.map((m) => el('option', { value: m }, (m >= 60 ? `${+(m / 60).toFixed(2)} h` : `${m} min`) + (m === d ? ' (meeting length)' : ''))));
      lenSel.value = String(d);
    }
    const minLen = datesOnly() ? 1440 : Number(lenSel.value);
    const list = $('#best');
    if (!N) { list.replaceChildren(el('li', { class: 'muted small' }, 'Waiting for responses.')); return; }
    const count = (t) => { const e = per.get(t); return e.avail.length + (countMaybe ? e.maybe.length : 0); };
    const runs = [];
    let cur = null;
    for (const t of S.slots) {
      const ok = count(t) >= k;
      if (ok && cur && t === cur.end) { cur.end = t + slotMs(); cur.min = Math.min(cur.min, count(t)); cur.n++; }
      else if (ok) { cur = { start: t, end: t + slotMs(), min: count(t), n: 1 }; runs.push(cur); }
      else cur = null;
    }
    const good = runs.filter((r) => r.end - r.start >= minLen * 60000);
    good.sort((a, b) => (b.min - a.min) || ((b.end - b.start) - (a.end - a.start)) || (a.start - b.start));
    if (!good.length) { list.replaceChildren(el('li', { class: 'muted small' }, 'No slot matches yet. Lower the number of people or the minimum length.')); return; }
    list.replaceChildren(...good.slice(0, 12).map((r) => el('li', { onclick: () => jumpTo(r) },
      el('span', {}, rangeLabel(r)), el('span', { class: 'cnt' }, `${r.min}/${N}`))));
  }
  function jumpTo(r) {
    const { dayKey } = Slots.localSlot(r.start, S.viewTz);
    const idx = S.layout.days.indexOf(dayKey);
    if (idx >= 0 && (idx < S.page || idx >= S.page + S.perPage)) { S.page = Math.floor(idx / S.perPage) * S.perPage; renderMine(); renderGroup(); }
    if (S.pick) { S.pending = { start: r.start, end: r.end }; renderGroup(); showConfirm(); }
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
  function busyBtn(b) { $('#google-import').disabled = b; }

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
      try { google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignore */ }
    }
  }

  async function fetchBusy(token) {
    const ids = [{ id: 'primary' }, ...$('#extra-cals').value.split(',').map((x) => x.trim()).filter(Boolean).map((id) => ({ id }))];
    const first = S.slots[0], last = S.slots[S.slots.length - 1] + slotMs();
    const CHUNK = 42 * 86400000;
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
    S.busy = busy;
    let free = 0;
    for (const t of S.slots) {
      if (isBusy(t)) S.mine.delete(t);
      else { free++; if (!S.mine.has(t)) S.mine.set(t, 1); }
    }
    markDirty(); renderMine();
    toast(`${free} of ${S.slots.length} slots are free in your calendar and are now selected. Busy times are hatched. Adjust anything, then save.`, 'ok');
  }

  load(true);
})();
