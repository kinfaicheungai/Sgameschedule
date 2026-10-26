import { DurableObject } from 'cloudflare:workers';
import { sendPush } from './webpush.js';
import { textToTable, parseTable, sheetCsvUrl } from '../public/parse.js';
import { MIGRATION_ID, MIGRATION_MATCHES } from './migration.js';

const SEND_WINDOW_MAX_MS = 5 * 60_000; // send between T-N and T-N+5 min; never fire stale reminders
const AUTO_SYNC_MS = 15 * 60_000;

const DEFAULT_SETTINGS = {
  eyebrow: 'SSA • MAG2',        // small label above the title (event / competition)
  title: 'Match Alerts',
  emoji: '🏀',                  // shown at the start of each reminder
  reminderMinutes: 20,
  timezone: 'Australia/Sydney',
  channelLabel: 'Channel',      // what the 3rd column means: Channel / Court / Venue …
  sheetUrl: '',                 // Google Sheet link (shared "anyone with the link can view")
  autoSync: false,
};

// Five confirmed MAG2 fixtures, used only when storage is empty (first run).
const SEED_MATCHES = [
  { id: 'mag2-001', at: '2026-10-26T01:00:00.000Z', home: 'QLD', away: 'FN', channel: '4', enabled: true },
  { id: 'mag2-002', at: '2026-10-27T00:45:00.000Z', home: 'NT', away: 'QLD', channel: '4', enabled: true },
  { id: 'mag2-003', at: '2026-10-28T23:45:00.000Z', home: 'SA', away: 'QLD', channel: '2', enabled: true },
  { id: 'mag2-004', at: '2026-10-29T04:45:00.000Z', home: 'QLD', away: 'ACT', channel: '2', enabled: true },
  { id: 'mag2-005', at: '2026-10-29T23:45:00.000Z', home: 'QLD', away: 'VIC', channel: '2', enabled: true },
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const ready = (env) => !!(env.APP_TOKEN && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

function tokenOk(req, env) {
  if (!env.APP_TOKEN) return false;
  const a = new TextEncoder().encode(req.headers.get('x-app-token') || '');
  const b = new TextEncoder().encode(env.APP_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-AU', { timeZone: tz }); return true; } catch { return false; }
}

const dayOf = (iso, tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** "今日仲有 N 場（包括呢場）" — matches today (in tz) that haven't kicked off yet, counting this one. */
function remainingToday(matches, m, tz) {
  const day = dayOf(m.at, tz);
  const n = matches.filter((x) => x.enabled && dayOf(x.at, tz) === day && Date.parse(x.at) >= Date.parse(m.at)).length;
  return n <= 1 ? '今日最後一場' : `今日仲有 ${n} 場（包括呢場）`;
}

const fmtTime = (iso, tz) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));

/** Single instance that owns all state (strongly consistent, so no duplicate reminders). */
export class Store extends DurableObject {
  async load() {
    const s = this.ctx.storage;
    let matches = await s.get('matches');
    if (!matches) { matches = SEED_MATCHES; await s.put('matches', matches); }
    if ((await s.get('migration')) !== MIGRATION_ID) {
      matches = MIGRATION_MATCHES;
      await s.put({ matches, sent: [], migration: MIGRATION_ID });
      await this.log({ type: 'sync', count: matches.length, note: MIGRATION_ID });
    }
    return {
      matches,
      subscriptions: (await s.get('subscriptions')) || [],
      sent: (await s.get('sent')) || [],
    };
  }

  async getSettings() {
    return { ...DEFAULT_SETTINGS, ...((await this.ctx.storage.get('settings')) || {}) };
  }

  async putSettings(input) {
    if (!input || typeof input !== 'object') return { error: 'Invalid settings' };
    const cur = await this.getSettings();
    const next = { ...cur };
    if (input.eyebrow !== undefined) next.eyebrow = String(input.eyebrow).slice(0, 60);
    if (input.title !== undefined) next.title = String(input.title).trim().slice(0, 60) || DEFAULT_SETTINGS.title;
    if (input.emoji !== undefined) next.emoji = String(input.emoji).trim().slice(0, 8);
    if (input.channelLabel !== undefined) next.channelLabel = String(input.channelLabel).trim().slice(0, 20) || DEFAULT_SETTINGS.channelLabel;
    if (input.reminderMinutes !== undefined) {
      const n = Math.round(Number(input.reminderMinutes));
      if (!(n >= 1 && n <= 180)) return { error: '提醒分鐘要喺 1–180 之間' };
      next.reminderMinutes = n;
    }
    if (input.timezone !== undefined) {
      if (!validTz(input.timezone)) return { error: '時區無效' };
      next.timezone = input.timezone;
    }
    if (input.sheetUrl !== undefined) {
      const u = String(input.sheetUrl).trim();
      if (u && !sheetCsvUrl(u)) return { error: 'Google Sheet 連結無效' };
      next.sheetUrl = u;
    }
    if (input.autoSync !== undefined) next.autoSync = !!input.autoSync;
    await this.ctx.storage.put('settings', next);
    return { ok: true, settings: next };
  }

  async log(entry) {
    const log = (await this.ctx.storage.get('log')) || [];
    log.unshift({ t: new Date().toISOString(), ...entry });
    await this.ctx.storage.put('log', log.slice(0, 60));
  }

  async getMatches() {
    const { matches } = await this.load();
    return matches.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  async putMatches(rows) {
    if (!Array.isArray(rows) || rows.length > 500) return { error: 'Expected up to 500 matches' };
    const clean = [];
    for (const [i, r] of rows.entries()) {
      if (!r || !r.home || !r.at || !Number.isFinite(Date.parse(r.at)))
        return { error: `Invalid match at row ${i + 1}` };
      clean.push({
        id: String(r.id || crypto.randomUUID()).slice(0, 90),
        at: new Date(r.at).toISOString(),
        home: String(r.home).slice(0, 100),
        away: String(r.away || '').slice(0, 100),
        channel: String(r.channel ?? '').slice(0, 30),
        note: String(r.note ?? '').slice(0, 120),
        enabled: r.enabled !== false,
      });
    }
    if (new Set(clean.map((r) => r.id)).size !== clean.length) return { error: 'Duplicate match IDs' };
    const { sent } = await this.load();
    // "sent" keys include the kickoff time, so moving a match re-arms its reminder.
    const keys = new Set(clean.map((m) => `${m.id}|${m.at}`));
    await this.ctx.storage.put({ matches: clean, sent: sent.filter((k) => keys.has(k)) });
    return { ok: true, count: clean.length };
  }

  /** Pull the schedule from the configured Google Sheet. Never wipes the schedule on a bad read. */
  async syncSheet({ auto = false } = {}) {
    const settings = await this.getSettings();
    const csvUrl = sheetCsvUrl(settings.sheetUrl);
    if (!csvUrl) return { error: '未設定 Google Sheet 連結' };
    await this.ctx.storage.put('lastSyncAttempt', Date.now());
    let text;
    try {
      const res = await fetch(csvUrl, { redirect: 'follow', headers: { accept: 'text/csv' } });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || type.includes('text/html')) {
        const r = { error: `讀唔到 Google Sheet（${res.status}）。請將 Sheet 設定為「知道連結的任何人都可以檢視」。` };
        await this.log({ type: 'sync', auto, ...r });
        return r;
      }
      text = await res.text();
    } catch (e) {
      const r = { error: '連接 Google Sheet 失敗：' + e.message };
      await this.log({ type: 'sync', auto, ...r });
      return r;
    }
    const { matches, errors } = parseTable(textToTable(text), { tz: settings.timezone });
    if (!matches.length) {
      const r = { error: '讀唔到任何比賽：' + errors.slice(0, 3).join('；') };
      await this.log({ type: 'sync', auto, ...r });
      return r;
    }
    const before = JSON.stringify(await this.getMatches());
    const saved = await this.putMatches(matches);
    if (saved.error) return saved;
    const changed = before !== JSON.stringify(await this.getMatches());
    await this.ctx.storage.put('lastSync', { t: new Date().toISOString(), count: matches.length, skipped: errors.length });
    if (changed || !auto) await this.log({ type: 'sync', auto, count: matches.length, skipped: errors.length, changed });
    return { ok: true, count: matches.length, errors, changed };
  }

  async subscribe(sub, origin) {
    if (origin) await this.ctx.storage.put('origin', origin);
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth || !(/^https:\/\//.test(sub.endpoint) || (this.env.ALLOW_INSECURE_PUSH === '1' && /^http:\/\/127\.0\.0\.1[:/]/.test(sub.endpoint))))
      return { error: 'Invalid push subscription' };
    const { subscriptions } = await this.load();
    const next = subscriptions.filter((x) => x.endpoint !== sub.endpoint);
    next.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: new Date().toISOString() });
    await this.ctx.storage.put('subscriptions', next.slice(-20));
    await this.log({ type: 'subscribe', devices: next.length });
    return { ok: true, devices: next.length };
  }

  async broadcast(payload) {
    const { subscriptions } = await this.load();
    // VAPID "sub" claim: explicit VAPID_SUBJECT, else this site's own https URL.
    const subject = this.env.VAPID_SUBJECT || (await this.ctx.storage.get('origin')) || 'mailto:admin@example.com';
    const env = { ...this.env, VAPID_SUBJECT: subject };
    let delivered = 0, failed = 0;
    const keep = [];
    for (const sub of subscriptions) {
      try {
        const r = await sendPush(sub, payload, env);
        if (r.ok) { delivered++; keep.push(sub); }
        else {
          failed++;
          if (r.status === 404 || r.status === 410) continue; // subscription expired: drop it
          keep.push(sub);
          console.error('Push failed', r.status, r.detail);
        }
      } catch (e) { failed++; keep.push(sub); console.error('Push error', e); }
    }
    await this.ctx.storage.put('subscriptions', keep);
    return { delivered, failed, subscriptions: keep.length };
  }

  async test(delayMinutes = 0) {
    if (delayMinutes > 0) {
      const at = Date.now() + Math.min(delayMinutes, 30) * 60_000;
      await this.ctx.storage.put('pendingTest', at);
      await this.log({ type: 'test-scheduled', for: new Date(at).toISOString() });
      return { scheduled: new Date(at).toISOString() };
    }
    const { reminderMinutes } = await this.getSettings();
    const r = await this.broadcast({ title: 'Match Alerts — 測試通知', body: `推送通知已設定！正式比賽會在開賽前 ${reminderMinutes} 分鐘提醒。`, url: '/' });
    await this.log({ type: 'test', ...r });
    return r;
  }

  async tick() {
    await this.ctx.storage.put('lastTick', new Date().toISOString());
    if (!ready(this.env)) return { skipped: 'not configured' };
    const settings = await this.getSettings();
    const { matches, subscriptions, sent } = await this.load();
    const now = Date.now();
    const lead = settings.reminderMinutes * 60_000;
    const windowMs = Math.min(SEND_WINDOW_MAX_MS, lead);
    const results = [];

    // Delayed test: lets you close the app and confirm background delivery.
    const pendingTest = await this.ctx.storage.get('pendingTest');
    if (pendingTest && now >= pendingTest) {
      await this.ctx.storage.delete('pendingTest');
      const r = await this.broadcast({ title: 'Match Alerts — 背景測試 ✅', body: 'App 關閉時都收到通知，正式提醒會一樣送到。', url: '/' });
      await this.log({ type: 'test-delayed', ...r });
    }

    // Reminders first: they must never be delayed by a slow sheet sync.
    for (const m of matches) {
      const key = `${m.id}|${m.at}`;
      if (!m.enabled || sent.includes(key)) continue;
      const trigger = Date.parse(m.at) - lead;
      if (now < trigger || now >= trigger + windowMs) continue;
      if (!subscriptions.length) continue;
      const teams = m.away ? `${m.home} vs ${m.away}` : m.home;
      const where = m.channel ? ` · ${settings.channelLabel} ${m.channel}` : '';
      const r = await this.broadcast({
        title: `${settings.emoji ? settings.emoji + ' ' : ''}${teams}`,
        body: `${settings.reminderMinutes} 分鐘後開賽 · ${fmtTime(m.at, settings.timezone)}${where}${m.note ? ' · ' + m.note : ''}\n${remainingToday(matches, m, settings.timezone)}`,
        url: '/',
      });
      // Retry next minute if nothing got through, until the window closes.
      if (r.delivered > 0) {
        sent.push(key);
        await this.ctx.storage.put('sent', sent.slice(-1000));
      }
      await this.log({ type: 'reminder', match: teams, at: m.at, ...r });
      results.push({ id: m.id, ...r });
    }

    if (settings.autoSync && settings.sheetUrl) {
      const last = (await this.ctx.storage.get('lastSyncAttempt')) || 0;
      if (now - last >= AUTO_SYNC_MS) {
        try { await this.syncSheet({ auto: true }); } catch (e) { console.error('Auto sync failed', e); }
      }
    }
    return { results };
  }

  async status() {
    const settings = await this.getSettings();
    const { matches, subscriptions, sent } = await this.load();
    const now = Date.now();
    const lead = settings.reminderMinutes * 60_000;
    const windowMs = Math.min(SEND_WINDOW_MAX_MS, lead);
    const next = matches
      .filter((m) => m.enabled && !sent.includes(`${m.id}|${m.at}`) && Date.parse(m.at) - lead + windowMs > now)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] || null;
    return {
      devices: subscriptions.length,
      lastTick: (await this.ctx.storage.get('lastTick')) || null,
      lastSync: (await this.ctx.storage.get('lastSync')) || null,
      nextReminder: next && { match: next.away ? `${next.home} vs ${next.away}` : next.home, kickoff: next.at, alertAt: new Date(Date.parse(next.at) - lead).toISOString() },
      log: ((await this.ctx.storage.get('log')) || []).slice(0, 20),
    };
  }
}

const store = (env) => env.STORE.get(env.STORE.idFromName('main'));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const s = store(env);

    if (url.pathname === '/api/config' && req.method === 'GET') {
      const st = await s.getSettings();
      return json({
        publicKey: env.VAPID_PUBLIC_KEY || '', ready: ready(env),
        timezone: st.timezone, offsetMinutes: st.reminderMinutes,
        eyebrow: st.eyebrow, title: st.title, emoji: st.emoji, channelLabel: st.channelLabel,
      });
    }

    if (!tokenOk(req, env)) return json({ error: 'Incorrect access token' }, 401);
    const body = async () => { try { return await req.json(); } catch { return null; } };

    let r;
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/matches': return json(await s.getMatches());
      case 'PUT /api/matches': r = await s.putMatches((await body())?.matches); break;
      case 'GET /api/settings': return json(await s.getSettings());
      case 'PUT /api/settings': r = await s.putSettings(await body()); break;
      case 'POST /api/sync': r = await s.syncSheet(); break;
      case 'POST /api/subscribe': r = await s.subscribe(await body(), url.origin); break;
      case 'POST /api/test':
        if (!env.VAPID_PRIVATE_KEY) return json({ error: 'Push keys missing' }, 503);
        r = await s.test(Number(url.searchParams.get('delay')) || 0); break;
      case 'GET /api/status': r = await s.status(); break;
      default: return json({ error: 'Not found' }, 404);
    }
    return json(r, r?.error ? 400 : 200);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(store(env).tick());
  },
};
