(() => {
  const state = { dates: new Set(), mode: 'times', excluded: new Set(), month: null };
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${Slots.pad(today.getMonth() + 1)}-${Slots.pad(today.getDate())}`;
  state.month = new Date(today.getFullYear(), today.getMonth(), 1);

  // ---- date picker ----
  const cal = $('#cal');
  let drag = null; // { anchor, mode: 'add'|'remove', snapshot:Set }
  const keyOf = (d) => `${d.getFullYear()}-${Slots.pad(d.getMonth() + 1)}-${Slots.pad(d.getDate())}`;

  function renderCal() {
    const y = state.month.getFullYear(), m = state.month.getMonth();
    const first = new Date(y, m, 1), startDow = first.getDay();
    const head = el('div', { class: 'cal-head' },
      el('button', { type: 'button', class: 'btn-sm', onclick: () => { state.month = new Date(y, m - 1, 1); renderCal(); } }, '‹'),
      el('b', {}, `${MONTHS[m]} ${y}`),
      el('button', { type: 'button', class: 'btn-sm', onclick: () => { state.month = new Date(y, m + 1, 1); renderCal(); } }, '›'));
    const grid = el('div', { class: 'cal-grid' }, DOW.map((d) => el('div', { class: 'dow' }, d)));
    const start = new Date(y, m, 1 - startDow);
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const k = keyOf(d);
      const cls = ['cal-day'];
      if (d.getMonth() !== m) cls.push('other');
      if (k < todayKey) cls.push('past');
      if (k === todayKey) cls.push('today');
      if (state.dates.has(k)) cls.push('sel');
      grid.append(el('div', { class: cls.join(' '), dataset: { k } }, String(d.getDate())));
    }
    cal.replaceChildren(head, grid);
  }
  const dayAt = (x, y) => { const n = document.elementFromPoint(x, y); return n && n.classList.contains('cal-day') ? n.dataset.k : null; };
  function applyRange(a, b, mode) {
    state.dates = new Set(drag.snapshot);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const [y, m, d] = lo.split('-').map(Number);
    for (let dt = new Date(y, m - 1, d); ; dt.setDate(dt.getDate() + 1)) {
      const k = keyOf(dt);
      if (k > hi) break;
      if (mode === 'add') state.dates.add(k); else state.dates.delete(k);
    }
    renderCal(); updateDates();
  }
  cal.addEventListener('pointerdown', (e) => {
    const k = dayAt(e.clientX, e.clientY); if (!k) return;
    e.preventDefault();
    drag = { anchor: k, mode: state.dates.has(k) ? 'remove' : 'add', snapshot: new Set(state.dates), last: k };
    try { cal.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    applyRange(k, k, drag.mode);
  });
  cal.addEventListener('pointermove', (e) => { if (!drag) return; const k = dayAt(e.clientX, e.clientY); if (k && k !== drag.last) { drag.last = k; applyRange(drag.anchor, k, drag.mode); } });
  const endDrag = () => { drag = null; };
  cal.addEventListener('pointerup', endDrag); cal.addEventListener('pointercancel', endDrag);

  $$('[data-quick]').forEach((b) => b.addEventListener('click', () => {
    const q = b.dataset.quick;
    const n = q === 'weekdays' ? 14 : Number(q);
    for (let i = 0; i < n; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      if (q === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) continue;
      state.dates.add(keyOf(d));
    }
    renderCal(); updateDates();
  }));
  $('#clear-dates').addEventListener('click', () => { state.dates.clear(); renderCal(); updateDates(); });

  function updateDates() {
    const list = [...state.dates].sort();
    $('#date-summary').textContent = list.length ? `${list.length} date${list.length > 1 ? 's' : ''} selected` : 'No dates selected yet.';
    $('#date-chips').replaceChildren(...list.map((k) => el('span', { class: 'chip' }, fmtDay(k))));
    updatePreview();
  }

  // ---- mode / times ----
  $$('.mode').forEach((b) => b.addEventListener('click', () => {
    $$('.mode').forEach((x) => x.classList.toggle('active', x === b));
    state.mode = b.dataset.mode;
    $('#time-opts').classList.toggle('hidden', state.mode === 'dates');
    state.excluded.clear(); updatePreview();
  }));
  $('#slot').addEventListener('change', () => { $('#slot-custom').classList.toggle('hidden', $('#slot').value !== 'custom'); state.excluded.clear(); updatePreview(); });
  ['start', 'end', 'slot-custom', 'tz'].forEach((id) => $('#' + id).addEventListener('change', () => { state.excluded.clear(); updatePreview(); }));
  fillTzSelect($('#tz'), browserTz());

  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  function currentConfig() {
    const dates = [...state.dates].sort();
    const cfg = { title: $('#title').value, description: $('#description').value, dates, tz: $('#tz').value, allowMaybe: $('#allowMaybe').checked, excluded: [...state.excluded] };
    if (state.mode === 'dates') Object.assign(cfg, { startMin: 0, endMin: 1440, slotMin: 1440, datesOnly: true });
    else {
      const slotSel = $('#slot').value;
      const slotMin = slotSel === 'custom' ? Number($('#slot-custom').value) : Number(slotSel);
      let endMin = $('#end').value ? toMin($('#end').value) : 0;
      if (endMin === 0) endMin = 1440;
      Object.assign(cfg, { startMin: $('#start').value ? toMin($('#start').value) : 0, endMin, slotMin });
    }
    return cfg;
  }

  // ---- preview ----
  let previewPage = 0;
  function updatePreview() {
    const cfg = currentConfig();
    const info = $('#preview-info'), box = $('#preview');
    if (!cfg.dates.length) { info.textContent = 'Select some dates to see the grid.'; box.replaceChildren(); return; }
    if (!(cfg.slotMin >= 5) || cfg.endMin <= cfg.startMin) { info.textContent = 'Check the start/end times and slot length.'; box.replaceChildren(); return; }
    const all = Slots.generate({ ...cfg, excluded: [] });
    const active = all.filter((t) => !state.excluded.has(t));
    info.textContent = `${active.length} slot${active.length === 1 ? '' : 's'} across ${cfg.dates.length} date${cfg.dates.length === 1 ? '' : 's'}` + (state.excluded.size ? ` (${state.excluded.size} removed)` : '') + (all.length > 8000 ? ' — too many; use longer slots or fewer dates.' : '');
    const layout = layoutSlots(all, cfg.tz, cfg.slotMin);
    const perPage = daysThatFit(box.clientWidth || 600, cfg.datesOnly);
    previewPage = Math.min(previewPage, Math.max(0, layout.days.length - 1));
    const { grid, cells } = renderGrid(box, layout, { datesOnly: cfg.datesOnly, page: { start: previewPage, count: perPage }, onNav: (d) => { previewPage = Math.max(0, Math.min(layout.days.length - 1, previewPage + d * perPage)); updatePreview(); } });
    for (const [t, c] of cells) if (state.excluded.has(t)) c.classList.add('x');
    grid.addEventListener('click', (e) => {
      const c = e.target.closest('.cell'); if (!c || !c.dataset.t) return;
      const t = Number(c.dataset.t);
      if (state.excluded.has(t)) state.excluded.delete(t); else state.excluded.add(t);
      updatePreview();
    });
  }
  window.addEventListener('resize', () => updatePreview());

  // ---- submit ----
  function validateStatic(cfg) {
    if (!cfg.title.trim()) throw new Error('Title is required');
    if (!cfg.dates.length) throw new Error('Pick at least one date');
    if (!(cfg.slotMin >= 5) || cfg.endMin <= cfg.startMin) throw new Error('Check the start/end times and slot length');
    const n = Slots.generate(cfg).length;
    if (!n) throw new Error('The grid has no time slots');
    if (n > 8000) throw new Error(`Too many time slots (${n}, max 8000). Use longer slots or fewer dates.`);
  }
  $('#create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#create-error'); err.classList.add('hidden');
    const cfg = currentConfig();
    const btn = $('#submit'); btn.disabled = true;
    try {
      let share, admin = '';
      if (STATIC_MODE) {
        const clean = { title: cfg.title.trim(), description: cfg.description.trim(), tz: cfg.tz, dates: cfg.dates, startMin: cfg.startMin, endMin: cfg.endMin, slotMin: cfg.slotMin, allowMaybe: cfg.allowMaybe, excluded: cfg.excluded.sort((a, b) => a - b) };
        validateStatic(clean);
        const blob = await encodeState({ c: clean, r: [] });
        share = new URL('poll.html#' + blob, location.href).href;
        const sid = hashId(JSON.stringify(clean));
        store(`ta:static:${sid}`, { title: clean.title, link: share, createdAt: Date.now() });
        store(`ta:host:${sid}`, true);
      } else {
        const { id, adminKey } = await api('POST', '/api/polls', cfg);
        share = `${location.origin}/p/${id}`;
        admin = `${share}?admin=${adminKey}`;
        store(`ta:admin:${id}`, { adminKey, title: cfg.title, createdAt: Date.now() });
      }
      $('#share-link').value = share; $('#open-share').href = share; $('#admin-link').value = admin;
      $('#admin-box').classList.toggle('hidden', STATIC_MODE); $('#static-box').classList.toggle('hidden', !STATIC_MODE);
      $('#share-share').classList.toggle('hidden', !navigator.share);
      $('#done').classList.remove('hidden'); $('#create').classList.add('hidden');
      $('#done').scrollIntoView({ behavior: 'smooth' });
      renderRecent();
    } catch (ex) {
      err.textContent = ex.message; err.classList.remove('hidden'); err.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally { btn.disabled = false; }
  });
  $('#copy-share').addEventListener('click', () => copyText($('#share-link').value));
  $('#share-share').addEventListener('click', () => shareOrCopy($('#share-link').value, $('#title').value));
  $('#copy-admin').addEventListener('click', () => copyText($('#admin-link').value));

  function renderRecent() {
    const items = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('ta:admin:')) { const v = store(k); if (v) items.push({ href: `/p/${k.slice(9)}?admin=${v.adminKey}`, ...v }); }
        if (k && k.startsWith('ta:static:')) { const v = store(k); if (v && v.link) items.push({ href: v.link, ...v }); }
      }
    } catch { /* ignore */ }
    items.sort((a, b) => b.createdAt - a.createdAt);
    $('#recent-card').classList.toggle('hidden', !items.length);
    $('#recent').replaceChildren(...items.map((it) => el('div', { class: 'row', style: 'justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)' },
      el('a', { href: it.href }, it.title || 'Untitled'),
      el('span', { class: 'muted small' }, new Date(it.createdAt).toLocaleDateString()))));
  }

  renderCal(); updateDates(); renderRecent();
})();
