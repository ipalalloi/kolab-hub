// Uji regresi untuk temuan review PR #1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setup, seedBasic, sendWa, signed, waPayload, lastReply, card, addPerson } from './helpers.js';
import { createHandler } from '../src/server.js';
import { newId, nowIso } from '../src/lib/util.js';
import { performCardAction } from '../src/domain/actions.js';

async function serve(ctx) {
  const server = createServer(createHandler(ctx));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function sessionFor(ctx, personId) {
  const token = await ctx.auth.createSession(personId);
  return { cookie: `kh_sess=${token}` };
}

const call = (base, s, method, path, body) => fetch(base + path, {
  method, headers: { 'content-type': 'application/json', 'x-kolab-csrf': '1', cookie: s.cookie }, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

async function secondWorkspace(ctx) {
  const ws = newId();
  await ctx.db.run('INSERT INTO workspaces (id, name, retention_days, created_at) VALUES (?, ?, 90, ?)', [ws, 'Tim Lain', nowIso()]);
  const stranger = await addPerson(ctx, { name: 'Orang Lain', phone: '6281100000050' });
  await ctx.db.run("INSERT INTO memberships (workspace_id, person_id, role, wip_limit, created_at) VALUES (?, ?, 'owner', 3, ?)", [ws, stranger.id, nowIso()]);
  return { ws, stranger };
}

test('kode kartu polos dari non-anggota tidak membocorkan judul atau status', async () => {
  const ctx = await setup();
  await seedBasic(ctx);
  const { stranger } = await secondWorkspace(ctx);
  await sendWa(ctx, stranger.phone, '#DIS-0001');
  const reply = await lastReply(ctx, stranger.phone);
  assert.doesNotMatch(reply.text, /Survei lokasi/);
  assert.match(reply.text, /bukan anggota/);
});

test('pesan bermasalah workspace A tidak terlihat oleh pemilik workspace B', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  const { ws: wsB, stranger } = await secondWorkspace(ctx);
  await sendWa(ctx, s.budi.phone, '#DIS-0001 mulai rahasia-proyek-A'); // ditolak: bukan tugas Budi
  const msg = await ctx.db.get("SELECT * FROM wa_messages WHERE status = 'rejected'");
  assert.equal(msg.workspace_id, s.ws, 'pesan yang ditolak tetap terikat ke workspace kartunya');
  const { server, base } = await serve(ctx);
  try {
    const rB = await call(base, await sessionFor(ctx, stranger.id), 'GET', `/api/workspaces/${wsB}/review`);
    assert.equal(rB.status, 200);
    assert.equal(rB.data.messages.length, 0);
    const rA = await call(base, await sessionFor(ctx, s.coord.id), 'GET', `/api/workspaces/${s.ws}/review`);
    assert.equal(rA.data.messages.length, 1);
  } finally { server.close(); }
});

test('menerima undangan tidak mengubah peran anggota aktif (pemilik tidak turun jadi kolaborator)', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  const { server, base } = await serve(ctx);
  try {
    const inv = await call(base, await sessionFor(ctx, s.coord.id), 'POST', `/api/workspaces/${s.ws}/invites`, { role: 'collaborator' });
    const guest = { cookie: '' };
    await call(base, guest, 'POST', `/api/join/${inv.data.token}/otp`, { phone: s.owner.phone });
    await ctx.worker.drain();
    const code = (await lastReply(ctx, s.owner.phone)).text.match(/(\d{6})/)[1];
    const j = await call(base, guest, 'POST', `/api/join/${inv.data.token}`, { name: 'Pemilik', phone: s.owner.phone, code, consent: true });
    assert.equal(j.status, 200);
    const m = await ctx.db.get('SELECT role FROM memberships WHERE workspace_id = ? AND person_id = ?', [s.ws, s.owner.id]);
    assert.equal(m.role, 'owner');
  } finally { server.close(); }
});

test('webhook: bila antrean gagal, pesan tidak tersimpan setengah dan pengiriman ulang Meta tetap diproses', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  const payload = waPayload(s.ana.phone, '#DIS-0001 mulai', { id: 'wamid.ATOMIK' });
  const original = ctx.queue.enqueue;
  ctx.queue.enqueue = async () => { throw new Error('antrean mati'); };
  const first = signed(ctx, payload);
  await assert.rejects(ctx.webhook.receive(first.raw, first.sig), /antrean mati/);
  ctx.queue.enqueue = original;
  assert.equal(await ctx.db.get("SELECT * FROM wa_messages WHERE meta_id = 'wamid.ATOMIK'"), null, 'transaksi dibatalkan');
  const retry = signed(ctx, payload);
  const r = await ctx.webhook.receive(retry.raw, retry.sig);
  assert.equal(r.accepted, 1);
  await ctx.worker.drain();
  assert.equal((await card(ctx, 'DIS-0001')).column_key, 'dikerjakan');
});

test('usulan dari anggota yang sudah keluar: kartu tanpa penanggung jawab, tanpa notifikasi', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  await sendWa(ctx, s.budi.phone, '#baru DIS Pinjam alat');
  await ctx.db.run('UPDATE memberships SET removed_at = ? WHERE person_id = ?', [nowIso(), s.budi.id]);
  const before = Number((await ctx.db.get('SELECT COUNT(*) AS n FROM wa_outbox WHERE person_id = ?', [s.budi.id])).n);
  const pr = await ctx.db.get('SELECT * FROM proposals');
  const { server, base } = await serve(ctx);
  try {
    const r = await call(base, await sessionFor(ctx, s.coord.id), 'POST', `/api/proposals/${pr.id}/accept`, {});
    assert.equal(r.status, 200);
    assert.equal((await card(ctx, r.data.code)).assignee_id, null);
    await ctx.worker.drain();
    assert.equal(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM wa_outbox WHERE person_id = ?', [s.budi.id])).n), before);
    const bad = await call(base, await sessionFor(ctx, s.coord.id), 'POST', `/api/proposals/${pr.id}/accept`, {});
    assert.equal(bad.status, 404, 'usulan sudah diputuskan');
  } finally { server.close(); }
});

test('aksi kartu memakai keadaan terbaru, bukan salinan basi', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  const stale = await card(ctx, 'DIS-0001'); // dibaca saat masih "masuk"
  await ctx.db.tx((t) => performCardAction(t, { card: stale, actor: { person_id: s.ana.id }, action: 'mulai', source: 'web' }));
  // Salinan basi masih "masuk"; tanpa kunci + baca ulang, "mulai" kedua akan lolos dan menulis event ganda.
  await assert.rejects(ctx.db.tx((t) => performCardAction(t, { card: stale, actor: { person_id: s.ana.id }, action: 'mulai', source: 'wa' })), /sudah dikerjakan/);
  const n = await ctx.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'card.started'");
  assert.equal(Number(n.n), 1);
});

test('aliran SSE berhenti mengirim event setelah anggota dikeluarkan', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  const { server, base } = await serve(ctx);
  const ac = new AbortController();
  try {
    const sess = await sessionFor(ctx, s.ana.id);
    const res = await fetch(`${base}/api/stream`, { headers: { cookie: sess.cookie }, signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    let text = '';
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } } catch {} })();
    await ctx.db.run('UPDATE memberships SET removed_at = ? WHERE person_id = ?', [nowIso(), s.ana.id]);
    await sendWa(ctx, s.coord.phone, '#DIS-0001 rahasia setelah dikeluarkan');
    await new Promise((r) => setTimeout(r, 2000));
    ac.abort();
    await pump;
    assert.doesNotMatch(text, /rahasia setelah dikeluarkan/);
  } finally { ac.abort(); server.close(); }
});
