// Fase 2 — mode luring: tindakan dari antrean perangkat dikirim ulang tanpa tercatat ganda.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, seedBasic, startServer, login } from './helpers.js';
import { parseOfflineAt } from '../src/domain/actions.js';

let ctx; let s; let server; let base; let ana; let budi; let koor;
before(async () => {
  ctx = await setup();
  s = await seedBasic(ctx);
  ({ server, base } = await startServer(ctx));
  ana = await login(ctx, base, s.ana.phone);
  budi = await login(ctx, base, s.budi.phone);
  koor = await login(ctx, base, s.coord.phone);
});
after(() => server.close());

const events = async (type) => ctx.db.all('SELECT * FROM events WHERE type = ? ORDER BY seq', [type]);

test('parseOfflineAt: hanya waktu wajar (≤ 7 hari lalu, tidak di masa depan) yang diterima', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(parseOfflineAt('2026-11-07T11:00:00.000Z', now), '2026-11-07T11:00:00.000Z');
  assert.equal(parseOfflineAt('2026-11-07T12:03:00Z', now), '2026-11-07T12:03:00.000Z', 'toleransi jam perangkat 5 menit');
  for (const bad of ['2026-11-07T13:00:00Z', '2026-10-30T11:00:00Z', 'kemarin', '', null, 123, '2026-11-07']) assert.equal(parseOfflineAt(bad, now), null, String(bad));
});

test('kiriman ulang dengan op_id yang sama tidak mencatat event dua kali', async () => {
  const op = 'op0000000001';
  const queued_at = new Date(Date.now() - 3600_000).toISOString();
  const r1 = await ana('POST', '/api/cards/DIS-0001/actions', { action: 'mulai', queued_at }, { 'x-kolab-op-id': op });
  const r2 = await ana('POST', '/api/cards/DIS-0001/actions', { action: 'mulai', queued_at }, { 'x-kolab-op-id': op });
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get('x-kolab-op-replayed'), '1');
  assert.equal(r2.data.column_key, 'dikerjakan');
  const started = await events('card.started');
  assert.equal(started.length, 1);
  assert.equal(JSON.parse(started[0].payload).offline_at, queued_at, 'waktu luring tercatat');
});

test('queued_at diabaikan tanpa op_id (hanya antrean luring yang boleh mengklaim waktu lampau)', async () => {
  await ana('POST', '/api/cards/DIS-0001/actions', { action: 'progres', percent: 20, queued_at: new Date(Date.now() - 3600_000).toISOString() });
  const ev = (await events('card.progress')).at(-1);
  assert.equal(JSON.parse(ev.payload).offline_at, undefined);
});

test('penolakan aturan dicatat untuk op_id: kiriman ulang mendapat penolakan yang sama', async () => {
  const op = 'op0000000002';
  const r1 = await ana('POST', '/api/cards/DIS-0001/actions', { action: 'mulai' }, { 'x-kolab-op-id': op });
  assert.equal(r1.status, 409, 'sudah dikerjakan');
  const r2 = await ana('POST', '/api/cards/DIS-0001/actions', { action: 'mulai' }, { 'x-kolab-op-id': op });
  assert.equal(r2.status, 409);
  assert.equal(r2.data.error, r1.data.error);
});

test('konflik luring: perubahan orang lain lebih dulu diterima, tindakan luring divalidasi terhadap keadaan terbaru', async () => {
  // Ana luring menandai selesai; sementara itu koordinator menahan kartu.
  const queued_at = new Date(Date.now() - 600_000).toISOString();
  await koor('POST', '/api/cards/DIS-0001/actions', { action: 'tahan', reason: 'menunggu izin' });
  const r = await ana('POST', '/api/cards/DIS-0001/actions', { action: 'selesai', queued_at }, { 'x-kolab-op-id': 'op0000000003' });
  // Aturan saat ini mengizinkan selesai dari Tertahan; yang penting: tercatat sekali, bertanda luring, setelah event tahan.
  assert.equal(r.status, 200);
  const done = await events('card.done');
  const held = (await events('card.held')).at(-1);
  assert.equal(done.length, 1);
  assert.ok(Number(done[0].seq) > Number(held.seq));
  assert.equal(JSON.parse(done[0].payload).offline_at, queued_at);
});

test('op_id tidak sah ditolak; op_id milik orang lain tidak dapat dipakai ulang', async () => {
  assert.equal((await ana('POST', '/api/cards/DIS-0001/actions', { action: 'komentar', text: 'x' }, { 'x-kolab-op-id': 'pendek' })).status, 400);
  assert.equal((await ana('POST', '/api/cards/DIS-0001/actions', { action: 'komentar', text: 'x' }, { 'x-kolab-op-id': 'op dengan spasi!!' })).status, 400);
  const r = await budi('POST', '/api/cards/DIS-0001/actions', { action: 'komentar', text: 'x' }, { 'x-kolab-op-id': 'op0000000001' });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'op_conflict');
});
