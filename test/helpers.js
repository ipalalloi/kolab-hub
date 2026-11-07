import { openSqlite } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';
import { makeContext } from '../src/app.js';
import { hmacHex } from '../src/lib/crypto.js';
import { newId, nowIso } from '../src/lib/util.js';
import { createCard, defaultColumns } from '../src/domain/store.js';

export const silent = { log() {}, error() {}, warn() {} };

export async function setup(env = {}) {
  const cfg = loadConfig({ NODE_ENV: 'test', WA_MODE: 'simulate', BASE_URL: 'http://localhost:3999', ...env });
  const db = await openSqlite(':memory:');
  await migrate(db);
  const ctx = makeContext({ cfg, db, log: silent });
  return ctx;
}

export async function addPerson(ctx, { name, phone, verified = true }) {
  const id = newId();
  await ctx.db.run('INSERT INTO people (id, name, phone_enc, phone_hash, verified_at, consent_at, consent_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, ctx.crypto.encrypt(phone), ctx.crypto.blindIndex(phone), verified ? nowIso() : null, nowIso(), 'test', nowIso()]);
  return { id, name, phone };
}

export async function seedBasic(ctx) {
  const ws = newId();
  await ctx.db.run('INSERT INTO workspaces (id, name, retention_days, created_at) VALUES (?, ?, 90, ?)', [ws, 'Tim Uji', nowIso()]);
  const owner = await addPerson(ctx, { name: 'Pemilik', phone: '6281100000001' });
  const coord = await addPerson(ctx, { name: 'Koordinator', phone: '6281100000002' });
  const ana = await addPerson(ctx, { name: 'Ana', phone: '6281100000003' });
  const budi = await addPerson(ctx, { name: 'Budi', phone: '6281100000004' });
  for (const [p, role] of [[owner, 'owner'], [coord, 'coordinator'], [ana, 'collaborator'], [budi, 'collaborator']]) {
    await ctx.db.run('INSERT INTO memberships (workspace_id, person_id, role, wip_limit, created_at) VALUES (?, ?, ?, 3, ?)', [ws, p.id, role, nowIso()]);
  }
  const boardId = newId();
  await ctx.db.run('INSERT INTO boards (id, workspace_id, name, prefix, columns, created_at) VALUES (?, ?, ?, ?, ?, ?)', [boardId, ws, 'Disertasi', 'DIS', JSON.stringify(defaultColumns()), nowIso()]);
  const board = await ctx.db.get('SELECT * FROM boards WHERE id = ?', [boardId]);
  const card = await ctx.db.tx(async (t) => (await createCard(t, { board, title: 'Survei lokasi', assignee_id: ana.id, actor_id: coord.id, source: 'web' })).card);
  return { ws, owner, coord, ana, budi, board, card };
}

let counter = 0;
export function waPayload(from, text, { id, context, media } = {}) {
  const msg = { from, id: id || `wamid.T${++counter}${Date.now()}`, timestamp: '1700000000' };
  if (media) Object.assign(msg, { type: media, [media]: { id: `m${counter}`, mime_type: 'image/jpeg', caption: text || '' } });
  else Object.assign(msg, { type: 'text', text: { body: text } });
  if (context) msg.context = { id: context };
  return { object: 'whatsapp_business_account', entry: [{ id: 'X', changes: [{ field: 'messages', value: { messages: [msg] } }] }] };
}

export function signed(ctx, payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  return { raw, sig: `sha256=${hmacHex(ctx.cfg.wa.appSecret, raw)}` };
}

/** Kirim pesan WA lewat webhook yang ditandatangani, lalu kosongkan antrean. */
export async function sendWa(ctx, from, text, opts) {
  const { raw, sig } = signed(ctx, waPayload(from, text, opts));
  const r = await ctx.webhook.receive(raw, sig);
  await ctx.worker.drain();
  return r;
}

export async function lastReply(ctx, phone) {
  const row = await ctx.db.get('SELECT * FROM wa_outbox WHERE phone_hash = ? ORDER BY created_at DESC, id DESC LIMIT 1', [ctx.crypto.blindIndex(phone)]);
  return row ? { ...row, text: ctx.crypto.decrypt(row.body_enc) } : null;
}

export async function card(ctx, code) {
  return ctx.db.get('SELECT * FROM cards WHERE code = ?', [code]);
}

/** Jalankan server HTTP uji pada port acak. */
export async function startServer(ctx) {
  const { createServer } = await import('node:http');
  const { createHandler } = await import('../src/server.js');
  const server = createServer(createHandler(ctx));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** Masuk lewat OTP (kode dibaca dari outbox simulasi); mengembalikan pemanggil API ber-cookie. */
export async function login(ctx, base, phone) {
  const H = { 'content-type': 'application/json', 'x-kolab-csrf': '1' };
  await fetch(`${base}/api/auth/otp`, { method: 'POST', headers: H, body: JSON.stringify({ phone }) });
  const code = (await lastReply(ctx, phone)).text.match(/(\d{6})/)[1];
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ phone, code }) });
  if (r.status !== 200) throw new Error(`login gagal ${r.status}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { ...H, cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}

/** Langganan push palsu dengan kunci P-256 asli, seperti yang dibuat peramban. */
export async function fakeBrowserSubscription(n = 1) {
  const { createECDH, randomBytes } = await import('node:crypto');
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16).toString('base64url');
  return {
    subscription: { endpoint: `https://push.contoh.test/kirim/${n}-${randomBytes(4).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth } },
    uaPrivateKey: ecdh.getPrivateKey().toString('base64url'),
    auth,
  };
}

/** Layanan push palsu: mencatat permintaan dan membalas sesuai `status(endpoint)`. */
export function fakePushService(status = () => 201) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, ...init }); return { status: status(url, calls.length) }; };
  fn.calls = calls;
  return fn;
}
