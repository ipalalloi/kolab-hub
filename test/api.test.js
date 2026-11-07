import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setup, seedBasic, lastReply, card } from './helpers.js';
import { createHandler } from '../src/server.js';

let ctx; let s; let server; let base;

before(async () => {
  ctx = await setup();
  s = await seedBasic(ctx);
  server = createServer(createHandler(ctx));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function client() {
  let cookie = '';
  const call = async (method, path, body, { csrf = true, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(csrf ? { 'x-kolab-csrf': '1' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { call, get cookie() { return cookie; } };
}

async function otpFromOutbox(phone) {
  const r = await lastReply(ctx, phone);
  return r.text.match(/(\d{6})/)[1];
}

const sessions = new Map();
async function login(phone) {
  if (sessions.has(phone)) return sessions.get(phone);
  const c = client();
  sessions.set(phone, c);
  assert.equal((await c.call('POST', '/api/auth/otp', { phone })).status, 200);
  await ctx.worker.drain();
  const r = await c.call('POST', '/api/auth/login', { phone, code: await otpFromOutbox(phone) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  return c;
}

test('header keamanan dan health check', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('tanpa sesi ditolak; CSRF wajib untuk perubahan', async () => {
  const c = client();
  assert.equal((await c.call('GET', '/api/me')).status, 401);
  assert.equal((await c.call('POST', '/api/auth/otp', { phone: s.ana.phone }, { csrf: false })).status, 403);
  assert.equal((await c.call('POST', '/api/auth/otp', { phone: s.ana.phone }, { headers: { origin: 'https://jahat.example' } })).status, 403);
});

test('login OTP: kode salah ditolak, kode benar membuat sesi', async () => {
  const c = client();
  await c.call('POST', '/api/auth/otp', { phone: '0811-0000-0003' });
  await ctx.worker.drain();
  assert.equal((await c.call('POST', '/api/auth/login', { phone: s.ana.phone, code: '000000' })).status, 400);
  const ok = await c.call('POST', '/api/auth/login', { phone: s.ana.phone, code: await otpFromOutbox(s.ana.phone) });
  assert.equal(ok.status, 200);
  const me = await c.call('GET', '/api/me');
  assert.equal(me.data.person.name, 'Ana');
  assert.match(me.data.person.phone, /\*\*\*\*/, 'nomor disamarkan');
});

test('peran: kolaborator tidak bisa membuat proyek atau kartu; koordinator bisa', async () => {
  const ana = await login(s.ana.phone);
  assert.equal((await ana.call('POST', `/api/workspaces/${s.ws}/boards`, { name: 'X', prefix: 'XX' })).status, 403);
  assert.equal((await ana.call('POST', `/api/boards/${s.board.id}/cards`, { title: 'X' })).status, 403);
  const coord = await login(s.coord.phone);
  const b = await coord.call('POST', `/api/workspaces/${s.ws}/boards`, { name: 'Penelitian', prefix: 'pen' });
  assert.equal(b.status, 200);
  assert.equal(b.data.prefix, 'PEN');
  assert.equal((await coord.call('POST', `/api/workspaces/${s.ws}/boards`, { name: 'Lagi', prefix: 'PEN' })).status, 409);
  const c = await coord.call('POST', `/api/boards/${b.data.id}/cards`, { title: 'Kuesioner', assignee_id: s.budi.id, due_date: '2026-11-20' });
  assert.equal(c.status, 200);
  assert.equal(c.data.code, 'PEN-0001');
  await ctx.worker.drain();
  assert.match((await lastReply(ctx, s.budi.phone)).text, /Tugas baru PEN-0001/);
});

test('aksi kartu dari web/PWA, riwayat, dan koreksi lewat pembatalan event', async () => {
  const ana = await login(s.ana.phone);
  const coord = await login(s.coord.phone);
  let r = await ana.call('POST', '/api/cards/DIS-0001/actions', { action: 'progres', percent: 30 }, { headers: { 'x-kolab-client': 'pwa' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.column_key, 'dikerjakan');
  r = await ana.call('POST', '/api/cards/DIS-0001/actions', { action: 'selesai' });
  assert.equal(r.data.column_key, 'ditinjau');
  assert.equal((await ana.call('POST', '/api/cards/DIS-0001/actions', { action: 'setujui' })).status, 403);
  r = await coord.call('POST', '/api/cards/DIS-0001/actions', { action: 'revisi' });
  assert.equal(r.status, 400, 'catatan revisi wajib');
  r = await coord.call('POST', '/api/cards/DIS-0001/actions', { action: 'setujui' });
  assert.equal(r.data.column_key, 'selesai');

  const detail = await coord.call('GET', '/api/cards/DIS-0001');
  const approved = detail.data.events.find((e) => e.type === 'card.approved');
  assert.equal(detail.data.events.find((e) => e.type === 'card.progress').source, 'pwa');
  assert.equal((await ana.call('POST', `/api/events/${approved.seq}/revert`, { reason: 'x' })).status, 403);
  r = await coord.call('POST', `/api/events/${approved.seq}/revert`, { reason: 'salah klik' });
  assert.equal(r.status, 200);
  assert.equal((await card(ctx, 'DIS-0001')).column_key, 'ditinjau');
  assert.equal((await coord.call('POST', `/api/events/${approved.seq}/revert`, {})).status, 409);
  const after = await coord.call('GET', '/api/cards/DIS-0001');
  assert.equal(after.data.events.find((e) => e.seq === approved.seq).reverted, true, 'riwayat asli tetap ada');
});

test('undangan → OTP → persetujuan → anggota terverifikasi', async () => {
  const owner = await login(s.owner.phone);
  const inv = await owner.call('POST', `/api/workspaces/${s.ws}/invites`, { role: 'collaborator' });
  assert.equal(inv.status, 200);
  const guest = client();
  const info = await guest.call('GET', `/api/join/${inv.data.token}`);
  assert.equal(info.data.workspace_name, 'Tim Uji');
  await guest.call('POST', `/api/join/${inv.data.token}/otp`, { phone: '081100000777' });
  await ctx.worker.drain();
  const code = await otpFromOutbox('6281100000777');
  assert.equal((await guest.call('POST', `/api/join/${inv.data.token}`, { name: 'Citra', phone: '081100000777', code, consent: false })).status, 400);
  const j = await guest.call('POST', `/api/join/${inv.data.token}`, { name: 'Citra', phone: '081100000777', code, consent: true });
  assert.equal(j.status, 200, JSON.stringify(j.data));
  const me = await guest.call('GET', '/api/me');
  assert.equal(me.data.memberships[0].role, 'collaborator');
  assert.equal((await client().call('GET', `/api/join/${inv.data.token}`)).status, 404, 'undangan sekali pakai');
});

test('retensi per workspace dibatasi 30–365 hari dan dicatat di audit', async () => {
  const owner = await login(s.owner.phone);
  assert.equal((await owner.call('PATCH', `/api/workspaces/${s.ws}`, { retention_days: 10 })).status, 400);
  assert.equal((await owner.call('PATCH', `/api/workspaces/${s.ws}`, { retention_days: 400 })).status, 400);
  assert.equal((await owner.call('PATCH', `/api/workspaces/${s.ws}`, { retention_days: 180 })).status, 200);
  const coord = await login(s.coord.phone);
  assert.equal((await coord.call('PATCH', `/api/workspaces/${s.ws}`, { retention_days: 60 })).status, 403);
  const log = await owner.call('GET', `/api/workspaces/${s.ws}/audit`);
  assert.ok(log.data.some((a) => a.action === 'workspace.updated' && a.detail.retention_days[1] === 180));
  const tr = await owner.call('GET', `/api/workspaces/${s.ws}/transfers`);
  assert.equal(tr.status, 200);
});

test('simulasi WA lewat API dan usulan diterima jadi kartu', async () => {
  const c = client();
  const r = await c.call('POST', '/api/sim/inbound', { phone: s.budi.phone, text: '#baru DIS Pinjam alat ukur' });
  assert.equal(r.data.webhook_status, 200);
  await ctx.worker.drain();
  const coord = await login(s.coord.phone);
  const props = await coord.call('GET', `/api/workspaces/${s.ws}/proposals`);
  const pr = props.data.find((p) => p.title === 'Pinjam alat ukur');
  assert.ok(pr);
  const acc = await coord.call('POST', `/api/proposals/${pr.id}/accept`, {});
  assert.equal(acc.status, 200);
  const made = await card(ctx, acc.data.code);
  assert.equal(made.assignee_id, s.budi.id);
  const outbox = await c.call('GET', '/api/sim/outbox');
  assert.ok(outbox.data.some((m) => m.text.includes(acc.data.code)));
});

test('batas permintaan OTP: maksimal 3 per 15 menit per nomor', async () => {
  const c = client();
  const phone = '6281100000555';
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await c.call('POST', '/api/join/x/otp', { phone })).status);
  // undangan tidak valid → 404 sebelum OTP; uji langsung lewat modul auth
  assert.ok(codes.every((x) => x === 404));
  for (let i = 0; i < 3; i++) await ctx.auth.requestOtp(phone, 'join');
  await assert.rejects(ctx.auth.requestOtp(phone, 'join'), /Terlalu banyak/);
});

test('hak subjek data: ekspor dan hapus akun', async () => {
  const budi = await login(s.budi.phone);
  const ex = await budi.call('GET', '/api/me/export');
  assert.equal(ex.status, 200);
  assert.equal(ex.data.person.phone, s.budi.phone);
  assert.match(ex.headers.get('content-disposition'), /attachment/);
  assert.equal((await budi.call('DELETE', '/api/me')).status, 200);
  const p = await ctx.db.get('SELECT * FROM people WHERE id = ?', [s.budi.id]);
  assert.equal(p.phone_enc, null);
  assert.equal(p.name, 'Mantan anggota');
  assert.equal((await budi.call('GET', '/api/me')).status, 401);
});
