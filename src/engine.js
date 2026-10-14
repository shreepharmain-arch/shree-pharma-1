// The outreach engine: drafts, sending, follow-ups, replies, bounces, unsubscribes and alerts.
import { getSettings, setSettings, log, counter, bump, housekeeping, ensureSchema } from './db.js';
import { Gmail, GmailAuthError, BudgetError, buildMime, textToHtml, headerOf } from './gmail.js';
import { addBusinessDays, istDay, istMinutes, istWeekday, isYes, stripQuote, htmlToText, b64urlDecode, headerEmail, cleanEmail } from './util.js';
import { pushAll } from './push.js';

export const STATUS = {
  new: 'New', drafting: 'Preparing draft', drafted: 'Draft ready', queued: 'Queued to send', sending: 'Sending',
  sent: 'Sent', fu_drafting: 'Preparing follow-up', fu_drafted: 'Follow-up ready', fu_queued: 'Follow-up queued',
  fu_sending: 'Sending follow-up', fu_sent: 'Followed up', replied: 'Replied', interested: 'Interested', client: 'Client',
  not_interested: 'Not interested', bounced: 'Bounced', unsubscribed: 'Unsubscribed', enquiry: 'Website enquiry',
  skipped: 'Skipped', no_reply: 'No reply', dnc: 'Do not contact'
};
export const PENDING = ['drafting', 'drafted', 'queued', 'sending', 'fu_drafting', 'fu_drafted', 'fu_queued', 'fu_sending'];
export const WATCH = ['sent', 'fu_drafting', 'fu_drafted', 'fu_queued', 'fu_sending', 'fu_sent', 'no_reply'];
export const HAS_DRAFT = ['drafted', 'queued', 'fu_drafted', 'fu_queued'];
export const MANUAL_STATUSES = ['new', 'replied', 'interested', 'client', 'not_interested', 'no_reply', 'dnc'];
const MAX_DAILY = 150;

const ph = n => Array(n).fill('?').join(',');

export function effective(s) {
  const origin = (s.app_origin || '').replace(/\/+$/, '');
  return {
    ...s,
    origin,
    websiteUrl: (s.website || origin || '').trim(),
    brochureUrl: (s.brochure_link || (origin ? origin + '/brochure.pdf' : '')).trim()
  };
}
export function dailyLimit(s) {
  const n = parseInt(s.daily_limit, 10);
  return Math.max(1, Math.min(isFinite(n) ? n : 20, MAX_DAILY));
}
const senderName = s => [s.your_name, s.company_name].filter(Boolean).join(' | ');

/* ---------- templates ---------- */

export function render(tpl, lead, s) {
  const map = {
    FirstName: lead.first_name || 'Purchasing Team',
    Company: lead.company || 'your company',
    Country: lead.country || 'your country',
    YourName: s.your_name || '',
    CompanyName: s.company_name || '',
    WhatsApp: s.whatsapp || '',
    Website: s.websiteUrl || '',
    BrochureLink: s.brochureUrl || '',
    Address: s.address || '',
    UnsubscribeLink: s.origin && lead.unsub_token ? s.origin + '/u/' + lead.unsub_token : ''
  };
  const fill = line => line.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in map ? String(map[k]) : m));
  const lines = String(tpl || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const only = line.trim().match(/^\{\{\s*(\w+)\s*\}\}$/);
    if (only && only[1] in map && !String(map[only[1]]).trim()) continue; // drop a line whose only content is empty
    out.push(fill(line).replace(/[ \t]+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function compose(lead, kind, s) {
  const isFu = kind === 'fu';
  const subject = isFu
    ? (/^re:/i.test(lead.subject || '') ? lead.subject : 'Re: ' + (lead.subject || ''))
    : render(s.tpl_first_subject, lead, s).replace(/\s+/g, ' ').trim();
  const text = render(isFu ? s.tpl_fu_body : s.tpl_first_body, lead, s);
  const unsubUrl = s.origin && lead.unsub_token ? s.origin + '/u/' + lead.unsub_token : '';
  const listUnsub = [unsubUrl && '<' + unsubUrl + '>', s.gmail_email && '<mailto:' + s.gmail_email + '?subject=unsubscribe>'].filter(Boolean).join(', ');
  const raw = buildMime({
    from: s.gmail_email,
    fromName: senderName(s),
    to: lead.email,
    subject,
    text,
    html: textToHtml(text),
    inReplyTo: isFu ? lead.message_id : '',
    listUnsubscribe: listUnsub,
    oneClick: !!unsubUrl
  });
  return { subject, text, raw };
}

/* ---------- counts ---------- */

export async function pendingCount(env) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status IN (${ph(PENDING.length)})`).bind(...PENDING).first();
  return r ? Number(r.n) : 0;
}
export const sentTodayKey = () => 'sent:' + istDay();

// Start of today in India, as a timestamp.
export function istDayStart() { const d = istDay(); return Date.parse(d + 'T00:00:00+05:30'); }

// Splits the total daily limit evenly across active lists that still have work.
// A list that cannot use its full share (few leads left) passes the rest to the others.
export async function listPlan(env, s) {
  const limit = dailyLimit(s), now = Date.now(), dayStart = istDayStart();
  const { results } = await env.DB.prepare(`
    SELECT l.id, l.name, l.active, l.created_at,
      COUNT(d.id) AS total,
      SUM(CASE WHEN d.status = 'new' THEN 1 ELSE 0 END) AS fresh,
      SUM(CASE WHEN d.status = 'sent' AND d.followup_due IS NOT NULL AND d.followup_due <= ? THEN 1 ELSE 0 END) AS fu_due,
      SUM(CASE WHEN d.status IN (${ph(PENDING.length)}) THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN (d.sent_at >= ?) OR (d.followup_sent_at >= ?) THEN 1 ELSE 0 END) AS sent_today,
      SUM(CASE WHEN d.sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent_ever,
      SUM(CASE WHEN d.status IN ('replied','interested','client','not_interested') THEN 1 ELSE 0 END) AS replies
    FROM lists l LEFT JOIN leads d ON d.list_id = l.id
    GROUP BY l.id ORDER BY l.id`).bind(now, ...PENDING, dayStart, dayStart).all();
  const lists = results.map(r => {
    const o = { id: r.id, name: r.name, active: !!r.active, created_at: r.created_at };
    for (const k of ['total', 'fresh', 'fu_due', 'pending', 'sent_today', 'sent_ever', 'replies']) o[k] = Number(r[k] || 0);
    o.used = o.pending + o.sent_today;
    o.want = o.used + o.fresh + o.fu_due;          // the most this list could use today
    o.share = 0;
    return o;
  });
  // water-filling: equal split among lists that can still use more
  let pool = limit, open = lists.filter(l => l.active && l.want > 0);
  while (pool > 0 && open.length) {
    const each = Math.floor(pool / open.length), extra = pool % open.length;
    let given = 0;
    open.forEach((l, i) => {
      const offer = each + (i < extra ? 1 : 0);
      const take = Math.min(offer, l.want - l.share);
      l.share += take; given += take;
    });
    pool -= given;
    if (!given) break;
    open = open.filter(l => l.share < l.want);
  }
  return { limit, lists };
}

/* ---------- drafts ---------- */

async function revert(env, ids, status) {
  if (!ids.length) return;
  const from = status === 'new' ? 'drafting' : 'fu_drafting';
  await env.DB.prepare(`UPDATE leads SET status = ?, updated_at = ? WHERE status = ? AND id IN (${ph(ids.length)})`).bind(status, Date.now(), from, ...ids).run();
}

// Creates Gmail drafts (follow-ups first, then first emails) without going over today's limit.
export async function createDrafts(env, gm, s, max) {
  const result = { created: 0, followups: 0, failed: 0 };
  if (!s.gmail_email) return result;
  const limit = dailyLimit(s);
  let room = Math.min(max, limit - (await pendingCount(env)) - (await counter(env, sentTodayKey())), Math.max(0, gm.budget - 2));
  if (room <= 0) return result;
  const plan = await listPlan(env, s);
  // each list may draft up to its share of today's limit, minus what it already used
  const rooms = plan.lists.filter(l => l.active).map(l => ({ id: l.id, room: Math.max(0, l.share - l.used) })).filter(x => x.room > 0);
  for (const lr of rooms) {
    if (room <= 0 || gm.budget < 3) break;
    let listRoom = Math.min(lr.room, room);
    const before = result.created;
    await draftList(env, gm, s, lr.id, listRoom, result);
    room -= result.created - before;
  }
  if (result.created) await log(env, 'Drafts created', '', result.created + ' draft(s), ' + result.followups + ' follow-up(s)');
  return result;
}

async function draftList(env, gm, s, listId, room, result) {
  for (const kind of ['fu', 'first']) {
   for (let round = 0; round < 5 && room > 0 && gm.budget >= 3; round++) {
    const now = Date.now();
    const claimed = kind === 'fu'
      ? (await env.DB.prepare(
          `UPDATE leads SET status = 'fu_drafting', updated_at = ? WHERE id IN (
             SELECT id FROM leads WHERE list_id = ? AND status = 'sent' AND followup_due IS NOT NULL AND followup_due <= ? ORDER BY followup_due LIMIT ?)
           RETURNING *`).bind(now, listId, now, room).all()).results
      : (await env.DB.prepare(
          `UPDATE leads SET status = 'drafting', updated_at = ? WHERE id IN (
             SELECT id FROM leads WHERE list_id = ? AND status = 'new' ORDER BY id LIMIT ?)
           RETURNING *`).bind(now, listId, room).all()).results;
    if (!claimed.length) break;
    const back = kind === 'fu' ? 'sent' : 'new';
    for (let i = 0; i < claimed.length; i++) {
      const lead = claimed[i];
      try {
        if (kind === 'fu' && !lead.message_id && lead.thread_id) {
          // older sends may lack the Message-ID; fetch it so the follow-up threads correctly for the buyer
          try {
            const t = await gm.listMessages('in:sent to:' + lead.email, 1);
            const m = t.messages && t.messages[0];
            if (m) {
              const meta = await gm.getMessage(m.id, 'metadata', ['Message-ID']);
              lead.message_id = headerOf(meta, 'Message-ID');
            }
          } catch (e) { if (e instanceof GmailAuthError || e instanceof BudgetError) throw e; }
        }
        const c = compose(lead, kind, s);
        const d = await gm.createDraft(c.raw, kind === 'fu' ? lead.thread_id : undefined);
        const now2 = Date.now();
        if (kind === 'fu') {
          const u = await env.DB.prepare(`UPDATE leads SET status = 'fu_drafted', draft_id = ?, drafted_at = ?, draft_subject = ?, draft_body = ?, message_id = ?, updated_at = ? WHERE id = ? AND status = 'fu_drafting'`)
            .bind(d.id, now2, c.subject, c.text, lead.message_id || null, now2, lead.id).run();
          if (!u.meta.changes) { try { await gm.deleteDraft(d.id); } catch (x) { /* lead changed meanwhile */ } room--; continue; }
          result.followups++;
        } else {
          const u = await env.DB.prepare(`UPDATE leads SET status = 'drafted', draft_id = ?, drafted_at = ?, draft_subject = ?, draft_body = ?, subject = ?, updated_at = ? WHERE id = ? AND status = 'drafting'`)
            .bind(d.id, now2, c.subject, c.text, c.subject, now2, lead.id).run();
          if (!u.meta.changes) { try { await gm.deleteDraft(d.id); } catch (x) { /* lead changed meanwhile */ } room--; continue; }
        }
        result.created++;
        room--;
      } catch (e) {
        const rest = claimed.slice(i).map(l => l.id);
        if (e instanceof GmailAuthError || e instanceof BudgetError) { await revert(env, rest, back); throw e; }
        if (e.status === 400) {
          await env.DB.prepare(`UPDATE leads SET status = 'skipped', notes = ?, updated_at = ? WHERE id = ?`)
            .bind(('Gmail refused this address: ' + e.message).slice(0, 300), Date.now(), lead.id).run();
          await log(env, 'Skipped', lead.email, 'Gmail refused: ' + e.message);
          result.failed++;
          continue;
        }
        await revert(env, rest, back);
        await log(env, 'Draft error', lead.email, e.message);
        result.failed++;
        return result;
      }
    }
  }
  }
  return result;
}

/* ---------- sending ---------- */

// A draft disappeared: the owner either sent it from the Gmail app or deleted it.
async function draftGone(env, gm, lead, isFu, s) {
  const since = Math.floor((lead.drafted_at || lead.updated_at || Date.now()) / 1000) - 120;
  const r = await gm.listMessages('in:sent to:' + lead.email + ' after:' + since, 1);
  const m = r.messages && r.messages[0];
  const now = Date.now();
  if (m && (!isFu || !lead.thread_id || m.threadId === lead.thread_id)) {
    await bump(env, sentTodayKey());
    if (isFu) {
      await env.DB.prepare(`UPDATE leads SET status = 'fu_sent', followup_sent_at = ?, draft_id = NULL, updated_at = ? WHERE id = ?`).bind(now, now, lead.id).run();
    } else {
      let mid = '';
      try { mid = headerOf(await gm.getMessage(m.id, 'metadata', ['Message-ID']), 'Message-ID'); } catch (e) { if (e instanceof GmailAuthError) throw e; }
      await env.DB.prepare(`UPDATE leads SET status = 'sent', sent_at = ?, thread_id = ?, message_id = ?, followup_due = ?, draft_id = NULL, updated_at = ? WHERE id = ?`)
        .bind(now, m.threadId, mid || null, addBusinessDays(now, parseInt(s.followup_days, 10) || 4), now, lead.id).run();
    }
    await log(env, isFu ? 'Follow-up sent from Gmail' : 'Sent from Gmail', lead.email, '');
  } else {
    await env.DB.prepare(`UPDATE leads SET status = ?, draft_id = NULL, notes = CASE WHEN notes = '' THEN ? ELSE notes END, updated_at = ? WHERE id = ?`)
      .bind(isFu ? 'no_reply' : 'skipped', 'Draft was deleted in Gmail', now, lead.id).run();
    await log(env, 'Draft deleted in Gmail', lead.email, isFu ? 'follow-up' : 'first email');
  }
}

export async function sendQueued(env, gm, s, max) {
  let sent = 0;
  if (isYes(s.paused) || !s.gmail_email) return sent;
  const limit = dailyLimit(s);
  while (sent < max && gm.budget >= 3) {
    if ((await counter(env, sentTodayKey())) >= limit) break;
    const now = Date.now();
    const lead = await env.DB.prepare(
      `UPDATE leads SET status = CASE status WHEN 'queued' THEN 'sending' ELSE 'fu_sending' END, updated_at = ?
       WHERE id = (SELECT id FROM leads WHERE status IN ('queued', 'fu_queued') ORDER BY updated_at, id LIMIT 1)
       RETURNING *`).bind(now).first();
    if (!lead) break;
    const isFu = lead.status === 'fu_sending';
    try {
      if (!lead.draft_id) { const e = new Error('No draft'); e.status = 404; throw e; }
      const msg = await gm.sendDraft(lead.draft_id);
      await bump(env, sentTodayKey());
      const t = Date.now();
      if (isFu) {
        await env.DB.prepare(`UPDATE leads SET status = CASE status WHEN 'fu_sending' THEN 'fu_sent' ELSE status END, followup_sent_at = ?, draft_id = NULL, updated_at = ? WHERE id = ?`).bind(t, t, lead.id).run();
      } else {
        let mid = '';
        try { mid = headerOf(await gm.getMessage(msg.id, 'metadata', ['Message-ID']), 'Message-ID'); }
        catch (e) { if (e instanceof GmailAuthError) throw e; }
        await env.DB.prepare(`UPDATE leads SET status = 'sent', sent_at = ?, thread_id = ?, message_id = ?, followup_due = ?, draft_id = NULL, updated_at = ? WHERE id = ?`)
          .bind(t, msg.threadId || null, mid || null, addBusinessDays(t, parseInt(s.followup_days, 10) || 4), t, lead.id).run();
      }
      await log(env, isFu ? 'Follow-up sent' : 'Sent', lead.email, '');
      sent++;
    } catch (e) {
      if (e.status === 404) { await draftGone(env, gm, lead, isFu, s); continue; }
      await env.DB.prepare(`UPDATE leads SET status = ?, updated_at = ? WHERE id = ?`).bind(isFu ? 'fu_queued' : 'queued', Date.now(), lead.id).run();
      if (e instanceof GmailAuthError || e instanceof BudgetError) throw e;
      if (e.status === 400) {
        await env.DB.prepare(`UPDATE leads SET status = 'skipped', notes = ?, updated_at = ? WHERE id = ?`).bind(('Gmail refused to send: ' + e.message).slice(0, 300), Date.now(), lead.id).run();
        try { await gm.deleteDraft(lead.draft_id); } catch (x) { /* ignore */ }
        await log(env, 'Send refused', lead.email, e.message);
        continue;
      }
      await log(env, 'Send failed', lead.email, e.message + (e.status === 429 ? ' (Gmail daily limit reached, will retry later)' : ''));
      break;
    }
  }
  return sent;
}

/* ---------- replies, bounces, unsubscribes ---------- */

function extractText(payload) {
  if (!payload) return '';
  let plain = '', htmlPart = '';
  const walk = p => {
    if (!p) return;
    const type = String(p.mimeType || '').toLowerCase();
    if (p.body && p.body.data) {
      if (type === 'text/plain' && !plain) plain = b64urlDecode(p.body.data);
      else if (type === 'text/html' && !htmlPart) htmlPart = b64urlDecode(p.body.data);
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return plain || htmlToText(htmlPart);
}

export async function closeLead(env, gm, lead, status, fields = {}) {
  if (lead.draft_id && HAS_DRAFT.indexOf(lead.status) >= 0 && gm) {
    try { await gm.deleteDraft(lead.draft_id); } catch (e) { if (e instanceof GmailAuthError || e instanceof BudgetError) throw e; }
  }
  const now = Date.now();
  await env.DB.prepare(`UPDATE leads SET status = ?, draft_id = NULL, replied_at = COALESCE(?, replied_at), reply_snippet = COALESCE(?, reply_snippet),
      notes = CASE WHEN ? = '' THEN notes WHEN notes = '' THEN ? ELSE notes || ' · ' || ? END, updated_at = ? WHERE id = ?`)
    .bind(status, fields.replied_at || null, fields.snippet || null, fields.note || '', fields.note || '', fields.note || '', now, lead.id).run();
}

async function classify(env, gm, msg) {
  const from = headerOf(msg, 'From');
  const fromEmail = headerEmail(from);
  const subject = headerOf(msg, 'Subject');
  const isBounce = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i.test(from);
  const watch = `status IN (${ph(WATCH.length)})`;

  let lead = msg.threadId
    ? await env.DB.prepare(`SELECT * FROM leads WHERE thread_id = ? LIMIT 1`).bind(msg.threadId).first()
    : null;
  let text = '';
  if (!lead && isBounce) {
    text = extractText(msg.payload) || msg.snippet || '';
    const found = [...new Set((text.match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(cleanEmail).filter(Boolean))].slice(0, 10);
    if (found.length) {
      lead = await env.DB.prepare(`SELECT * FROM leads WHERE email IN (${ph(found.length)}) AND ${watch} LIMIT 1`).bind(...found, ...WATCH).first();
    }
  }
  if (!lead && !isBounce && fromEmail) {
    lead = await env.DB.prepare(`SELECT * FROM leads WHERE email = ? LIMIT 1`).bind(fromEmail).first();
  }
  if (!lead || WATCH.indexOf(lead.status) < 0) return null;

  if (isBounce) {
    await closeLead(env, gm, lead, 'bounced', { note: 'Email bounced' });
    await log(env, 'Bounced', lead.email, subject);
    return { kind: 'bounce', lead };
  }
  const autoSub = headerOf(msg, 'Auto-Submitted').toLowerCase();
  if ((autoSub && autoSub !== 'no') || /^(automatic reply|auto[\s-]?reply|out of (the )?office|autoreply)/i.test(subject)) {
    await log(env, 'Auto-reply ignored', lead.email, subject);
    return null;
  }
  const reply = stripQuote(text || extractText(msg.payload) || msg.snippet || '');
  const short = reply.replace(/\s+/g, ' ').trim();
  const when = Number(msg.internalDate) || Date.now();
  if (short.length < 300 && /\b(unsubscribe|remove me|stop (emailing|sending)|do not (contact|email))\b/i.test(short)) {
    await closeLead(env, gm, lead, 'unsubscribed', { replied_at: when, snippet: short.slice(0, 300), note: 'Asked to unsubscribe' });
    await log(env, 'Unsubscribed', lead.email, 'by reply');
    return { kind: 'unsub', lead };
  }
  if (short.length < 300 && /\bnot interested\b/i.test(short)) {
    await closeLead(env, gm, lead, 'not_interested', { replied_at: when, snippet: short.slice(0, 300) });
    await log(env, 'Not interested', lead.email, '');
    return { kind: 'no', lead, snippet: short };
  }
  await closeLead(env, gm, lead, 'replied', { replied_at: when, snippet: short.slice(0, 300) });
  await log(env, 'Replied', lead.email, short.slice(0, 120));
  return { kind: 'reply', lead, snippet: short, threadId: msg.threadId };
}

export async function checkReplies(env, gm, s, cap = 12) {
  const out = { replied: 0, bounced: 0, unsubscribed: 0, notInterested: 0, fresh: [] };
  if (!s.gmail_email) return out;
  const nowSec = Math.floor(Date.now() / 1000);
  const cursor = Number(s.replies_cursor) || nowSec - 3 * 86400;
  const list = await gm.listMessages('after:' + (cursor - 3600) + ' -from:me -in:chats', 90);
  const msgs = (list.messages || []).slice().reverse();
  let unseen = [];
  if (msgs.length) {
    const ids = msgs.map(m => m.id);
    const { results } = await env.DB.prepare(`SELECT id FROM seen WHERE id IN (${ph(ids.length)})`).bind(...ids).all();
    const seen = new Set(results.map(r => r.id));
    unseen = msgs.filter(m => !seen.has(m.id));
  }
  let done = 0;
  for (const m of unseen) {
    if (done >= cap || gm.budget < 2) break;
    const full = await gm.getMessage(m.id, 'full');
    if (!full.threadId) full.threadId = m.threadId;
    const r = await classify(env, gm, full);
    await env.DB.prepare('INSERT OR IGNORE INTO seen(id, at) VALUES(?, ?)').bind(m.id, Date.now()).run();
    done++;
    if (!r) continue;
    if (r.kind === 'reply') { out.replied++; out.fresh.push(r); }
    else if (r.kind === 'bounce') out.bounced++;
    else if (r.kind === 'unsub') out.unsubscribed++;
    else if (r.kind === 'no') out.notInterested++;
  }
  if (done === unseen.length && !list.nextPageToken) await setSettings(env, { replies_cursor: String(nowSec - 120) });
  if (out.fresh.length) {
    const first = out.fresh[0].lead;
    await pushAll(env, {
      title: out.fresh.length > 1 ? out.fresh.length + ' new replies from buyers' : 'Reply from ' + (first.company || first.email),
      body: out.fresh.length > 1 ? out.fresh.map(f => f.lead.company || f.lead.email).slice(0, 4).join(', ') : '"' + out.fresh[0].snippet.slice(0, 140) + '"',
      url: '/app#home', tag: 'reply'
    }, s);
  }
  if (out.fresh.length && s.alert_email) {
    const lines = out.fresh.map(f => '• ' + (f.lead.company || f.lead.email) + (f.lead.country ? ' (' + f.lead.country + ')' : '') +
      '\n  ' + f.lead.email + '\n  "' + f.snippet.slice(0, 220) + '"\n  Open: https://mail.google.com/mail/?authuser=' + encodeURIComponent(s.gmail_email) + '#all/' + f.threadId);
    await sendAlert(gm, s, out.fresh.length + ' new repl' + (out.fresh.length > 1 ? 'ies' : 'y') + ' from buyers',
      'New replies in your outreach inbox (' + s.gmail_email + '):\n\n' + lines.join('\n\n') + '\n\nReply to them from that Gmail account.');
  }
  return out;
}

/* ---------- alerts ---------- */

export async function sendAlert(gm, s, subject, text) {
  if (!s.alert_email || !s.gmail_email) return;
  try {
    await gm.sendMessage(buildMime({ from: s.gmail_email, fromName: (s.company_name || 'Shree Pharma') + ' Dashboard', to: s.alert_email, subject, text, html: textToHtml(text) }));
  } catch (e) {
    if (e instanceof GmailAuthError) throw e;
    console.error('alert failed', e);
  }
}

/* ---------- upkeep ---------- */

// Puts back anything a crashed or timed-out run left half done.
export async function recoverStale(env) {
  const cutoff = Date.now() - 10 * 60000;
  await env.DB.batch([
    env.DB.prepare(`UPDATE leads SET status = 'new', updated_at = ? WHERE status = 'drafting' AND draft_id IS NULL AND updated_at < ?`).bind(Date.now(), cutoff),
    env.DB.prepare(`UPDATE leads SET status = 'sent', updated_at = ? WHERE status = 'fu_drafting' AND updated_at < ?`).bind(Date.now(), cutoff),
    env.DB.prepare(`UPDATE leads SET status = 'queued', updated_at = ? WHERE status = 'sending' AND updated_at < ?`).bind(Date.now(), cutoff),
    env.DB.prepare(`UPDATE leads SET status = 'fu_queued', updated_at = ? WHERE status = 'fu_sending' AND updated_at < ?`).bind(Date.now(), cutoff)
  ]);
}

// Finds drafts that were sent or deleted directly in Gmail.
export async function syncDrafts(env, gm, s, cap = 4) {
  const { results } = await env.DB.prepare(`SELECT * FROM leads WHERE status IN (${ph(HAS_DRAFT.length)}) AND draft_id IS NOT NULL AND updated_at < ? LIMIT 500`)
    .bind(...HAS_DRAFT, Date.now() - 60000).all();
  if (!results.length) return 0;
  const d = await gm.listDrafts();
  const have = new Set((d.drafts || []).map(x => x.id));
  let fixed = 0;
  for (const lead of results) {
    if (have.has(lead.draft_id)) continue;
    if (fixed >= cap || gm.budget < 3) break;
    await draftGone(env, gm, lead, lead.status.startsWith('fu_'), s);
    fixed++;
  }
  return fixed;
}

export async function stopWatching(env, s) {
  const days = parseInt(s.stop_days, 10) || 10;
  const cutoff = addBusinessDays(Date.now(), -days);
  const r = await env.DB.prepare(`UPDATE leads SET status = 'no_reply', updated_at = ? WHERE status = 'fu_sent' AND followup_sent_at < ?`).bind(Date.now(), cutoff).run();
  return (r.meta && r.meta.changes) || 0;
}

/* ---------- the timer: runs every 10 minutes ---------- */

export async function runCron(env) {
  await ensureSchema(env);
  const s = effective(await getSettings(env));
  await recoverStale(env);
  await stopWatching(env, s);
  if (!s.gmail_refresh || !s.gmail_email) return { skipped: 'not connected' };
  const gm = new Gmail(env, s, 38); // leaves room for phone notifications within the 50-request limit
  const report = {};
  try {
    report.replies = await checkReplies(env, gm, s, 12);
    report.synced = await syncDrafts(env, gm, s, 3);
    report.sent = await sendQueued(env, gm, s, 3);
    const mins = istMinutes();
    if (isYes(s.auto_drafts) && istWeekday() && mins >= 9 * 60 && mins < 20 * 60) {
      report.drafts = await createDrafts(env, gm, s, 10);
    }
    const today = istDay();
    if (istWeekday() && mins >= 9 * 60 + 30 && s.summary_day !== today) {
      await setSettings(env, { summary_day: today });
      const r = await env.DB.prepare(`SELECT
          SUM(CASE WHEN status IN ('drafted','fu_drafted') THEN 1 ELSE 0 END) AS ready,
          SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS fresh
        FROM leads`).first();
      const ready = Number((r && r.ready) || 0);
      if (ready > 0) {
        await pushAll(env, { title: ready + ' email' + (ready > 1 ? 's' : '') + ' ready to approve', body: 'Open the dashboard to approve and send.', url: '/app#home', tag: 'summary' }, s);
        await sendAlert(gm, s, 'Ready to approve: ' + ready + ' email' + (ready > 1 ? 's' : ''),
          ready + ' email draft(s) are waiting for your approval.\n' + Number((r && r.fresh) || 0) + ' lead(s) have not been emailed yet.\n\n' +
          'Open your dashboard: ' + (s.origin ? s.origin + '/app' : '(your dashboard link)') +
          (isYes(s.paused) ? '\n\nNote: sending is paused.' : ''));
      }
      await housekeeping(env);
    }
  } catch (e) {
    if (e instanceof BudgetError) return report;
    if (!(e instanceof GmailAuthError)) await log(env, 'Timer error', '', e.message || String(e));
    report.error = e.message;
  }
  return report;
}
