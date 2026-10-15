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

/*
 * Render a grid. opts: { tz, slotMin, datesOnly, cellClass(epoch) -> string, onCell(epoch, cell) }
 */
function renderGrid(container, layout, opts) {
  const { days, rows, at } = layout;
  const grid = el('div', { class: 'tgrid' + (opts.datesOnly ? ' dates-only' : '') + (opts.readonly ? ' readonly' : '') });
  grid.style.gridTemplateColumns = `auto repeat(${days.length}, auto)`;
  grid.append(el('div', { class: 'corner' }));
  for (const d of days) {
    const [y, m, dd] = d.split('-').map(Number);
    const wd = DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
    grid.append(el('div', { class: 'col-h' }, wd, el('small', {}, `${MONTHS[m - 1].slice(0, 3)} ${dd}`)));
  }
  const cells = new Map();
  rows.forEach((min, i) => {
    const showLabel = opts.datesOnly ? false : (min % 60 === 0 || layout.slotMin >= 60 || i === 0);
    const isHour = !opts.datesOnly && min % 60 === 0 && i > 0;
    grid.append(el('div', { class: 'row-h' }, showLabel ? fmtTime(min) : ''));
    for (const d of days) {
      const t = at.get(d + '|' + min);
      if (t === undefined) { grid.append(el('div', { class: 'cell empty' + (isHour ? ' hour' : '') })); continue; }
      const c = el('div', { class: 'cell' + (isHour ? ' hour' : ''), dataset: { t: String(t) }, title: opts.title ? opts.title(t) : `${fmtDay(d)} ${opts.datesOnly ? '' : fmtTime(min)}` });
      cells.set(t, c);
      grid.append(c);
    }
  });
  container.replaceChildren(grid);
  return { grid, cells };
}

/* Paint interaction for an editable grid: click/drag to apply a brush. */
function enablePainting(grid, cells, getLevel, setLevel, brushFn, onDone) {
  let painting = false, target = null, touched = new Set();
  const cellAt = (x, y) => { const n = document.elementFromPoint(x, y); return n && n.classList.contains('cell') && n.dataset.t ? n : null; };
  const apply = (c) => {
    const t = Number(c.dataset.t);
    if (touched.has(t)) return;
    touched.add(t); setLevel(t, target); c.className = c.className.replace(/\bl[12]\b/g, '').trim() + (target ? ' l' + target : '');
  };
  grid.addEventListener('pointerdown', (e) => {
    const c = cellAt(e.clientX, e.clientY); if (!c) return;
    e.preventDefault();
    const t = Number(c.dataset.t), brush = brushFn();
    target = getLevel(t) === brush ? 0 : brush; // clicking an already-painted cell with the same brush clears it
    painting = true; touched = new Set();
    try { grid.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    apply(c);
  });
  grid.addEventListener('pointermove', (e) => { if (!painting) return; const c = cellAt(e.clientX, e.clientY); if (c) apply(c); });
  const stop = () => { if (painting) { painting = false; onDone && onDone(); } };
  grid.addEventListener('pointerup', stop); grid.addEventListener('pointercancel', stop);
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
