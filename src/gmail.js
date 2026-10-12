// Gmail connection: sign-in with Google, access tokens, and the few Gmail API calls the app needs.
import { setSettings } from './db.js';
import { b64, b64url, esc, randomHex, utf8 } from './util.js';

export const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const DEFAULT_URLS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  api: 'https://gmail.googleapis.com/gmail/v1/users/me'
};
// The *_URL variables exist only for local testing. Never set them in Cloudflare.
export function googleUrls(env) {
  return {
    auth: env.GOOGLE_AUTH_URL || DEFAULT_URLS.auth,
    token: env.GOOGLE_TOKEN_URL || DEFAULT_URLS.token,
    api: env.GMAIL_API_BASE || DEFAULT_URLS.api
  };
}

export class GmailAuthError extends Error {}
export class BudgetError extends Error {}

export function oauthStartUrl(env, origin, state) {
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID || '',
    redirect_uri: origin + '/app/oauth/callback',
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  return googleUrls(env).auth + '?' + q.toString();
}

export async function exchangeCode(env, origin, code) {
  const r = await fetch(googleUrls(env).token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID || '',
      client_secret: env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: origin + '/app/oauth/callback',
      grant_type: 'authorization_code'
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google said: ' + (d.error_description || d.error || r.status));
  return d;
}

export class Gmail {
  // budget = how many outside requests this run may make (Cloudflare's free plan allows 50)
  constructor(env, settings, budget = 40) {
    this.env = env;
    this.s = settings;
    this.budget = budget;
    this.token = null;
  }
  spend() {
    if (this.budget <= 0) throw new BudgetError('Request budget for this run is used up');
    this.budget--;
  }
  get connected() { return !!this.s.gmail_refresh; }

  async accessToken(force = false) {
    if (this.token && !force) return this.token;
    const exp = Number(this.s.gmail_access_exp || 0);
    if (!force && this.s.gmail_access && exp > Date.now() + 90000) return (this.token = this.s.gmail_access);
    if (!this.s.gmail_refresh) throw new GmailAuthError('Gmail is not connected. Open Settings and tap Connect Gmail.');
    this.spend();
    const r = await fetch(googleUrls(this.env).token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.env.GOOGLE_CLIENT_ID || '',
        client_secret: this.env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: this.s.gmail_refresh,
        grant_type: 'refresh_token'
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) {
      if (r.status === 400 || r.status === 401) {
        const msg = d.error === 'invalid_grant'
          ? 'Google removed this app\'s access to Gmail. Open Settings and tap Reconnect Gmail.'
          : 'Google rejected the connection (' + (d.error || r.status) + '). Check the Google Client ID and Secret, then reconnect Gmail.';
        await setSettings(this.env, { gmail_access: '', gmail_access_exp: '0', gmail_status: msg });
        this.s.gmail_status = msg;
        throw new GmailAuthError(msg);
      }
      throw new Error('Google sign-in service error ' + r.status);
    }
    const expAt = Date.now() + (Number(d.expires_in) || 3600) * 1000;
    const upd = { gmail_access: d.access_token, gmail_access_exp: String(expAt), gmail_status: '' };
    if (d.refresh_token) upd.gmail_refresh = d.refresh_token;
    await setSettings(this.env, upd);
    Object.assign(this.s, upd);
    return (this.token = d.access_token);
  }

  async call(method, path, body, query, retried = false) {
    const token = await this.accessToken(retried);
    this.spend();
    let url = googleUrls(this.env).api + path;
    if (query) url += '?' + query;
    const r = await fetch(url, {
      method,
      headers: body ? { authorization: 'Bearer ' + token, 'content-type': 'application/json' } : { authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 401 && !retried) {
      this.token = null;
      this.s.gmail_access = '';
      return this.call(method, path, body, query, true);
    }
    if (r.status === 204) return {};
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
    if (!r.ok) {
      const err = new Error((data.error && data.error.message) || ('Gmail error ' + r.status));
      err.status = r.status;
      if (r.status === 401) throw new GmailAuthError('Gmail access stopped working. Open Settings and tap Reconnect Gmail.');
      throw err;
    }
    return data;
  }

  profile() { return this.call('GET', '/profile'); }
  createDraft(raw, threadId) {
    const message = { raw };
    if (threadId) message.threadId = threadId;
    return this.call('POST', '/drafts', { message });
  }
  sendDraft(id) { return this.call('POST', '/drafts/send', { id }); }
  getDraft(id) { return this.call('GET', '/drafts/' + encodeURIComponent(id), null, 'format=minimal'); }
  deleteDraft(id) { return this.call('DELETE', '/drafts/' + encodeURIComponent(id)); }
  listDrafts() { return this.call('GET', '/drafts', null, 'maxResults=500'); }
  listMessages(q, max = 50) {
    return this.call('GET', '/messages', null, 'maxResults=' + max + '&q=' + encodeURIComponent(q));
  }
  getMessage(id, format = 'full', headers = []) {
    let q = 'format=' + format;
    for (const h of headers) q += '&metadataHeaders=' + encodeURIComponent(h);
    return this.call('GET', '/messages/' + encodeURIComponent(id), null, q);
  }
  sendMessage(raw) { return this.call('POST', '/messages/send', { raw }); }
}

/* ---------- building emails ---------- */

const oneLine = s => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();

export function encodeHeader(v) {
  v = oneLine(v);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words = [];
  let cur = '';
  for (const ch of v) {
    if (utf8(cur + ch).length > 45) { words.push(cur); cur = ch; } else cur += ch;
  }
  if (cur) words.push(cur);
  return words.map(w => '=?UTF-8?B?' + b64(w) + '?=').join('\r\n ');
}

function address(name, email) {
  name = oneLine(name);
  if (!name) return email;
  if (/^[\x20-\x7e]*$/.test(name)) return '"' + name.replace(/["\\]/g, '\\$&') + '" <' + email + '>';
  return encodeHeader(name) + ' <' + email + '>';
}

const wrap76 = s => s.replace(/.{76}/g, '$&\r\n');

export function buildMime({ from, fromName, to, subject, text, html, inReplyTo, listUnsubscribe, oneClick }) {
  const boundary = 'sp_' + randomHex(12);
  const h = [
    'From: ' + address(fromName, from),
    'To: ' + oneLine(to),
    'Subject: ' + encodeHeader(subject),
    'MIME-Version: 1.0'
  ];
  if (inReplyTo) {
    const id = oneLine(inReplyTo);
    h.push('In-Reply-To: ' + id, 'References: ' + id);
  }
  if (listUnsubscribe) {
    h.push('List-Unsubscribe: ' + oneLine(listUnsubscribe));
    if (oneClick) h.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }
  h.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
  const part = (type, body) => [
    '--' + boundary,
    'Content-Type: ' + type + '; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(body))
  ].join('\r\n');
  const msg = h.join('\r\n') + '\r\n\r\n' + part('text/plain', text) + '\r\n' + part('text/html', html) + '\r\n--' + boundary + '--\r\n';
  return b64url(msg);
}

export function textToHtml(text) {
  const linked = esc(text).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)'"])/g, '<a href="$1">$1</a>');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#222">' +
    linked.replace(/\r?\n/g, '<br>') + '</div>';
}

export function headerOf(msg, name) {
  const hs = (msg && msg.payload && msg.payload.headers) || [];
  const n = name.toLowerCase();
  for (const h of hs) if (String(h.name).toLowerCase() === n) return h.value || '';
  return '';
}
