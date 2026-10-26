import { DurableObject } from 'cloudflare:workers';
import { sendPush } from './webpush.js';

const REMINDER_MINUTES = 20;
const SEND_WINDOW_MS = 5 * 60_000; // only send between T-20 and T-15; never fire stale reminders
const TZ = 'Australia/Sydney';

// Five confirmed MAG2 fixtures recovered so far. The remaining matches must be
// imported from the official schedule (do not invent fixtures).
const SEED_MATCHES = [
  { id: 'mag2-001', at: '2026-10-26T01:00:00.000Z', home: 'QLD', away: 'FN', channel: '4', enabled: true },  // 26 Oct 12:00 AEDT
  { id: 'mag2-002', at: '2026-10-27T00:45:00.000Z', home: 'NT', away: 'QLD', channel: '4', enabled: true },  // 27 Oct 11:45 AEDT
  { id: 'mag2-003', at: '2026-10-28T23:45:00.000Z', home: 'SA', away: 'QLD', channel: '2', enabled: true },  // 29 Oct 10:45 AEDT
  { id: 'mag2-004', at: '2026-10-29T04:45:00.000Z', home: 'QLD', away: 'ACT', channel: '2', enabled: true }, // 29 Oct 15:45 AEDT
  { id: 'mag2-005', at: '2026-10-29T23:45:00.000Z', home: 'QLD', away: 'VIC', channel: '2', enabled: true }, // 30 Oct 10:45 AEDT
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function ready(env) {
  return !!(env.APP_TOKEN && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function tokenOk(req, env) {
  if (!env.APP_TOKEN) return false;
  const a = new TextEncoder().encode(req.headers.get('x-app-token') || '');
  const b = new TextEncoder().encode(env.APP_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

const fmtTime = (iso) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));

/** Single instance that owns all state (strongly consistent, so no duplicate reminders). */
export class Store extends DurableObject {
  async load() {
    const s = this.ctx.storage;
    let matches = await s.get('matches');
    if (!matches) { matches = SEED_MATCHES; await s.put('matches', matches); }
    return {
      matches,
      subscriptions: (await s.get('subscriptions')) || [],
      sent: (await s.get('sent')) || [],
    };
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
    if (!Array.isArray(rows) || rows.length > 150) return { error: 'Expected up to 150 matches' };
    const clean = [];
    for (const [i, r] of rows.entries()) {
      if (!r || !r.home || !r.away || !r.channel || !r.at || !Number.isFinite(Date.parse(r.at)))
        return { error: `Invalid match at row ${i + 1}` };
      clean.push({
        id: String(r.id || crypto.randomUUID()).slice(0, 90),
        at: new Date(r.at).toISOString(),
        home: String(r.home).slice(0, 100),
        away: String(r.away).slice(0, 100),
        channel: String(r.channel).slice(0, 30),
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
    const r = await this.broadcast({ title: 'SSA Match Alerts — 測試通知', body: '推送通知已設定！正式比賽會在開賽前 20 分鐘提醒。', url: '/' });
    await this.log({ type: 'test', ...r });
    return r;
  }

  async tick() {
    await this.ctx.storage.put('lastTick', new Date().toISOString());
    if (!ready(this.env)) return { skipped: 'not configured' };
    const { matches, subscriptions, sent } = await this.load();
    const now = Date.now();
    const results = [];
    // Delayed test: lets you close the app and confirm background delivery.
    const pendingTest = await this.ctx.storage.get('pendingTest');
    if (pendingTest && now >= pendingTest) {
      await this.ctx.storage.delete('pendingTest');
      const r = await this.broadcast({ title: 'SSA Match Alerts — 背景測試 ✅', body: 'App 關閉時都收到通知，正式提醒會一樣送到。', url: '/' });
      await this.log({ type: 'test-delayed', ...r });
    }
    for (const m of matches) {
      const key = `${m.id}|${m.at}`;
      if (!m.enabled || sent.includes(key)) continue;
      const trigger = Date.parse(m.at) - REMINDER_MINUTES * 60_000;
      if (now < trigger || now >= trigger + SEND_WINDOW_MS) continue;
      if (!subscriptions.length) continue;
      const r = await this.broadcast({
        title: `🏀 ${m.home} vs ${m.away}`,
        body: `${REMINDER_MINUTES} 分鐘後開賽 · ${fmtTime(m.at)} · Channel ${m.channel}`,
        url: '/',
      });
      // Retry next minute if nothing got through, until the window closes.
      if (r.delivered > 0) {
        sent.push(key);
        await this.ctx.storage.put('sent', sent.slice(-500));
      }
      await this.log({ type: 'reminder', match: `${m.home} vs ${m.away}`, at: m.at, ...r });
      results.push({ id: m.id, ...r });
    }
    return { results };
  }

  async status() {
    const { matches, subscriptions, sent } = await this.load();
    const now = Date.now();
    const next = matches
      .filter((m) => m.enabled && !sent.includes(`${m.id}|${m.at}`) && Date.parse(m.at) - REMINDER_MINUTES * 60_000 + SEND_WINDOW_MS > now)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] || null;
    return {
      devices: subscriptions.length,
      lastTick: (await this.ctx.storage.get('lastTick')) || null,
      nextReminder: next && { match: `${next.home} vs ${next.away}`, kickoff: next.at, alertAt: new Date(Date.parse(next.at) - REMINDER_MINUTES * 60_000).toISOString() },
      log: ((await this.ctx.storage.get('log')) || []).slice(0, 20),
    };
  }
}

const store = (env) => env.STORE.get(env.STORE.idFromName('main'));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    if (url.pathname === '/api/config' && req.method === 'GET')
      return json({ publicKey: env.VAPID_PUBLIC_KEY || '', timezone: TZ, offsetMinutes: REMINDER_MINUTES, ready: ready(env) });

    if (!tokenOk(req, env)) return json({ error: 'Incorrect access token' }, 401);
    const s = store(env);
    const body = async () => { try { return await req.json(); } catch { return null; } };

    let r;
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/matches': return json(await s.getMatches());
      case 'PUT /api/matches': r = await s.putMatches((await body())?.matches); break;
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
