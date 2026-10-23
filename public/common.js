/* Shared browser helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};

async function api(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const tzList = () => { try { return Intl.supportedValuesOf('timeZone'); } catch { return [browserTz(), 'UTC']; } };

function fillTzSelect(select, value) {
  const list = tzList();
  if (!list.includes(value)) list.unshift(value);
  select.replaceChildren(...list.map((z) => el('option', { value: z }, z.replace(/_/g, ' '))));
  select.value = value;
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function fmtDay(dayKey, opts = {}) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const wd = DOW[dt.getUTCDay()];
  if (opts.long) return `${wd}, ${MONTHS[m - 1]} ${d}, ${y}`;
  return `${wd} ${MONTHS[m - 1].slice(0, 3)} ${d}`;
}
function fmtTime(min, h12 = useH12()) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  if (!h12) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const hh = h % 12 || 12, ap = h < 12 ? 'am' : 'pm';
  return m ? `${hh}:${String(m).padStart(2, '0')}${ap}` : `${hh}${ap}`;
}
let _h12;
function useH12() {
  if (_h12 === undefined) {
    try { _h12 = !!new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12; } catch { _h12 = false; }
  }
  return _h12;
}

function store(key, val) {
  try { if (val === undefined) return JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify(val)); } catch { return null; }
}
function storeRemove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

function toast(msg, kind = '') {
  let t = $('#toast');
  if (!t) { t = el('div', { id: 'toast', class: 'alert' }); t.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:50;box-shadow:var(--shadow);max-width:90vw'; document.body.append(t); }
  t.className = 'alert ' + kind; t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 3500);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'ok'); }
  catch { toast('Could not copy automatically. Select the link and copy it.', 'error'); }
}

/*
 * Build a grid layout for a set of slot epochs in a display timezone.
 * Returns { days: [dayKey...], rows: [minute...], at: Map("day|minute" -> epoch), slotMin }.
 */
function layoutSlots(epochs, tz, slotMin) {
  const days = new Set(), rows = new Set(), at = new Map();
  for (const t of epochs) {
    const { dayKey, minute } = Slots.localSlot(t, tz);
    days.add(dayKey); rows.add(minute); at.set(dayKey + '|' + minute, t);
  }
  return { days: [...days].sort(), rows: [...rows].sort((a, b) => a - b), at, slotMin };
}

// How many day columns fit in a container of the given width.
function daysThatFit(width, datesOnly) {
  const minCol = datesOnly ? 64 : 58;
  return Math.max(1, Math.min(7, Math.floor((width - 56) / minCol)));
}

/*
 * Render a calendar-style grid.
 * opts: { datesOnly, page: {start, count}, readonly, cellContent(t) -> string|null, onNav(delta) }
 * Returns { grid, cells: Map(epoch -> element), days (visible), rows }.
 */
function renderGrid(container, layout, opts = {}) {
  const { rows, at } = layout;
  const page = opts.page || { start: 0, count: layout.days.length };
  const days = layout.days.slice(page.start, page.start + page.count);
  const wrap = el('div', { class: 'cal-wrap' });
  if (layout.days.length > page.count) {
    const first = days[0], last = days[days.length - 1];
    wrap.append(el('div', { class: 'cal-nav' },
      el('button', { type: 'button', class: 'btn-sm', disabled: page.start === 0, onclick: () => opts.onNav && opts.onNav(-1), 'aria-label': 'Earlier days' }, '‹'),
      el('span', {}, first === last ? fmtDay(first, { long: true }) : `${fmtDay(first)} – ${fmtDay(last)}`, el('span', { class: 'muted' }, ` · ${page.start + 1}–${page.start + days.length} of ${layout.days.length} days`)),
      el('button', { type: 'button', class: 'btn-sm', disabled: page.start + page.count >= layout.days.length, onclick: () => opts.onNav && opts.onNav(1), 'aria-label': 'Later days' }, '›')));
  }
  const grid = el('div', { class: 'cal' + (opts.datesOnly ? ' dates-only' : '') + (opts.readonly ? ' readonly' : '') });
  grid.style.gridTemplateColumns = `${opts.datesOnly ? 0 : 52}px repeat(${days.length}, minmax(0, 1fr))`;
  grid.append(el('div', { class: 'corner' }));
  days.forEach((d) => {
    const [y, m, dd] = d.split('-').map(Number);
    const wd = DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
    grid.append(el('div', { class: 'col-h' }, el('span', {}, `${wd} · ${MONTHS[m - 1].slice(0, 3)}`), el('b', {}, String(dd))));
  });
  const cells = new Map();
  rows.forEach((min, r) => {
    const hourStart = !opts.datesOnly && min % 60 === 0;
    const label = opts.datesOnly ? '' : (hourStart || r === 0 ? fmtTime(min) : '');
    grid.append(el('div', { class: 'row-h' }, label ? el('span', {}, label) : null));
    days.forEach((d, c) => {
      const t = at.get(d + '|' + min);
      const cls = 'cell' + (hourStart ? ' hour' : '') + (r === 0 ? ' first' : '');
      if (t === undefined) { grid.append(el('div', { class: cls + ' gap', title: 'Not offered' })); return; }
      const cell = el('div', { class: cls, dataset: { t: String(t), c: String(c), r: String(r) }, title: opts.datesOnly ? fmtDay(d, { long: true }) : `${fmtDay(d)} ${fmtTime(min)}–${fmtTime(min + layout.slotMin)}` });
      if (opts.cellContent) { const txt = opts.cellContent(t); if (txt != null && txt !== '') cell.append(el('span', { class: 'n' }, String(txt))); }
      cells.set(t, cell);
      grid.append(cell);
    });
  });
  wrap.append(grid);
  container.replaceChildren(wrap);
  return { grid, cells, days, rows };
}

/*
 * Rectangular drag selection (like a calendar / When2Meet): press on a cell, drag to another,
 * every cell inside the rectangle is affected.
 *   onStart(t)  -> mode (anything but null/undefined) or null to ignore the gesture
 *   onPreview(set, mode) -> called while dragging with the epochs inside the rectangle
 *   onCommit(set, mode)  -> called on release
 *   sameColumn: restrict the rectangle to the column where the drag started
 */
function enableRectSelect(grid, cells, { onStart, onPreview, onCommit, sameColumn = false }) {
  let drag = null;
  const byPos = new Map();
  for (const [t, c] of cells) byPos.set(c.dataset.c + '|' + c.dataset.r, t);
  const cellAt = (x, y) => { const n = document.elementFromPoint(x, y); return n && n.classList && n.classList.contains('cell') && n.dataset.t ? n : null; };
  const rect = (a, b) => {
    const set = new Set();
    const c1 = sameColumn ? a.c : Math.min(a.c, b.c), c2 = sameColumn ? a.c : Math.max(a.c, b.c);
    const r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r);
    for (let c = c1; c <= c2; c++) for (let r = r1; r <= r2; r++) { const t = byPos.get(c + '|' + r); if (t !== undefined) set.add(t); }
    return set;
  };
  const pos = (n) => ({ c: Number(n.dataset.c), r: Number(n.dataset.r), t: Number(n.dataset.t) });
  grid.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    const n = cellAt(e.clientX, e.clientY); if (!n) return;
    const a = pos(n);
    const mode = onStart(a.t); if (mode == null) return;
    e.preventDefault();
    drag = { a, mode, last: a.c + '|' + a.r, id: e.pointerId };
    try { grid.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    onPreview(rect(a, a), mode);
  });
  grid.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const n = cellAt(e.clientX, e.clientY); if (!n) return;
    const b = pos(n); const key = b.c + '|' + b.r;
    if (key === drag.last) return;
    drag.last = key; onPreview(rect(drag.a, b), drag.mode);
  });
  const finish = (e) => {
    if (!drag) return;
    const n = cellAt(e.clientX, e.clientY);
    const b = n ? pos(n) : null;
    const set = rect(drag.a, b || drag.a);
    const mode = drag.mode; drag = null;
    onCommit(set, mode);
  };
  grid.addEventListener('pointerup', finish);
  grid.addEventListener('pointercancel', (e) => { if (drag) { const m = drag.mode; drag = null; onCommit(new Set(), m); } });
}

function heatColor(frac) {
  // frac 0..1 -> cell base to strong green
  if (frac <= 0) return '';
  const a = 0.15 + 0.85 * frac;
  return `rgba(47, 191, 113, ${a.toFixed(3)})`;
}

/* ---------- Link-encoded state (static / serverless mode) ---------- */
const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function encodeState(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return 'z' + b64u(new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  return 'j' + b64u(bytes);
}
async function decodeState(str) {
  if (!str) throw new Error('Empty link');
  const kind = str[0], data = unb64u(str.slice(1));
  if (kind === 'z') {
    if (typeof DecompressionStream !== 'function') throw new Error('This browser is too old to open this link');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return JSON.parse(await new Response(stream).text());
  }
  if (kind === 'j') return JSON.parse(new TextDecoder().decode(data));
  throw new Error('Unrecognised link');
}
// Short stable id for a config (used for localStorage keys in static mode).
function hashId(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0; return h.toString(36); }
const CFG = window.TA_CONFIG || {};
const STATIC_MODE = !!CFG.static;
// Extract the state blob from any poll link (or bare blob).
function blobFromLink(text) {
  const m = String(text).trim().match(/#([zj][A-Za-z0-9_-]+)\s*$/) || String(text).trim().match(/^([zj][A-Za-z0-9_-]+)$/);
  return m ? m[1] : null;
}
async function shareOrCopy(url, title) {
  if (navigator.share) { try { await navigator.share({ title, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  copyText(url);
}

/* ---------- Seasonal theme (purely decorative, never touches the grids) ---------- */
(function seasonal() {
  const now = new Date(), m = now.getMonth(), d = now.getDate();
  const inSeason = (m === 9 && d >= 15) || (m === 10 && d <= 1); // Oct 15 – Nov 1
  const pref = store('ta:theme'); // 'halloween' | 'plain' | null
  const on = pref === 'halloween' || (pref !== 'plain' && inSeason);
  const apply = () => {
    document.body.classList.toggle('halloween', on);
    document.querySelectorAll('.hw-sky, .hw-web').forEach((n) => n.remove());
    if (on) {
      const sky = el('div', { class: 'hw-sky', 'aria-hidden': 'true' }, el('span', { class: 'hw-bat' }, '🦇'), el('span', { class: 'hw-bat' }, '🦇'), el('span', { class: 'hw-bat' }, '🦇'));
      document.body.prepend(sky);
      const bar = document.querySelector('.topbar');
      if (bar) {
        const web = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        web.setAttribute('class', 'hw-web'); web.setAttribute('viewBox', '0 0 100 100'); web.setAttribute('aria-hidden', 'true');
        web.innerHTML = '<g fill="none" stroke="currentColor" stroke-width="1"><path d="M0 0L100 0M0 0L0 100M0 0L70 70M0 0L95 40M0 0L40 95"/><path d="M20 0Q18 12 0 20M40 0Q35 26 0 40M60 0Q52 40 0 60M80 0Q68 55 0 80"/></g>';
        bar.prepend(web);
      }
    }
  };
  const mount = () => {
    apply();
    const bar = document.querySelector('.topbar');
    if (bar && !bar.querySelector('.hw-toggle') && (inSeason || pref)) {
      bar.append(el('button', { type: 'button', class: 'hw-toggle', title: on ? 'Turn off Halloween decorations' : 'Turn on Halloween decorations', 'aria-label': 'Toggle Halloween theme',
        onclick: () => { store('ta:theme', on ? 'plain' : 'halloween'); location.reload(); } }, on ? '🎃' : '👻'));
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
