// Small shared helpers. India Standard Time is UTC+5:30 with no daylight saving.
export const IST_OFFSET = 330 * 60 * 1000;
export const DAY = 86400000;

export function istDay(ms = Date.now()) {
  return new Date(ms + IST_OFFSET).toISOString().slice(0, 10);
}
export function istMinutes(ms = Date.now()) {
  const d = new Date(ms + IST_OFFSET);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
export function istWeekday(ms = Date.now()) {
  const w = new Date(ms + IST_OFFSET).getUTCDay();
  return w !== 0 && w !== 6;
}
// Adds (or with negative n, subtracts) Monday-to-Friday days in IST, keeping the time of day.
export function addBusinessDays(ms, n) {
  const d = new Date(ms + IST_OFFSET);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + step);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) left--;
  }
  return d.getTime() - IST_OFFSET;
}

export function cleanEmail(v) {
  const parts = String(v == null ? '' : v).toLowerCase().split(/[\s,;\/]+/);
  for (const p of parts) {
    const e = p.replace(/^mailto:/, '').replace(/^[<("'\[]+|[>)"'.\]]+$/g, '');
    if (e.length <= 254 && /^[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e) && e.indexOf('..') < 0 && !e.startsWith('.')) return e;
  }
  return '';
}

// Pulls the address out of a header like: "Name" <a@b.com>
export function headerEmail(v) {
  const m = String(v || '').match(/<([^>]+)>/);
  return cleanEmail(m ? m[1] : v);
}

export function firstName(full) {
  const t = String(full == null ? '' : full).trim().replace(/\s+/g, ' ');
  if (!t || t.indexOf('@') >= 0) return '';
  const w = t.split(' ');
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  if (/^(dr|mr|mrs|ms|miss|prof)\.?$/i.test(w[0]) && w.length > 1) {
    const title = cap(w[0].toLowerCase().replace(/\.?$/, '.'));
    const last = w[w.length - 1];
    return title + ' ' + (last === last.toLowerCase() || last === last.toUpperCase() ? cap(last.toLowerCase()) : last);
  }
  const f = w[0];
  return (f === f.toUpperCase() || f === f.toLowerCase()) ? cap(f.toLowerCase()) : f;
}

export function clip(v, n) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const utf8 = s => new TextEncoder().encode(s);

export function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export const b64 = s => bytesToB64(utf8(s));
export const b64url = s => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function b64urlDecode(s) {
  let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', utf8(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', utf8(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, utf8(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY'
};
export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS, ...headers }
  });
}
export function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS, ...headers }
  });
}
export function redirect(location, headers = {}) {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', ...headers } });
}

export function getCookie(request, name) {
  const c = request.headers.get('cookie') || '';
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return '';
}

// The reply text only, without the quoted original email below it
export function stripQuote(body) {
  const t = String(body || '').replace(/\r\n/g, '\n');
  const cut = t.search(/\n\s*(On .{0,300}wrote:|-{2,}\s*Original Message|_{5,}|From:\s.+\n\s*(Sent|Date):)/i);
  return (cut >= 0 ? t.slice(0, cut) : t).split('\n').filter(l => !/^\s*>/.test(l)).join('\n').trim();
}

export function htmlToText(h) {
  return String(h || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

export function isYes(v) {
  return /^(yes|y|true|on|1)$/i.test(String(v == null ? '' : v).trim());
}
