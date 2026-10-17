// Database layout and small helpers. Tables are created automatically on first use.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    first_name TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    business_type TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    notes TEXT NOT NULL DEFAULT '',
    unsub_token TEXT,
    draft_id TEXT,
    drafted_at INTEGER,
    draft_subject TEXT,
    draft_body TEXT,
    subject TEXT,
    thread_id TEXT,
    message_id TEXT,
    sent_at INTEGER,
    followup_due INTEGER,
    followup_sent_at INTEGER,
    replied_at INTEGER,
    reply_snippet TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, id)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_thread ON leads(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_due ON leads(status, followup_due)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_country ON leads(country)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_unsub ON leads(unsub_token)`,
  `CREATE TABLE IF NOT EXISTS enquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', quantity TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new'
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT, email TEXT, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_ok INTEGER)`,
  `CREATE TABLE IF NOT EXISTS lists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS quotes (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, company TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', currency TEXT NOT NULL, qty INTEGER NOT NULL, unit_price TEXT NOT NULL, total TEXT NOT NULL, payment_terms TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}')`
];

let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new Error('The database is not connected. Check the D1 binding named DB.');
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  await migrateLists(env);
  await migrateSender(env);
  await migrateTemplates(env);
  schemaReady = true;
}

// Remembers which Gmail account sent each lead's first email, so follow-ups still work after switching accounts.
async function migrateSender(env) {
  const cols = (await env.DB.prepare('PRAGMA table_info(leads)').all()).results.map(c => c.name);
  if (cols.indexOf('sent_from') >= 0) return;
  await env.DB.prepare('ALTER TABLE leads ADD COLUMN sent_from TEXT').run();
  const g = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'gmail_email'`).first();
  const p = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'gmail_prev'`).first();
  const who = String((g && g.value) || (p && p.value) || '').trim().toLowerCase();
  if (who) await env.DB.prepare('UPDATE leads SET sent_from = ? WHERE sent_from IS NULL AND thread_id IS NOT NULL').bind(who).run();
}

// One-time fixes to saved email templates: add the company email line, and stop promising shipping-inclusive prices.
const TPL_FIXES = [
  ['A clear written quote per vial, including shipping to {{Country}}', 'A clear written quote per vial (shipping quoted separately)'],
  ["I'll reply with a price including shipping to {{Country}}, usually within one business day.", "I'll reply with a price per vial, usually within one business day."]
];
export function fixTemplate(t) {
  let v = String(t || '');
  for (const [a, b] of TPL_FIXES) v = v.split(a).join(b);
  if (v.indexOf('{{MainEmail}}') < 0) v = v.replace(/^(WhatsApp: \{\{WhatsApp\}\})$/m, '$1\nCompany email: {{MainEmail}}');
  return v;
}
async function migrateTemplates(env) {
  const done = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'tpl_fix_v2'`).first();
  if (done) return;
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings WHERE key IN ('tpl_first_body', 'tpl_fu_body')`).all();
  const stmts = [];
  for (const r of results) {
    const v = fixTemplate(r.value);
    if (v !== r.value) stmts.push(env.DB.prepare('UPDATE settings SET value = ? WHERE key = ?').bind(v, r.key));
  }
  stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES('tpl_fix_v2', '1')`));
  await env.DB.batch(stmts);
}

// Lead lists: every import becomes its own list. Older leads (before lists existed) are split by country.
const niceCountry = c => String(c || '').replace(/^the\s+/i, '').trim();
export async function getOrCreateList(env, name) {
  name = String(name || '').trim().slice(0, 80) || 'Imported leads';
  const found = await env.DB.prepare('SELECT id FROM lists WHERE name = ?').bind(name).first();
  if (found) return found.id;
  const r = await env.DB.prepare('INSERT INTO lists(name, active, created_at) VALUES(?, 1, ?)').bind(name, Date.now()).run();
  return r.meta.last_row_id;
}
async function migrateLists(env) {
  const cols = (await env.DB.prepare('PRAGMA table_info(leads)').all()).results.map(c => c.name);
  if (cols.indexOf('list_id') < 0) {
    await env.DB.prepare('ALTER TABLE leads ADD COLUMN list_id INTEGER').run();
  }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_leads_list ON leads(list_id, status)').run();
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM leads WHERE list_id IS NULL').first();
  if (!left || !Number(left.n)) return;
  // website quote requests get their own list
  const web = await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads WHERE list_id IS NULL AND source = 'Website form'`).first();
  if (web && Number(web.n)) {
    const id = await getOrCreateList(env, 'Website enquiries');
    await env.DB.prepare(`UPDATE leads SET list_id = ? WHERE list_id IS NULL AND source = 'Website form'`).bind(id).run();
  }
  const { results } = await env.DB.prepare('SELECT country, COUNT(*) AS n FROM leads WHERE list_id IS NULL GROUP BY country ORDER BY n DESC').all();
  for (const r of results) {
    const c = niceCountry(r.country);
    const id = await getOrCreateList(env, c ? c + ' leads' : 'Other leads');
    await env.DB.prepare('UPDATE leads SET list_id = ? WHERE list_id IS NULL AND country = ?').bind(id, r.country).run();
  }
  // anything left (e.g. country NULL)
  const other = await env.DB.prepare('SELECT COUNT(*) AS n FROM leads WHERE list_id IS NULL').first();
  if (other && Number(other.n)) {
    const id = await getOrCreateList(env, 'Other leads');
    await env.DB.prepare('UPDATE leads SET list_id = ? WHERE list_id IS NULL').bind(id).run();
  }
}

export const DEFAULT_TEMPLATES = {
  tpl_first_subject: 'Bacteriostatic Water for Injection USP 30 mL – supply for {{Company}}',
  tpl_first_body:
`Dear {{FirstName}},

I'm {{YourName}} from {{CompanyName}}, an Indian supplier and exporter of Bacteriostatic Water for Injection USP. I'm writing because {{Company}} may use or distribute sterile diluents in {{Country}}, and we can supply them reliably.

Product
- Bacteriostatic Water for Injection USP, 30 mL multi-dose vial
- Water for Injection USP with 0.9% Benzyl Alcohol USP as preservative
- Sterile and non-pyrogenic, 36-month shelf life
- Certificate of Analysis (CoA) from the manufacturer with every batch

What we offer
- A clear written quote per vial (shipping quoted separately)
- Stock packed and ready to dispatch
- Export documents prepared by us (GST registered, with an Import Export Code)

Product brochure: {{BrochureLink}}

If this is relevant, reply with the quantity you need and your delivery city, and I'll send a quote. If someone else at {{Company}} handles purchasing, I'd be grateful if you could point me to them.

Best regards,
{{YourName}}
{{CompanyName}}
{{Address}}
WhatsApp: {{WhatsApp}}
Company email: {{MainEmail}}
{{Website}}

If you'd prefer not to hear from us, reply "unsubscribe" and we won't contact you again.`,
  tpl_fu_body:
`Dear {{FirstName}},

Following up on my note about Bacteriostatic Water for Injection USP 30 mL vials for {{Company}}.

If you already source this diluent, we'd be glad to quote against your current supplier. Send the quantity and delivery city, and I'll reply with a price per vial, usually within one business day.

Brochure: {{BrochureLink}}

Best regards,
{{YourName}}
{{CompanyName}}
{{Address}}
WhatsApp: {{WhatsApp}}
Company email: {{MainEmail}}

Reply "unsubscribe" and we won't contact you again.`
};

// Settings the owner can change in the dashboard
export const EDITABLE = {
  your_name: 'Shivam',
  company_name: 'Shree Pharma',
  whatsapp: '+91 86696 66250',
  main_email: 'shreepharma.in@gmail.com',
  address: '',
  website: '',
  brochure_link: '',
  alert_email: 'shreepharma.in@gmail.com',
  daily_limit: '20',
  followup_days: '4',
  stop_days: '10',
  auto_drafts: 'yes',
  paused: 'no',
  ...DEFAULT_TEMPLATES
};

export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { ...EDITABLE };
  for (const r of results) s[r.key] = r.value == null ? '' : r.value;
  return s;
}

export async function setSettings(env, obj) {
  const stmts = Object.entries(obj).map(([k, v]) =>
    env.DB.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(k, v == null ? '' : String(v)));
  if (stmts.length) await env.DB.batch(stmts);
}

export async function log(env, action, email, detail) {
  try {
    await env.DB.prepare('INSERT INTO log(at, action, email, detail) VALUES(?, ?, ?, ?)')
      .bind(Date.now(), String(action || ''), String(email || ''), String(detail || '').slice(0, 500)).run();
  } catch (e) { console.error('log failed', e); }
}

export async function counter(env, key) {
  const r = await env.DB.prepare('SELECT n FROM counters WHERE key = ?').bind(key).first();
  return r ? Number(r.n) : 0;
}
export async function bump(env, key, by = 1) {
  const r = await env.DB.prepare(
    'INSERT INTO counters(key, n, at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET n = n + excluded.n, at = excluded.at RETURNING n'
  ).bind(key, by, Date.now()).first();
  return r ? Number(r.n) : by;
}

export async function housekeeping(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM seen WHERE at < ?').bind(now - 30 * 86400000),
    env.DB.prepare('DELETE FROM counters WHERE at < ? AND key NOT LIKE ?').bind(now - 40 * 86400000, 'keep:%'),
    env.DB.prepare('DELETE FROM log WHERE id < (SELECT COALESCE(MAX(id), 0) - 5000 FROM log)')
  ]);
}
