// Phone / desktop notifications (Web Push, RFC 8030 + 8291 + 8292) using only built-in WebCrypto. Free, no extra service.
import { getSettings, setSettings } from './db.js';

export const MAX_DEVICES = 5; // keeps each run well inside Cloudflare's free-plan request limit

const enc = new TextEncoder();
const b64u = buf => {
  const a = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = str => {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/* ---------- server keys (made once, kept in the database) ---------- */

export async function vapidKeys(env, s) {
  s = s || (await getSettings(env));
  if (s.vapid_private && s.vapid_public) return { privateJwk: JSON.parse(s.vapid_private), publicKey: s.vapid_public };
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const publicKey = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
  await setSettings(env, { vapid_private: JSON.stringify(privateJwk), vapid_public: publicKey });
  return { privateJwk, publicKey };
}

async function vapidHeader(keys, endpoint, signKey, cache) {
  const aud = new URL(endpoint).origin;
  if (cache[aud]) return cache[aud];
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:shreepharma.in@gmail.com' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, enc.encode(head + '.' + body));
  return (cache[aud] = 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + keys.publicKey);
}

/* ---------- message encryption (aes128gcm, RFC 8291) ---------- */

export async function encryptPayload(sub, plaintext, eph) {
  const uaPublic = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, eph.publicRaw, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const data = concat(enc.encode(plaintext), new Uint8Array([2])); // 2 = last (and only) record
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, data));
  const header = new Uint8Array(21 + eph.publicRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = eph.publicRaw.length;
  header.set(eph.publicRaw, 21);
  return concat(header, ct);
}

/* ---------- sending ---------- */

// Sends one notification to every saved device. Never throws: a failed notification must not stop email work.
export async function pushAll(env, note, s) {
  try {
    const { results } = await env.DB.prepare('SELECT endpoint, p256dh, auth FROM push_subs ORDER BY created_at DESC LIMIT ?').bind(MAX_DEVICES).all();
    if (!results.length) return { sent: 0, devices: 0 };
    const keys = await vapidKeys(env, s);
    const signKey = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const eph = { privateKey: kp.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)) };
    const payload = JSON.stringify({
      title: String(note.title || 'Shree Pharma').slice(0, 120),
      body: String(note.body || '').slice(0, 400),
      url: note.url && /^\/app(\/|#|$)/.test(note.url) ? note.url : '/app',
      tag: String(note.tag || 'sp').slice(0, 40)
    });
    const cache = {};
    let sent = 0;
    await Promise.all(results.map(async sub => {
      try {
        const body = await encryptPayload(sub, payload, eph);
        const r = await fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            authorization: await vapidHeader(keys, sub.endpoint, signKey, cache),
            'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
            ttl: '86400', urgency: 'high'
          },
          body
        });
        if (r.status === 404 || r.status === 410) {
          await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
        } else if (r.ok) {
          sent++;
          await env.DB.prepare('UPDATE push_subs SET last_ok = ? WHERE endpoint = ?').bind(Date.now(), sub.endpoint).run();
        } else {
          console.error('push failed', r.status, (await r.text().catch(() => '')).slice(0, 200));
        }
      } catch (e) { console.error('push error', e); }
    }));
    return { sent, devices: results.length };
  } catch (e) {
    console.error('push setup error', e);
    return { sent: 0, devices: 0, error: e.message };
  }
}

export function validSubscription(b, allowLocalHttp) {
  const endpoint = String((b && b.endpoint) || '');
  const keys = (b && b.keys) || {};
  let u;
  try { u = new URL(endpoint); } catch (e) { return null; }
  const localTest = allowLocalHttp && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if ((u.protocol !== 'https:' && !localTest) || endpoint.length > 1000) return null;
  const p256dh = String(keys.p256dh || ''), auth = String(keys.auth || '');
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,40}$/.test(auth)) return null;
  try { if (unb64u(p256dh).length !== 65 || unb64u(p256dh)[0] !== 4) return null; } catch (e) { return null; }
  return { endpoint, p256dh, auth };
}

/* ---------- the little background script on the phone ---------- */

export const SERVICE_WORKER = `'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Shree Pharma', {
    body: d.body || '', icon: '/icon-512.png', badge: '/icon-512.png', tag: d.tag || 'sp', renotify: true, data: { url: d.url || '/app' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/app', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.indexOf(self.location.origin + '/app') === 0 && 'focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
`;
