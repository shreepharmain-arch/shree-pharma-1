// Shree Pharma: website + private email dashboard on one Cloudflare Worker.
import loginPage from './ui/login.html';
import appPage from './ui/app.html';
import { ensureSchema, getSettings, setSettings, log, counter, bump, EDITABLE, DEFAULT_TEMPLATES } from './db.js';
import { Gmail, GmailAuthError, BudgetError, oauthStartUrl, exchangeCode, googleUrls, buildMime, textToHtml } from './gmail.js';
import {
  STATUS, PENDING, HAS_DRAFT, MANUAL_STATUSES, effective, dailyLimit, createDrafts, sendQueued, checkReplies, syncDrafts,
  closeLead, sendAlert, compose, runCron, sentTodayKey
} from './engine.js';
import { pushAll, vapidKeys, validSubscription, SERVICE_WORKER, MAX_DEVICES } from './push.js';
import {
  json, html, redirect, getCookie, hmacHex, sha256Hex, safeEqual, randomHex, cleanEmail, firstName, clip, esc, istDay, isYes, DAY
} from './util.js';

const SESSION_COOKIE = 'sp_s';
const OAUTH_COOKIE = 'sp_o';
const ph = n => Array(n).fill('?').join(',');

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error(e);
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) {
        if (e instanceof GmailAuthError) return json({ error: e.message, gmailProblem: true }, 409);
        return json({ error: 'Something went wrong: ' + (e.message || 'unknown error') }, 500);
      }
      return html(simplePage('Something went wrong', '<p>' + esc(e.message || 'Unknown error') + '</p><p><a href="/app">Back to dashboard</a></p>'), 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env).catch(e => console.error('cron failed', e)));
  }
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = request.method;

  if (p === '/api/enquiry') {
    if (m !== 'POST') return json({ error: 'Use POST' }, 405, { allow: 'POST' });
    await ensureSchema(env);
    return publicEnquiry(request, env, ctx);
  }
  if (p.startsWith('/u/')) { await ensureSchema(env); return unsubscribe(request, env, p.slice(3)); }
  if (p === '/app/manifest.webmanifest') return manifest();
  if (p === '/app/sw.js') {
    return new Response(SERVICE_WORKER, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'service-worker-allowed': '/app' } });
  }
  if (p === '/app' || p.startsWith('/app/')) { await ensureSchema(env); return appRoutes(request, env, url, p, m); }
  if (p.startsWith('/api/')) { await ensureSchema(env); return api(request, env, url, p, m); }

  // Everything else is the public website
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) return res;
    const nf = await env.ASSETS.fetch(new Request(url.origin + '/404', { headers: request.headers }));
    if (nf.ok) return new Response(nf.body, { status: 404, headers: nf.headers });
  }
  return html(simplePage('Page not found', '<p><a href="/">Go to the home page</a></p>'), 404);
}

// Google keys count only once real values are pasted in (the setup uses "add-later" as a stand-in)
function googleKeysReady(env) {
  const id = String(env.GOOGLE_CLIENT_ID || '').trim(), secret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!id || !secret || /add.?later/i.test(id) || /add.?later/i.test(secret)) return false;
  return /\.apps\.googleusercontent\.com$/.test(id) || !!env.GOOGLE_AUTH_URL;
}

/* ---------------- login ---------------- */

async function sessionValue(env, exp) {
  return exp + '.' + (await hmacHex('session|' + env.ADMIN_PASSWORD, String(exp)));
}
async function isAuthed(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const [exp, sig] = getCookie(request, SESSION_COOKIE).split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const good = await sessionValue(env, exp);
  return safeEqual(exp + '.' + sig, good);
}
const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

function renderLogin(error, notice) {
  return loginPage
    .replace('{{ERROR}}', error ? '<div class="alert err" role="alert">' + esc(error) + '</div>' : '')
    .replace('{{NOTICE}}', notice ? '<div class="alert info">' + notice + '</div>' : '');
}

function clientIp(request) { return request.headers.get('cf-connecting-ip') || 'local'; }
const hourKey = () => new Date().toISOString().slice(0, 13);

async function appRoutes(request, env, url, p, m) {
  if (p === '/app/login') {
    if (!env.ADMIN_PASSWORD) {
      return html(renderLogin('', 'Setup is not finished: add a secret named <b>ADMIN_PASSWORD</b> to this Worker in Cloudflare (Settings &gt; Variables and Secrets), then reload this page.'));
    }
    if (String(env.ADMIN_PASSWORD).length < 10) {
      return html(renderLogin('', 'Your ADMIN_PASSWORD is too short. In Cloudflare, change it to at least 10 characters (Settings &gt; Variables and Secrets), then reload this page.'));
    }
    if (m === 'GET') return (await isAuthed(request, env)) ? redirect('/app') : html(renderLogin('', ''));
    if (m !== 'POST') return html(renderLogin('', ''), 405);
    const ipKey = 'login:' + clientIp(request) + ':' + hourKey();
    const allKey = 'login:all:' + hourKey();
    if ((await counter(env, ipKey)) >= 8 || (await counter(env, allKey)) >= 60) {
      return html(renderLogin('Too many wrong attempts. Wait an hour and try again.', ''), 429);
    }
    const form = await request.formData().catch(() => null);
    const pw = form ? String(form.get('password') || '') : '';
    const ok = safeEqual(await sha256Hex(pw), await sha256Hex(env.ADMIN_PASSWORD));
    if (!ok) {
      await bump(env, ipKey); await bump(env, allKey);
      await log(env, 'Login failed', '', clientIp(request));
      return html(renderLogin('That password is not right. Try again.', ''), 401);
    }
    const exp = Date.now() + 30 * DAY;
    return redirect('/app', { 'set-cookie': cookie(SESSION_COOKIE, await sessionValue(env, exp), 30 * 86400) });
  }
  if (p === '/app/logout') return redirect('/app/login', { 'set-cookie': cookie(SESSION_COOKIE, '', 0) });

  if (!(await isAuthed(request, env))) return redirect('/app/login');

  if (p === '/app') {
    return html(appPage, 200, { 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  }
  if (p === '/app/oauth/start') {
    if (!googleKeysReady(env)) {
      return html(simplePage('Google keys missing', '<p>Add the secrets <b>GOOGLE_CLIENT_ID</b> and <b>GOOGLE_CLIENT_SECRET</b> to this Worker in Cloudflare first (see the setup guide, Part 4).</p><p><a href="/app#settings">Back to Settings</a></p>'));
    }
    const state = randomHex(16);
    return redirect(oauthStartUrl(env, url.origin, state), { 'set-cookie': cookie(OAUTH_COOKIE, state, 900) });
  }
  if (p === '/app/oauth/callback') return oauthCallback(request, env, url);
  return redirect('/app');
}

async function oauthCallback(request, env, url) {
  const back = '<p><a href="/app#settings">Back to Settings</a></p>';
  const err = url.searchParams.get('error');
  if (err) return html(simplePage('Gmail was not connected', '<p>Google said: ' + esc(err) + '. Nothing was changed.</p>' + back));
  const state = url.searchParams.get('state') || '';
  const expect = getCookie(request, OAUTH_COOKIE);
  if (!expect || !safeEqual(state, expect)) return html(simplePage('Please try again', '<p>The sign-in took too long or was opened in a different browser. Tap Connect Gmail again.</p>' + back), 400);
  const code = url.searchParams.get('code') || '';
  const tok = await exchangeCode(env, url.origin, code);
  if (!tok.refresh_token) {
    return html(simplePage('Google did not give lasting access',
      '<p>Open <b>myaccount.google.com/permissions</b> while signed in to your outreach Gmail, remove <b>Shree Pharma</b>, then tap Connect Gmail again.</p>' + back));
  }
  const pr = await fetch(googleUrls(env).api + '/profile', { headers: { authorization: 'Bearer ' + tok.access_token } });
  const profile = await pr.json().catch(() => ({}));
  if (!pr.ok || !profile.emailAddress) return html(simplePage('Could not read the Gmail address', '<p>Make sure the Gmail API is enabled in your Google Cloud project, then try again.</p>' + back), 502);
  await setSettings(env, {
    gmail_refresh: tok.refresh_token,
    gmail_access: tok.access_token,
    gmail_access_exp: String(Date.now() + (Number(tok.expires_in) || 3600) * 1000),
    gmail_email: profile.emailAddress.toLowerCase(),
    gmail_status: '',
    replies_cursor: String(Math.floor(Date.now() / 1000) - 3600)
  });
  await log(env, 'Gmail connected', profile.emailAddress, '');
  return redirect('/app#settings', { 'set-cookie': cookie(OAUTH_COOKIE, '', 0) });
}

/* ---------------- private API ---------------- */

async function readJson(request, max = 1_500_000) {
  const t = await request.text();
  if (t.length > max) throw Object.assign(new Error('Request too large'), { status: 413 });
  try { return t ? JSON.parse(t) : {}; } catch (e) { throw Object.assign(new Error('Bad request'), { status: 400 }); }
}

async function api(request, env, url, p, m) {
  if (!(await isAuthed(request, env))) return json({ error: 'Please log in again.', login: true }, 401);
  if (request.headers.get('x-sp') !== '1') return json({ error: 'Blocked' }, 403);
  const origin = request.headers.get('origin');
  if (m !== 'GET' && origin && origin !== url.origin) return json({ error: 'Blocked' }, 403);

  const s = effective(await getSettings(env));
  const gmail = budget => new Gmail(env, s, budget);
  try {
    const body = m === 'POST' ? await readJson(request) : {};
    switch (m + ' ' + p) {
      case 'GET /api/summary': return json(await summary(env, s, url));
      case 'GET /api/leads': return json(await listLeads(env, url));
      case 'GET /api/lead': return json(await getLead(env, url, s));
      case 'POST /api/lead': return json(await updateLead(env, s, body, gmail(6)));
      case 'POST /api/import': return json(await importLeads(env, body));
      case 'POST /api/drafts': return json(await apiDrafts(env, s, gmail(40)));
      case 'POST /api/approve': return json(await approve(env, s, body, gmail(14)));
      case 'POST /api/skip': return json(await skip(env, body, s.gmail_email ? gmail(40) : null));
      case 'POST /api/replies': {
        const gm = gmail(40);
        const r = await checkReplies(env, gm, s, 15);
        const synced = await syncDrafts(env, gm, s, 4).catch(e => { if (e instanceof GmailAuthError) throw e; return 0; });
        return json({ ...r, fresh: undefined, synced });
      }
      case 'GET /api/settings': return json(settingsView(s, url, env));
      case 'POST /api/settings': return json(await saveSettings(env, body));
      case 'POST /api/test-email': return json(await testEmail(env, s, gmail(6)));
      case 'POST /api/gmail/disconnect':
        await setSettings(env, { gmail_refresh: '', gmail_access: '', gmail_access_exp: '0', gmail_email: '', gmail_status: '' });
        await log(env, 'Gmail disconnected', '', '');
        return json({ ok: true });
      case 'GET /api/enquiries': return json(await listEnquiries(env, url));
      case 'POST /api/enquiry-status': return json(await enquiryStatus(env, body));
      case 'GET /api/export': return json(await exportLeads(env, url));
      case 'GET /api/push': return json(await pushStatus(env, s));
      case 'POST /api/push/subscribe': return json(await pushSubscribe(env, body));
      case 'POST /api/push/unsubscribe': {
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(String(body.endpoint || '')).run();
        await log(env, 'Notifications turned off', '', clip(body.label, 60));
        return json({ ok: true });
      }
      case 'POST /api/push/test': {
        const r = await pushAll(env, { title: 'Shree Pharma notifications work', body: 'You will get a pop-up like this for buyer replies, website requests and drafts ready to approve.', url: '/app#settings', tag: 'test' }, s);
        if (!r.devices) throw bad('No device has notifications turned on yet.');
        if (!r.sent) throw bad('The notification could not be delivered. Turn notifications off and on again on this device.');
        return json(r);
      }
      case 'GET /api/quotes': return json(await listQuotes(env, url, s));
      case 'POST /api/quotes': return json(await createQuote(env, s, body));
      case 'GET /api/log': {
        const { results } = await env.DB.prepare('SELECT at, action, email, detail FROM log ORDER BY id DESC LIMIT 60').all();
        return json({ log: results });
      }
      default: return json({ error: 'Not found' }, 404);
    }
  } catch (e) {
    if (e instanceof GmailAuthError) return json({ error: e.message, gmailProblem: true }, 409);
    if (e instanceof BudgetError) return json({ error: 'Done part of the work. Tap again to continue.' }, 200);
    if (e.status === 400 || e.status === 413) return json({ error: e.message }, e.status);
    if (e.status) return json({ error: 'Gmail said: ' + e.message }, 502);
    throw e;
  }
}

async function summary(env, s, url) {
  // remember where the dashboard lives, so email links and unsubscribe links point to the right address
  // A custom domain always wins over the free workers.dev address once it has been used.
  const o = url.origin;
  const kind = h => (/^(localhost|127\.0\.0\.1)$/.test(h) ? 0 : /\.workers\.dev$/.test(h) ? 1 : 2);
  const prevHost = s.app_origin ? new URL(s.app_origin).hostname : '';
  if (s.app_origin !== o && (!prevHost || kind(url.hostname) >= kind(prevHost))) {
    await setSettings(env, { app_origin: o });
    s = effective({ ...s, app_origin: o });
  }
  const [counts, ready, replies, enq, logRows, sentToday] = await Promise.all([
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status').all(),
    env.DB.prepare(`SELECT id, email, first_name, company, country, status, draft_subject FROM leads WHERE status IN ('drafted','fu_drafted') ORDER BY status DESC, id LIMIT 300`).all(),
    env.DB.prepare(`SELECT id, email, company, country, status, thread_id, replied_at, reply_snippet FROM leads WHERE replied_at IS NOT NULL ORDER BY replied_at DESC LIMIT 15`).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM enquiries WHERE status = 'new'`).first(),
    env.DB.prepare('SELECT at, action, email, detail FROM log ORDER BY id DESC LIMIT 12').all(),
    counter(env, sentTodayKey())
  ]);
  const byStatus = {};
  for (const r of counts.results) byStatus[r.status] = Number(r.n);
  const queued = (byStatus.queued || 0) + (byStatus.fu_queued || 0) + (byStatus.sending || 0) + (byStatus.fu_sending || 0);
  const warnings = [];
  if (!s.address) warnings.push('Add your business postal address in Settings. US law requires one in marketing emails.');
  if (!s.website && /\.workers\.dev$/.test(s.origin || '')) warnings.push('Emails link to your free Cloudflare address. Once your domain is live, open the dashboard from your domain once and links switch over by themselves.');
  return {
    statuses: STATUS,
    byStatus,
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    sentToday,
    limit: dailyLimit(s),
    queued,
    paused: isYes(s.paused),
    gmail: { email: s.gmail_email || '', problem: s.gmail_status || '', connected: !!(s.gmail_refresh && s.gmail_email) },
    ready: ready.results,
    replies: replies.results,
    newEnquiries: enq ? Number(enq.n) : 0,
    log: logRows.results,
    warnings
  };
}

async function listLeads(env, url) {
  const q = clip(url.searchParams.get('q'), 100).toLowerCase();
  const status = clip(url.searchParams.get('status'), 30);
  const country = clip(url.searchParams.get('country'), 80);
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const where = [], args = [];
  if (q) { where.push('(email LIKE ? OR LOWER(company) LIKE ? OR LOWER(first_name) LIKE ?)'); args.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  if (status) {
    if (status === 'pending') { where.push(`status IN (${ph(PENDING.length)})`); args.push(...PENDING); }
    else { where.push('status = ?'); args.push(status); }
  }
  if (country) { where.push('country = ?'); args.push(country); }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const per = 50;
  const [rows, total] = await Promise.all([
    env.DB.prepare(`SELECT id, email, first_name, company, country, status, sent_at, replied_at, updated_at FROM leads${w} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...args, per, (page - 1) * per).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM leads${w}`).bind(...args).first()
  ]);
  let countries;
  if (page === 1) {
    countries = (await env.DB.prepare(`SELECT country, COUNT(*) AS n FROM leads WHERE country <> '' GROUP BY country ORDER BY n DESC LIMIT 150`).all()).results;
  }
  return { rows: rows.results, total: total ? Number(total.n) : 0, page, per, countries };
}

async function getLead(env, url, s) {
  const id = parseInt(url.searchParams.get('id'), 10);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(id || 0).first();
  if (!lead) throw Object.assign(new Error('Lead not found'), { status: 400 });
  delete lead.unsub_token;
  lead.gmailLink = lead.thread_id && s.gmail_email ? 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(s.gmail_email) + '#all/' + lead.thread_id : '';
  lead.manual = MANUAL_STATUSES.filter(x => x !== 'new' || !lead.sent_at);
  return { lead };
}

async function updateLead(env, s, b, gm) {
  const id = parseInt(b.id, 10);
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(id || 0).first();
  if (!lead) throw Object.assign(new Error('Lead not found'), { status: 400 });
  const set = {};
  for (const [k, n] of [['first_name', 80], ['company', 200], ['country', 80], ['phone', 60], ['business_type', 120], ['notes', 2000]]) {
    if (typeof b[k] === 'string') set[k] = clip(b[k], n);
  }
  if (b.status && b.status !== lead.status) {
    if (MANUAL_STATUSES.indexOf(b.status) < 0) throw Object.assign(new Error('That status cannot be set by hand'), { status: 400 });
    if (b.status === 'new' && lead.sent_at) throw Object.assign(new Error('This lead was already emailed, so it cannot go back to New.'), { status: 400 });
    if (['drafting', 'sending', 'fu_drafting', 'fu_sending'].indexOf(lead.status) >= 0) throw Object.assign(new Error('This lead is being processed right now. Try again in a minute.'), { status: 400 });
    if (HAS_DRAFT.indexOf(lead.status) >= 0 && lead.draft_id) {
      if (s.gmail_email) { try { await gm.deleteDraft(lead.draft_id); } catch (e) { if (e instanceof GmailAuthError) throw e; } }
      set.draft_id = null;
    }
    set.status = b.status;
    if (b.status === 'replied' && !lead.replied_at) set.replied_at = Date.now();
  }
  const keys = Object.keys(set);
  if (!keys.length) return { ok: true };
  set.updated_at = Date.now();
  const cols = Object.keys(set);
  await env.DB.prepare(`UPDATE leads SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`).bind(...cols.map(c => set[c]), id).run();
  if (set.status) await log(env, 'Status changed', lead.email, (STATUS[lead.status] || lead.status) + ' → ' + (STATUS[set.status] || set.status));
  return { ok: true };
}

async function importLeads(env, b) {
  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 100) : [];
  const source = clip(b.source || 'CSV', 120);
  const defCountry = clip(b.country, 80);
  const now = Date.now();
  const stmts = [];
  let invalid = 0;
  const seen = new Set();
  for (const r of rows) {
    const email = cleanEmail(r && r.email);
    if (!email) { invalid++; continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO leads(email, first_name, company, country, business_type, phone, website, source, status, unsub_token, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)`
    ).bind(email, firstName(r.firstName || r.name || ''), clip(r.company, 200), clip(r.country || defCountry, 80), clip(r.type, 120),
      clip(r.phone, 60), clip(r.website, 200), source, randomHex(16), now, now));
  }
  let added = 0;
  if (stmts.length) {
    const res = await env.DB.batch(stmts);
    for (const x of res) added += (x.meta && x.meta.changes) || 0;
  }
  const dupes = rows.length - invalid - added;
  if (b.last) await log(env, 'Import', '', source + (b.totals ? ': ' + b.totals : ''));
  return { added, dupes, invalid };
}

async function apiDrafts(env, s, gm) {
  if (!s.gmail_email) return { created: 0, message: 'Connect Gmail in Settings first.' };
  const r = await createDrafts(env, gm, s, 12);
  if (r.created) return { ...r, message: r.created + ' draft(s) created in Gmail' + (r.followups ? ', including ' + r.followups + ' follow-up(s)' : '') + '.' };
  const fresh = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status = 'new'`).first();
  if (!fresh || !Number(fresh.n)) return { ...r, message: 'No new leads left to email. Import more leads.' };
  return { ...r, message: 'Today\'s limit is already covered by drafts waiting or emails sent. Approve or skip the waiting drafts, or raise the daily limit in Settings.' };
}

async function approve(env, s, b, gm) {
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 300);
  if (!ids.length) return { queued: 0, sentNow: 0 };
  // Cloudflare's database accepts at most 100 values per query, so approve in chunks
  let queued = 0;
  const now = Date.now();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    const r = await env.DB.prepare(
      `UPDATE leads SET status = CASE status WHEN 'drafted' THEN 'queued' ELSE 'fu_queued' END, updated_at = ?
       WHERE id IN (${ph(part.length)}) AND status IN ('drafted', 'fu_drafted')`).bind(now, ...part).run();
    queued += (r.meta && r.meta.changes) || 0;
  }
  await log(env, 'Approved', '', queued + ' email(s)');
  let sentNow = 0;
  if (!isYes(s.paused) && s.gmail_email) {
    try { sentNow = await sendQueued(env, gm, s, 3); } catch (e) { if (!(e instanceof BudgetError)) throw e; }
  }
  const left = dailyLimit(s) - (await counter(env, sentTodayKey()));
  return { queued, sentNow, paused: isYes(s.paused), leftToday: Math.max(0, left) };
}

async function skip(env, b, gm) {
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 30);
  if (!ids.length) return { skipped: 0 };
  const { results } = await env.DB.prepare(`SELECT * FROM leads WHERE id IN (${ph(ids.length)}) AND status IN ('drafted','fu_drafted','queued','fu_queued')`).bind(...ids).all();
  let n = 0;
  for (const lead of results) {
    await closeLead(env, gm, lead, lead.status.startsWith('fu_') ? 'no_reply' : 'skipped', { note: 'Skipped by you' });
    n++;
  }
  if (n) await log(env, 'Skipped', '', n + ' lead(s)');
  return { skipped: n };
}

const SETTING_RULES = {
  your_name: v => clip(v, 80),
  company_name: v => clip(v, 120),
  whatsapp: v => clip(v, 40),
  address: v => clip(v, 300).replace(/\s*\n\s*/g, ', '),
  website: v => { v = clip(v, 200); if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw bad('Website must start with https://'); return v; },
  brochure_link: v => { v = clip(v, 500); if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw bad('Brochure link must start with https://'); return v; },
  alert_email: v => { if (!String(v || '').trim()) return ''; const e = cleanEmail(v); if (!e) throw bad('Alert email is not a valid email address'); return e; },
  daily_limit: v => { const n = parseInt(v, 10); if (!(n >= 1 && n <= 150)) throw bad('Daily limit must be between 1 and 150'); return String(n); },
  followup_days: v => { const n = parseInt(v, 10); if (!(n >= 1 && n <= 30)) throw bad('Follow-up days must be between 1 and 30'); return String(n); },
  stop_days: v => { const n = parseInt(v, 10); if (!(n >= 1 && n <= 60)) throw bad('Stop-watching days must be between 1 and 60'); return String(n); },
  auto_drafts: v => (isYes(v) ? 'yes' : 'no'),
  paused: v => (isYes(v) ? 'yes' : 'no'),
  tpl_first_subject: v => { v = String(v || '').replace(/[\r\n]+/g, ' ').trim(); if (!v) throw bad('The subject cannot be empty'); return v.slice(0, 200); },
  tpl_first_body: v => { v = String(v || '').trim(); if (!v) throw bad('The first email cannot be empty'); return v.slice(0, 10000); },
  tpl_fu_body: v => { v = String(v || '').trim(); if (!v) throw bad('The follow-up email cannot be empty'); return v.slice(0, 10000); }
};
function bad(msg) { return Object.assign(new Error(msg), { status: 400 }); }

function settingsView(s, url, env) {
  const values = {};
  for (const k of Object.keys(EDITABLE)) values[k] = s[k];
  return {
    values,
    defaults: DEFAULT_TEMPLATES,
    gmail: { email: s.gmail_email || '', problem: s.gmail_status || '', connected: !!(s.gmail_refresh && s.gmail_email) },
    googleKeys: googleKeysReady(env),
    redirectUri: url.origin + '/app/oauth/callback',
    origin: s.origin,
    autoWebsite: s.websiteUrl,
    autoBrochure: s.brochureUrl,
    placeholders: ['FirstName', 'Company', 'Country', 'YourName', 'CompanyName', 'WhatsApp', 'Website', 'BrochureLink', 'Address', 'UnsubscribeLink']
  };
}

async function saveSettings(env, b) {
  const out = {};
  for (const [k, fn] of Object.entries(SETTING_RULES)) if (k in b) out[k] = fn(b[k]);
  for (const k of ['tpl_first_subject', 'tpl_first_body', 'tpl_fu_body']) {
    if (out[k]) {
      const unknown = (out[k].match(/\{\{\s*(\w+)\s*\}\}/g) || []).map(x => x.replace(/[{}\s]/g, ''))
        .filter(x => ['FirstName', 'Company', 'Country', 'YourName', 'CompanyName', 'WhatsApp', 'Website', 'BrochureLink', 'Address', 'UnsubscribeLink'].indexOf(x) < 0);
      if (unknown.length) throw bad('Unknown placeholder in a template: {{' + unknown[0] + '}}. Check the spelling.');
    }
  }
  await setSettings(env, out);
  if ('paused' in out) await log(env, out.paused === 'yes' ? 'Sending paused' : 'Sending resumed', '', '');
  else await log(env, 'Settings saved', '', Object.keys(out).join(', ').slice(0, 300));
  return { ok: true };
}

async function testEmail(env, s, gm) {
  if (!s.gmail_email) throw bad('Connect Gmail first.');
  const to = s.alert_email || s.gmail_email;
  const sample = { email: to, first_name: 'Shivam', company: 'Sample Pharma Ltd', country: 'United Kingdom', unsub_token: 'test' };
  const c = compose(sample, 'first', s);
  const raw = buildMime({ from: s.gmail_email, fromName: [s.your_name, s.company_name].filter(Boolean).join(' | '), to, subject: '[TEST] ' + c.subject, text: c.text, html: textToHtml(c.text) });
  await gm.sendMessage(raw);
  await log(env, 'Test email sent', to, '');
  return { ok: true, to };
}

async function listEnquiries(env, url) {
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const per = 30;
  const [rows, total] = await Promise.all([
    env.DB.prepare('SELECT * FROM enquiries ORDER BY id DESC LIMIT ? OFFSET ?').bind(per, (page - 1) * per).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM enquiries').first()
  ]);
  return { rows: rows.results, total: total ? Number(total.n) : 0, page, per };
}

async function enquiryStatus(env, b) {
  const st = String(b.status || '');
  if (['new', 'replied', 'closed'].indexOf(st) < 0) throw bad('Unknown status');
  await env.DB.prepare('UPDATE enquiries SET status = ? WHERE id = ?').bind(st, parseInt(b.id, 10) || 0).run();
  return { ok: true };
}

async function exportLeads(env, url) {
  const after = parseInt(url.searchParams.get('after'), 10) || 0;
  const { results } = await env.DB.prepare(
    `SELECT id, email, first_name, company, country, business_type, phone, website, source, status, notes, sent_at, followup_sent_at, replied_at, created_at
     FROM leads WHERE id > ? ORDER BY id LIMIT 500`).bind(after).all();
  return { rows: results, statuses: STATUS };
}

/* ---------------- PDF quotes ---------------- */

const CURRENCIES = ['USD', 'EUR', 'GBP', 'AED', 'INR'];
const QUOTE_TEXT = {
  tagline: 'Supplier & Exporter of Bacteriostatic Water for Injection USP',
  product: 'Bacteriostatic Water for Injection USP',
  description: '30 mL multi-dose glass vial with flip-off seal, individual carton\nWater for Injection USP with Benzyl Alcohol USP 0.9% as preservative\nSterile, non-pyrogenic. Shelf life 36 months. CoA with every batch',
  unit: 'vials',
  payment_terms: '100% advance payment by bank transfer before dispatch.',
  shipping_note: 'The prices in this quotation are for the goods only. Shipping charges are NOT included and will be quoted separately based on the destination and the shipping method you choose.',
  terms: 'Prices are per vial, for the quantity stated above, and exclude shipping charges.\nGoods are dispatched after receipt of the full advance payment.\nA Certificate of Analysis (CoA) from the manufacturer is supplied with every batch. Batch details and expiry dates are shared before dispatch.\nExport documents for customs clearance are prepared by us.\nSupplied to registered businesses only. The product is a diluent for drugs and is not for inhalation or for use in neonates.',
  closing: 'Thank you for your enquiry.'
};
// Everything on the quote that can be edited, with its length limit.
const QUOTE_FIELDS = {
  s_company: 120, s_tagline: 160, s_address: 300, s_phone: 60, s_email: 120, s_website: 120, s_gstin: 30, s_iec: 30, s_signatory: 80,
  product: 160, description: 600, unit: 20, payment_terms: 400, shipping_note: 600, terms: 6000, closing: 200, valid_until: 40
};
const SAVABLE_DEFAULTS = ['s_company', 's_tagline', 's_address', 's_phone', 's_email', 's_website', 's_gstin', 's_iec', 's_signatory', 'product', 'description', 'unit', 'payment_terms', 'shipping_note', 'terms', 'closing'];

function quoteDefaults(s) {
  const saved = (() => { try { return JSON.parse(s.quote_defaults || '{}'); } catch (e) { return {}; } })();
  const base = {
    s_company: s.company_name || 'Shree Pharma', s_tagline: QUOTE_TEXT.tagline, s_address: s.address || '', s_phone: s.whatsapp || '',
    s_email: s.alert_email || s.gmail_email || '', s_website: (s.websiteUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    s_gstin: '', s_iec: '', s_signatory: s.your_name || '',
    product: QUOTE_TEXT.product, description: QUOTE_TEXT.description, unit: QUOTE_TEXT.unit, payment_terms: QUOTE_TEXT.payment_terms,
    shipping_note: QUOTE_TEXT.shipping_note, terms: QUOTE_TEXT.terms, closing: QUOTE_TEXT.closing, valid_until: ''
  };
  for (const k of SAVABLE_DEFAULTS) if (typeof saved[k] === 'string') base[k] = saved[k];
  return base;
}

// Money is handled as whole numbers (ten-thousandths of a unit), never as floating point.
function parsePrice(v) {
  const m = String(v == null ? '' : v).trim().replace(/,/g, '').match(/^(\d{1,7})(?:\.(\d{1,4}))?$/);
  if (!m) return null;
  const units = BigInt(m[1]) * 10000n + BigInt((m[2] || '').padEnd(4, '0'));
  return units > 0n ? units : null;
}
function fmtUnits(units, minDp) {
  const whole = units / 10000n, frac = (units % 10000n).toString().padStart(4, '0');
  let f = frac.replace(/0+$/, ''); if (f.length < minDp) f = f.padEnd(minDp, '0');
  return whole.toString() + (f ? '.' + f : '');
}
function quoteTotal(qty, priceUnits) {
  const cents = (BigInt(qty) * priceUnits + 50n) / 100n;   // round half up to cents
  return fmtUnits(cents * 100n, 2);
}

async function createQuote(env, s, b) {
  const company = clip(b.company, 200);
  if (company.length < 2) throw bad('Enter the buyer\'s company name.');
  const currency = String(b.currency || '').toUpperCase();
  if (CURRENCIES.indexOf(currency) < 0) throw bad('Choose a currency.');
  const qtyRaw = String(b.qty == null ? '' : b.qty).trim();
  const qty = parseInt(qtyRaw.replace(/[,\s]/g, ''), 10);
  if (!/^[\d,\s]+$/.test(qtyRaw) || !(qty >= 1 && qty <= 10000000)) throw bad('Enter the quantity as a whole number.');
  const price = parsePrice(b.unit_price);
  if (!price || price > 1000000000n) throw bad('Enter the rate as a number, like 0.85 (up to 4 decimals).');
  let email = '';
  if (String(b.email || '').trim()) { email = cleanEmail(b.email); if (!email) throw bad('The buyer email is not a valid address.'); }
  const dateStr = String(b.date || '').trim();
  let created = Date.now();
  if (dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || isNaN(Date.parse(dateStr + 'T12:00:00Z'))) throw bad('Choose a valid quotation date.');
    created = Date.parse(dateStr + 'T06:30:00Z');       // noon in India on that day
  }
  const data = {};
  for (const [k, n] of Object.entries(QUOTE_FIELDS)) data[k] = String(b[k] == null ? '' : b[k]).replace(/\r/g, '').trim().slice(0, n);
  if (data.s_company.length < 2) throw bad('Enter your company name for the quote.');
  if (!data.product) throw bad('Enter the product name.');
  data.unit = data.unit || 'vials';
  const row = {
    company, contact: clip(b.contact, 120), email, country: clip(b.country, 80), currency, qty,
    unit_price: fmtUnits(price, 2), total: quoteTotal(qty, price), payment_terms: data.payment_terms, notes: ''
  };
  const r = await env.DB.prepare(`INSERT INTO quotes(created_at, company, contact, email, country, currency, qty, unit_price, total, payment_terms, notes, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(created, row.company, row.contact, row.email, row.country, row.currency, row.qty, row.unit_price, row.total, row.payment_terms, row.notes, JSON.stringify(data)).run();
  const id = r.meta && r.meta.last_row_id;
  const number = 'SP-' + new Date(created + 5.5 * 3600000).getUTCFullYear() + '-' + String(id).padStart(4, '0');
  await env.DB.prepare('UPDATE quotes SET number = ? WHERE id = ?').bind(number, id).run();
  if (b.save_defaults) {
    const keep = {}; for (const k of SAVABLE_DEFAULTS) keep[k] = data[k];
    await setSettings(env, { quote_defaults: JSON.stringify(keep) });
  }
  const line = 'Quote ' + number + ': ' + row.qty.toLocaleString('en-US') + ' ' + data.unit + ' at ' + currency + ' ' + row.unit_price + ' = ' + currency + ' ' + row.total;
  if (email) {
    await env.DB.prepare(`UPDATE leads SET notes = CASE WHEN notes = '' THEN ? ELSE notes || ' · ' || ? END, updated_at = ? WHERE email = ?`)
      .bind(line, line, Date.now(), email).run();
  }
  await log(env, 'Quote created', email, number + ' · ' + company);
  return { quote: { id, number, created_at: created, ...row, data } };
}

async function listQuotes(env, url, s) {
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const per = 20;
  const [rows, total] = await Promise.all([
    env.DB.prepare('SELECT * FROM quotes ORDER BY id DESC LIMIT ? OFFSET ?').bind(per, (page - 1) * per).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM quotes').first()
  ]);
  const defaults = quoteDefaults(s);
  const list = rows.results.map(r => {
    let data = {}; try { data = JSON.parse(r.data || '{}'); } catch (e) {}
    if (!data.s_company) data = { ...defaults, payment_terms: r.payment_terms || defaults.payment_terms };   // older quotes
    return { ...r, data };
  });
  return { rows: list, total: total ? Number(total.n) : 0, page, per, defaults, builtIn: { ...quoteDefaults({ ...s, quote_defaults: '{}' }) }, currencies: CURRENCIES };
}

/* ---------------- phone notifications ---------------- */

async function pushStatus(env, s) {
  const keys = await vapidKeys(env, s);
  const { results } = await env.DB.prepare('SELECT endpoint, label, created_at, last_ok FROM push_subs ORDER BY created_at DESC').all();
  return { publicKey: keys.publicKey, devices: results, max: MAX_DEVICES };
}

async function pushSubscribe(env, b) {
  const sub = validSubscription(b.subscription, !!env.GMAIL_API_BASE); // plain http only for the local test setup
  if (!sub) throw bad('This browser gave an unusable notification address. Try again, or use Safari on iPhone / Chrome on Android.');
  const label = clip(b.label, 60) || 'Device';
  await env.DB.prepare(`INSERT INTO push_subs(endpoint, p256dh, auth, label, created_at) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, created_at = excluded.created_at`)
    .bind(sub.endpoint, sub.p256dh, sub.auth, label, Date.now()).run();
  // keep only the newest few devices
  await env.DB.prepare('DELETE FROM push_subs WHERE endpoint NOT IN (SELECT endpoint FROM push_subs ORDER BY created_at DESC LIMIT ?)').bind(MAX_DEVICES).run();
  await log(env, 'Notifications turned on', '', label);
  return { ok: true };
}

/* ---------------- public: website quote form ---------------- */

async function publicEnquiry(request, env, ctx) {
  const ip = clientIp(request);
  if ((await counter(env, 'enq:' + ip + ':' + hourKey())) >= 5) return json({ ok: false, error: 'Too many requests. Please email or WhatsApp us instead.' }, 429);
  if ((await counter(env, 'enq:day:' + istDay())) >= 100) return json({ ok: false, error: 'We are receiving many requests right now. Please email or WhatsApp us instead.' }, 429);
  let d;
  try { d = await readJson(request, 20000); } catch (e) { return json({ ok: false, error: 'Please send the form again.' }, 400); }
  if (d.website) return json({ ok: true }); // spam trap filled in by bots
  const e = {
    name: clip(d.name, 100), company: clip(d.company, 200), email: cleanEmail(d.email), phone: clip(d.phone, 40),
    country: clip(d.country, 80), quantity: clip(d.quantity, 40), message: clip(d.message, 2000)
  };
  if (e.name.length < 2 || !e.email) return json({ ok: false, error: 'Please enter your name and a valid business email.' }, 400);
  await bump(env, 'enq:' + ip + ':' + hourKey());
  await bump(env, 'enq:day:' + istDay());
  const now = Date.now();
  await env.DB.prepare('INSERT INTO enquiries(created_at, name, company, email, phone, country, quantity, message, status) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(now, e.name, e.company, e.email, e.phone, e.country, e.quantity, e.message, 'new').run();

  const s = effective(await getSettings(env));
  const connected = !!(s.gmail_refresh && s.gmail_email);
  const gm = connected ? new Gmail(env, s, 6) : null;
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE email = ?').bind(e.email).first();
  if (!lead) {
    await env.DB.prepare(`INSERT OR IGNORE INTO leads(email, first_name, company, country, phone, source, status, unsub_token, notes, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, 'Website form', 'enquiry', ?, 'Website enquiry', ?, ?)`)
      .bind(e.email, firstName(e.name), e.company, e.country, e.phone, randomHex(16), now, now).run();
  } else if (['new', 'drafted', 'queued', 'skipped'].indexOf(lead.status) >= 0) {
    try { await closeLead(env, gm, lead, 'enquiry', { note: 'Website enquiry' }); } catch (x) { console.error(x); }
  } else {
    await env.DB.prepare(`UPDATE leads SET notes = CASE WHEN notes = '' THEN 'Website enquiry' ELSE notes || ' · Website enquiry' END, updated_at = ? WHERE id = ?`).bind(now, lead.id).run();
  }
  await log(env, 'Website enquiry', e.email, e.company);
  ctx.waitUntil(pushAll(env, { title: 'New quote request: ' + (e.company || e.name), body: [e.country, e.quantity ? (/vial/i.test(e.quantity) ? e.quantity : 'Qty ' + e.quantity) : '', e.email].filter(Boolean).join(' · '), url: '/app#enquiries', tag: 'enquiry' }, s));
  if (connected && s.alert_email) {
    ctx.waitUntil(sendAlert(gm, s, 'New quote request: ' + (e.company || e.name) + (e.country ? ' (' + e.country + ')' : ''),
      ['Name: ' + e.name, 'Company: ' + e.company, 'Email: ' + e.email, 'Phone: ' + e.phone, 'Country: ' + e.country, 'Quantity: ' + e.quantity, '', 'Message:', e.message || '(none)', '',
        'Reply to the buyer at ' + e.email + '.'].join('\n')).catch(x => console.error('enquiry alert failed', x)));
  }
  return json({ ok: true });
}

/* ---------------- public: unsubscribe ---------------- */

async function unsubscribe(request, env, token) {
  token = String(token || '').replace(/\/+$/, '');
  const page = (title, body) => html(simplePage(title, body), 200, { 'x-robots-tag': 'noindex' });
  if (!/^[a-f0-9]{32}$/.test(token)) return page('Link not valid', '<p>This unsubscribe link is not valid. Reply "unsubscribe" to our email instead.</p>');
  const lead = await env.DB.prepare('SELECT * FROM leads WHERE unsub_token = ?').bind(token).first();
  if (request.method === 'POST') {
    if (lead && lead.status !== 'unsubscribed') {
      const s = effective(await getSettings(env));
      const gm = s.gmail_refresh && s.gmail_email ? new Gmail(env, s, 3) : null;
      try { await closeLead(env, gm, lead, 'unsubscribed', { note: 'Unsubscribed by link' }); }
      catch (e) { await env.DB.prepare(`UPDATE leads SET status = 'unsubscribed', updated_at = ? WHERE id = ?`).bind(Date.now(), lead.id).run(); }
      await log(env, 'Unsubscribed', lead.email, 'by link');
    }
    return page('You are unsubscribed', '<p>You will not receive any more emails from us.</p>');
  }
  if (!lead) return page('Link not valid', '<p>This unsubscribe link is not valid. Reply "unsubscribe" to our email instead.</p>');
  if (lead.status === 'unsubscribed') return page('You are unsubscribed', '<p>You will not receive any more emails from us.</p>');
  return page('Unsubscribe', '<p>Stop receiving emails from us at <b>' + esc(lead.email) + '</b>?</p><form method="post"><button class="btn" type="submit">Unsubscribe</button></form>');
}

/* ---------------- small pages ---------------- */

function manifest() {
  return new Response(JSON.stringify({
    name: 'Shree Pharma Dashboard', short_name: 'Shree Pharma', start_url: '/app', scope: '/app', display: 'standalone',
    background_color: '#f7f6f8', theme_color: '#c8165e',
    icons: [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]
  }), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=3600' } });
}

function simplePage(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} | Shree Pharma</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>body{margin:0;font:16px/1.6 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1b1d2b;background:#f7f6f8}
main{max-width:520px;margin:12vh auto;padding:28px 22px;background:#fff;border:1px solid #e3e1e6;border-radius:14px}
h1{font-size:24px;margin:0 0 10px}.logo{display:flex;align-items:center;gap:8px;font-weight:700;margin-bottom:18px}
.logo i{width:8px;height:18px;background:#c8165e;border-radius:2px 2px 5px 5px;display:block}
a{color:#9c0f48}.btn{font:600 15px inherit;font-family:inherit;background:#c8165e;color:#fff;border:0;border-radius:8px;padding:12px 18px;cursor:pointer}
@media(max-width:560px){main{margin:6vh 16px}}</style></head>
<body><main><div class="logo"><i></i>Shree Pharma</div><h1>${esc(title)}</h1>${body}</main></body></html>`;
}
