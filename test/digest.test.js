// Fase 2 — ringkasan harian: satu pesan per orang per hari, push dulu, WA template sebagai cadangan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, seedBasic, fakeBrowserSubscription, fakePushService, startServer, login } from './helpers.js';
import { localParts } from '../src/notify/digest.js';
import { performCardAction } from '../src/domain/actions.js';
import { createCard } from '../src/domain/store.js';
import { generateVapidKeys, decryptPayload } from '../src/push/webpush.js';

const DAY = '2026-11-07';

test('localParts: jam lokal dihitung di zona DIGEST_TZ', () => {
  assert.deepEqual(localParts(Date.parse('2026-11-06T23:30:00Z'), 'Asia/Makassar'), { day: '2026-11-07', hhmm: '07:30' });
  assert.deepEqual(localParts(Date.parse('2026-11-06T23:30:00Z'), 'Asia/Jakarta'), { day: '2026-11-07', hhmm: '06:30' });
});

test('penjadwal: tidak jalan sebelum DIGEST_TIME, sekali sehari sesudahnya', async () => {
  const ctx = await setup({ DIGEST_TIME: '07:00', DIGEST_TZ: 'Asia/Makassar' });
  // Pemasangan pertama (pukul 23.00) hanya menandai hari itu; tidak mengirim malam-malam.
  assert.equal(await ctx.digest.maybeSchedule(Date.parse('2026-11-05T15:00:00Z')), false, 'pemasangan pertama');
  assert.equal(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM jobs WHERE type = 'digest.run'")).n), 0);
  assert.equal(await ctx.digest.maybeSchedule(Date.parse('2026-11-06T22:59:00Z')), false, '06:59 WITA');
  assert.equal(await ctx.digest.maybeSchedule(Date.parse('2026-11-06T23:01:00Z')), true, '07:01 WITA');
  assert.equal(await ctx.digest.maybeSchedule(Date.parse('2026-11-06T23:05:00Z')), false, 'sudah diantrekan');
  await ctx.worker.drain();
  assert.equal(await ctx.digest.maybeSchedule(Date.parse('2026-11-07T10:00:00Z')), false, 'sudah terkirim hari ini');
  assert.equal(await ctx.digest.maybeSchedule(Date.parse('2026-11-07T23:01:00Z')), true, 'besok jalan lagi');
  const off = await setup({ DIGEST_ENABLED: 'false' });
  await off.db.run("INSERT INTO kv (key, value) VALUES ('digest.last_day', '2026-11-01')");
  assert.equal(await off.digest.maybeSchedule(Date.parse('2026-11-06T23:01:00Z')), false);
});

async function scenario(env = {}) {
  const ctx = await setup(env);
  const s = await seedBasic(ctx);
  const act = (card, who, action, args = {}) => ctx.db.tx((t) => performCardAction(t, { card, actor: { person_id: who.id }, action, args, source: 'web' }));
  // Ana: kartu terlambat + kartu tenggat hari ini (sedang dikerjakan).
  await act(s.card, s.coord, 'ubah', { due_date: '2026-11-01' });
  const c2 = await ctx.db.tx(async (t) => (await createCard(t, { board: s.board, title: 'Olah data\nbaris baru', assignee_id: s.ana.id, due_date: DAY, actor_id: s.coord.id, source: 'web' })).card);
  await act(c2, s.ana, 'mulai');
  await act(c2, s.ana, 'selesai'); // menunggu tinjauan → koordinator & pemilik punya antrean
  const waBefore = Number((await ctx.db.get('SELECT COUNT(*) AS n FROM wa_outbox')).n);
  return { ctx, s, waBefore };
}

const outboxFor = (ctx, p) => ctx.db.all("SELECT * FROM wa_outbox WHERE person_id = ? AND kind = 'template' ORDER BY created_at", [p.id]);

test('isi ringkasan: terlambat, tenggat hari ini, tinjauan; orang tanpa apa pun dilewati', async () => {
  const { ctx, s } = await scenario();
  await ctx.digest.run({ day: DAY });
  await ctx.worker.drain();
  const ana = await outboxFor(ctx, s.ana);
  const coord = await outboxFor(ctx, s.coord);
  const budi = await outboxFor(ctx, s.budi);
  assert.equal(ana.length, 1);
  assert.equal(coord.length, 1);
  assert.equal(budi.length, 0, 'Budi tidak punya tugas dan bukan koordinator: tidak dikirimi');
  const text = ctx.crypto.decrypt(ana[0].body_enc);
  assert.match(text, /2 tugas aktif, 1 terlambat, 1 tenggat hari ini/);
  assert.match(text, /DIS-0001 Survei lokasi — Masuk ⚠️terlambat/);
  assert.match(text, /DIS-0002 Olah data baris baru — Ditinjau 100% ⏰hari ini/, 'judul satu baris');
  assert.match(ctx.crypto.decrypt(coord[0].body_enc), /1 menunggu tinjauan/);
  // Parameter template WA tidak boleh mengandung baris baru.
  const tpl = JSON.parse(ctx.crypto.decrypt(ana[0].template));
  assert.equal(tpl.name, 'kolab_ringkasan_harian');
  for (const p of tpl.components[0].parameters) assert.ok(!/\n/.test(p.text), p.text);
});

test('satu pesan per orang per hari walau run dijalankan dua kali', async () => {
  const { ctx, s } = await scenario();
  await ctx.digest.run({ day: DAY });
  await ctx.digest.run({ day: DAY });
  await ctx.worker.drain();
  assert.equal((await outboxFor(ctx, s.ana)).length, 1);
});

test('kanal: push bila berlangganan (tanpa WA); "wa" memaksa WA; "push" tanpa perangkat dan "off" tidak mengirim', async () => {
  const k = generateVapidKeys();
  const { ctx, s } = await scenario({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: 'mailto:a@b.id' });
  ctx.push.fetch = fakePushService();
  const dev = await fakeBrowserSubscription();
  await ctx.db.tx((t) => ctx.push.subscribe(t, s.ana.id, dev.subscription));
  const devOwner = await fakeBrowserSubscription();
  await ctx.db.tx((t) => ctx.push.subscribe(t, s.owner.id, devOwner.subscription));
  await ctx.db.run("UPDATE people SET digest_channel = 'wa' WHERE id = ?", [s.owner.id]);
  await ctx.db.run("UPDATE people SET digest_channel = 'push' WHERE id = ?", [s.coord.id]);
  await ctx.worker.drain(); // bersihkan notifikasi tinjauan dari skenario
  const before = ctx.push.fetch.calls.length;

  assert.equal(await ctx.digest.send({ person_id: s.ana.id, day: DAY }), 'push');
  assert.equal(await ctx.digest.send({ person_id: s.owner.id, day: DAY }), 'wa');
  assert.equal(await ctx.digest.send({ person_id: s.coord.id, day: DAY }), null, 'hanya push, belum ada perangkat');
  await ctx.db.run("UPDATE people SET digest_channel = 'off' WHERE id = ?", [s.ana.id]);
  assert.equal(await ctx.digest.send({ person_id: s.ana.id, day: DAY }), null);
  await ctx.worker.drain();

  const pushes = ctx.push.fetch.calls.slice(before);
  assert.equal(pushes.length, 1);
  const msg = JSON.parse(decryptPayload(Buffer.from(pushes[0].body), { uaPrivateKey: dev.uaPrivateKey, auth: dev.auth }).toString());
  assert.equal(msg.title, `Ringkasan ${DAY}`);
  assert.match(msg.body, /1 terlambat/);
  assert.equal((await outboxFor(ctx, s.ana)).length, 0, 'Ana tidak dikirimi WA');
  assert.equal((await outboxFor(ctx, s.owner)).length, 1);
});

test('PATCH /api/me memvalidasi kanal ringkasan; /api/me menampilkan jadwal', async () => {
  const ctx = await setup({ DIGEST_TIME: '06:30' });
  const s = await seedBasic(ctx);
  const { server, base } = await startServer(ctx);
  try {
    const ana = await login(ctx, base, s.ana.phone);
    assert.equal((await ana('PATCH', '/api/me', { digest_channel: 'kadang' })).status, 400);
    assert.equal((await ana('PATCH', '/api/me', { digest_channel: 'off' })).status, 200);
    const me = (await ana('GET', '/api/me')).data;
    assert.equal(me.person.digest_channel, 'off');
    assert.deepEqual(me.digest, { enabled: true, time: '06:30', tz: 'Asia/Makassar' });
  } finally { server.close(); }
});

test('DIGEST_TZ tidak dikenal ditolak saat start', async () => {
  await assert.rejects(setup({ DIGEST_TZ: 'Mars/Olympus' }), /DIGEST_TZ/);
});
