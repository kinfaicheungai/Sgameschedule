// Shared schedule parser — used by the browser (CSV / Excel / paste) and the Worker (Google Sheet sync).
// Input: a table (array of rows, each an array of cells: string | number).
// Output: { matches: [{id, at, home, away, channel, note, enabled}], errors: [string] }

/** Split CSV / TSV text into a table. Handles quotes, commas inside quotes, CRLF, and tab-separated paste. */
export function textToTable(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = firstLine.includes('\t') ? '\t' : firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const HEADERS = {
  datetime: ['datetime', 'date time', 'date/time', 'kickoff', 'start', 'start time', '開賽', '開賽時間', '日期時間'],
  date: ['date', 'day', '日期', '日子'],
  time: ['time', 'tip off', 'tipoff', 'tip-off', '時間'],
  home: ['home', 'home team', 'team 1', 'team1', 'team a', 'teama', '主隊', '隊伍1', '隊1'],
  away: ['away', 'away team', 'team 2', 'team2', 'team b', 'teamb', 'opponent', '客隊', '隊伍2', '隊2', '對手'],
  match: ['match', 'game', 'fixture', 'teams', '比賽', '對賽', '賽事'],
  channel: ['channel', 'ch', 'court', 'venue', 'field', 'stream', 'camera', '頻道', '場地', '場', '球場'],
  enabled: ['reminder', 'remind', 'alert', 'enabled', 'notify', '提醒', '通知'],
  note: ['note', 'notes', 'round', 'pool', 'division', 'comment', '備註', '輪次', '組別'],
};
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ');

function headerMap(row) {
  const map = {};
  row.forEach((cell, i) => {
    const h = norm(cell);
    if (!h) return;
    for (const [field, names] of Object.entries(HEADERS)) {
      if (map[field] === undefined && names.includes(h)) { map[field] = i; return; }
    }
  });
  const known = Object.keys(map).length;
  const ok = (map.home !== undefined && map.away !== undefined) || map.match !== undefined;
  return known >= 2 && ok && (map.datetime !== undefined || map.date !== undefined) ? map : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** Excel serial number → {y,m,d,h,mi} (wall clock, no timezone). */
function fromSerial(n) {
  const ms = Math.round((n - 25569) * 86400000); // 25569 = 1970-01-01
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

/** Parse a time string or Excel fraction → {h, mi} or null. */
export function parseTime(v) {
  if (typeof v === 'number') {
    const f = v % 1; const total = Math.round(f * 1440);
    return { h: Math.floor(total / 60) % 24, mi: total % 60 };
  }
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  let m = /^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?(am|pm|a\.m\.|p\.m\.|上午|下午)?$/.exec(s);
  if (!m) { m = /^(上午|下午)(\d{1,2})(?:[:.](\d{2}))?$/.exec(s); if (m) m = [m[0], m[2], m[3], m[1]]; }
  if (!m) { const c = /^(\d{2})(\d{2})$/.exec(s); if (c) m = [s, c[1], c[2], undefined]; }
  if (!m) return null;
  let h = +m[1]; const mi = +(m[2] || 0); const ap = m[3] || '';
  if (mi > 59) return null;
  if (/p|下午/.test(ap) && h < 12) h += 12;
  if (/a|上午/.test(ap) && h === 12) h = 0;
  if (h > 23) return null;
  if (!ap && !m[2] && !/^\d{4}$/.test(s)) return null; // bare "7" is not a time
  return { h, mi };
}

/** Parse a date string or Excel serial → {y, m, d} or null. Day-first (Australian) for d/m/y. */
export function parseDate(v, now = new Date()) {
  if (typeof v === 'number' && v > 20000 && v < 80000) { const r = fromSerial(v); return { y: r.y, m: r.m, d: r.d }; }
  const s = String(v ?? '').trim().toLowerCase().replace(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*[,.]?\s*/, '').replace(/^(星期|週|周)[一二三四五六日天][,，]?\s*/, '');
  if (!s) return null;
  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) return valid(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s))) return valid(fullYear(+m[3]), +m[2], +m[1]);
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[-\s]*([a-z]{3,9})\.?[-\s,]*(\d{4}|\d{2}(?!:))?/.exec(s)) && monthNum(m[2]))
    return withYear(+m[1], monthNum(m[2]), m[3], now);
  if ((m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,\s]*(\d{4})?/.exec(s)) && monthNum(m[1]))
    return withYear(+m[2], monthNum(m[1]), m[3], now);
  if ((m = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?/.exec(s))) return withYear(+m[3], +m[2], m[1], now);
  if ((m = /^(\d{1,2})[/.](\d{1,2})$/.exec(s))) return withYear(+m[1], +m[2], undefined, now);
  return null;
}
const monthNum = (s) => MONTHS[s] || MONTHS[s.slice(0, 4)] || MONTHS[s.slice(0, 3)] || 0;
const fullYear = (y) => (y < 100 ? 2000 + y : y);
function valid(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 ? { y, m, d } : null;
}
function withYear(d, m, y, now) {
  if (y) return valid(fullYear(+y), m, d);
  // No year given: pick this year, or next year if that date is more than ~6 months ago.
  let yy = now.getUTCFullYear();
  if (Date.UTC(yy, m - 1, d) < now.getTime() - 183 * 86400000) yy++;
  return valid(yy, m, d);
}

/** Offset (ms) of `tz` at instant `ms`. */
function tzOffset(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}
/** Wall-clock time in `tz` → ISO UTC string. Handles daylight saving. */
export function zonedToIso({ y, m, d, h, mi }, tz) {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let t = wall - tzOffset(wall, tz);
  t = wall - tzOffset(t, tz);
  return new Date(t).toISOString();
}
/** ISO UTC → "YYYY-MM-DDTHH:MM" wall clock in `tz` (for <input type=datetime-local>). */
export function isoToZonedInput(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function parseEnabled(v) {
  const s = norm(v);
  if (!s) return true;
  return !['no', 'n', 'false', '0', 'off', 'disabled', 'x', '✗', '關', '否', '唔要', '不', '取消'].includes(s);
}

function splitMatch(s) {
  const m = /^(.+?)\s+(?:vs\.?|v\.?|對|-|–|—|@)\s+(.+)$/i.exec(String(s || '').trim());
  return m ? [m[1].trim(), m[2].trim()] : null;
}

/** Stable ID so re-importing the same fixture keeps its "already sent" status. */
export function matchId(at, home, away) {
  let h = 0x811c9dc5;
  for (const c of `${at}|${home}|${away}`.toLowerCase()) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'm-' + h.toString(36);
}

/** Split a "date time" cell into parts. */
function parseDateTime(v, now) {
  if (typeof v === 'number') { const r = fromSerial(v); return { date: { y: r.y, m: r.m, d: r.d }, time: { h: r.h, mi: r.mi } }; }
  const s = String(v ?? '').trim();
  const m = /^(.*?)[\sT,]+(\d{1,2}(?:[:.]\d{2})?(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)$/i.exec(s);
  if (m) return { date: parseDate(m[1], now), time: parseTime(m[2]) };
  const z = /^(.*?)(上午|下午)\s*(\d{1,2}(?:[:.]\d{2})?)$/.exec(s);
  if (z) return { date: parseDate(z[1], now), time: parseTime(z[2] + z[3]) };
  return { date: parseDate(s, now), time: null };
}

export function parseTable(table, { tz = 'Australia/Sydney', now = new Date() } = {}) {
  const rows = (table || []).map((r) => (Array.isArray(r) ? r : [])).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  const errors = [];
  const matches = [];
  if (!rows.length) return { matches, errors: ['冇資料'] };

  let map = null, start = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) { // allow a title row or two above the header
    const hm = headerMap(rows[i]);
    if (hm) { map = hm; start = i + 1; break; }
  }
  if (!map) {
    // No header: "datetime,home,away,channel[,reminder]" or "date,time,home,away,channel[,reminder]"
    const r0 = rows[0];
    const second = parseTime(r0[1]);
    map = second && parseDate(r0[0], now)
      ? { date: 0, time: 1, home: 2, away: 3, channel: 4, enabled: 5 }
      : { datetime: 0, home: 1, away: 2, channel: 3, enabled: 4 };
  }

  const seen = new Set();
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const get = (f) => (map[f] === undefined ? '' : r[map[f]] ?? '');
    let date, time;
    if (map.datetime !== undefined && String(get('datetime')).trim() !== '') ({ date, time } = parseDateTime(get('datetime'), now));
    if (map.date !== undefined) {
      const dv = get('date');
      if (typeof dv === 'number' && dv % 1 && !time) ({ date, time } = parseDateTime(dv, now));
      else if (!date) { const dt = parseDateTime(dv, now); date = dt.date; if (!time && dt.time) time = dt.time; }
    }
    if (map.time !== undefined && String(get('time')).trim() !== '') time = parseTime(get('time')) || time;

    let home = String(get('home')).trim(), away = String(get('away')).trim();
    if ((!home || !away) && map.match !== undefined) { const sp = splitMatch(get('match')); if (sp) [home, away] = sp; else if (!home) home = String(get('match')).trim(); }

    if (!date && !time && !home && !away) continue;
    if (!date) { errors.push(`第 ${line} 行：日期讀唔到（${get('date') || get('datetime')}）`); continue; }
    if (!time) { errors.push(`第 ${line} 行：時間讀唔到（${get('time') || get('datetime')}）`); continue; }
    if (!home) { errors.push(`第 ${line} 行：冇隊伍名`); continue; }

    const at = zonedToIso({ ...date, ...time }, tz);
    const id = matchId(at, home, away);
    if (seen.has(id)) continue;
    seen.add(id);
    matches.push({
      id, at,
      home: home.slice(0, 100), away: away.slice(0, 100),
      channel: String(get('channel')).trim().slice(0, 30),
      note: String(get('note')).trim().slice(0, 120),
      enabled: parseEnabled(get('enabled')),
    });
  }
  if (!matches.length && !errors.length) errors.push('搵唔到任何比賽資料');
  matches.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { matches, errors };
}

/** Google Sheets share/edit/publish link → CSV export URL. Returns null if not a Google Sheet link. */
export function sheetCsvUrl(link) {
  let u;
  try { u = new URL(String(link).trim()); } catch { return null; }
  if (u.hostname !== 'docs.google.com' || !u.pathname.startsWith('/spreadsheets/')) return null;
  const pub = /^\/spreadsheets\/d\/e\/([\w-]+)/.exec(u.pathname);
  if (pub) {
    const gid = u.searchParams.get('gid');
    return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv${gid ? `&gid=${gid}` : ''}`;
  }
  const id = /^\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname);
  if (!id) return null;
  const gid = u.searchParams.get('gid') || /gid=(\d+)/.exec(u.hash)?.[1];
  return `https://docs.google.com/spreadsheets/d/${id[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}
