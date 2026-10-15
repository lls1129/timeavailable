/*
 * Shared slot / timezone helpers. Used by both the browser (window.Slots)
 * and the server (require). No dependencies.
 *
 * A poll's grid is defined by: dates[] (YYYY-MM-DD), startMin, endMin,
 * slotMin, tz. Every slot is identified by its UTC epoch milliseconds, so a
 * slot means the same instant for everyone regardless of display timezone.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Slots = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const dtfCache = new Map();
  function dtf(tz) {
    let f = dtfCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
      });
      dtfCache.set(tz, f);
    }
    return f;
  }

  function isValidTz(tz) {
    try { dtf(tz); return true; } catch (e) { return false; }
  }

  // Wall-clock parts of a UTC instant in a timezone.
  function partsIn(utcMs, tz) {
    const p = {};
    for (const part of dtf(tz).formatToParts(new Date(utcMs))) p[part.type] = part.value;
    return {
      year: +p.year, month: +p.month, day: +p.day,
      hour: +p.hour, minute: +p.minute, second: +p.second,
      weekday: p.weekday,
    };
  }

  function tzOffsetMs(utcMs, tz) {
    const p = partsIn(utcMs, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return asUtc - utcMs; // local minus utc
  }

  // Convert a wall-clock (date + minutes after midnight) in tz to UTC ms.
  function zonedToUtc(dateStr, minutes, tz) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d) + minutes * 60000;
    const off1 = tzOffsetMs(guess, tz);
    let utc = guess - off1;
    const off2 = tzOffsetMs(utc, tz);
    if (off2 !== off1) utc = guess - off2;
    return utc;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  // Day key (YYYY-MM-DD) and minute-of-day of an instant, viewed in tz.
  function localSlot(utcMs, tz) {
    const p = partsIn(utcMs, tz);
    return {
      dayKey: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
      minute: p.hour * 60 + p.minute,
      weekday: p.weekday,
    };
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function isValidDate(s) {
    if (!DATE_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  // All slot epochs for a poll config, sorted, excluding `excluded`.
  function generate(cfg) {
    const out = [];
    const excluded = new Set((cfg.excluded || []).map(Number));
    const dates = [...cfg.dates].sort();
    for (const date of dates) {
      for (let m = cfg.startMin; m < cfg.endMin; m += cfg.slotMin) {
        const t = zonedToUtc(date, m, cfg.tz);
        if (!excluded.has(t)) out.push(t);
      }
    }
    return out;
  }

  function fmtMinute(min) {
    const h = Math.floor(min / 60) % 24, m = min % 60;
    return `${pad(h)}:${pad(m)}`;
  }

  return { isValidTz, isValidDate, zonedToUtc, localSlot, partsIn, generate, fmtMinute, pad };
});
