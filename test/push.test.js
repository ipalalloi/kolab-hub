// Fase 2 — Web Push: kriptografi, langganan, push-first, notifikasi dari event log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, seedBasic, startServer, login, fakeBrowserSubscription, fakePushService, sendWa } from './helpers.js';
import { encryptPayload, decryptPayload, generateVapidKeys, vapidAuthorization, verifyVapidAuthorization, b64u } from '../src/push/webpush.js';
import { performCardAction } from '../src/domain/actions.js';
import { createCard } from '../src/domain/store.js';

// Vektor uji resmi RFC 8291 Lampiran A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('RFC 8291: enkripsi sama persis dengan vektor uji resmi, dan dekripsinya kembali ke teks asli', () => {
  const out = encryptPayload(RFC.plaintext, RFC, { asPrivateKey: RFC.asPrivate, salt: RFC.salt });
  assert.equal(b64u.enc(out), RFC.body);
  assert.equal(decryptPayload(b64u.dec(RFC.body), { uaPrivateKey: RFC.uaPrivate, auth: RFC.auth }).toString(), RFC.plaintext);
});

test('VAPID: JWT ES256 sah, aud = origin layanan push, kedaluwarsa ≤ 24 jam', () => {
  const k = generateVapidKeys();
  const now = Date.parse('2026-11-07T00:00:00Z');
  const claims = verifyVapidAuthorization(vapidAuthorization('https://updates.push.services.mozilla.com/wpush/v2/abc', { ...k, subject: 'mailto:a@b.id' }, { now }));
  assert.equal(claims.aud, 'https://updates.push.services.mozilla.com');
  assert.equal(claims.sub, 'mailto:a@b.id');
  assert.ok(claims.exp - now / 1000 <= 86400);
  const other = generateVapidKeys();
  const forged = vapidAuthorization('https://x.test/1', { ...other, subject: 'mailto:a@b.id' }).replace(/k=.*/, `k=${k.publicKey}`);
  assert.equal(verifyVapidAuthorization(forged), null, 'tanda tangan kunci lain ditolak');
});

test('konfigurasi: kunci VAPID harus berpasangan dan VAPID_SUBJECT wajib', async () => {
  const k = generateVapidKeys();
  await assert.rejects(setup({ VAPID_PUBLIC_KEY: k.publicKey }), /berpasangan/);
  await assert.rejects(setup({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey }), /VAPID_SUBJECT/);
  const wrong = generateVapidKeys();
  await assert.rejects(setup({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: wrong.privateKey, VAPID_SUBJECT: 'mailto:a@b.id' }), /tidak cocok/);
});

async function pushCtx() {
  const k = generateVapidKeys();
  const ctx = await setup({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: 'mailto:admin@contoh.id' });
  ctx.push.fetch = fakePushService();
  return { ctx, vapid: k };
}

function decryptCall(call, dev) {
  return JSON.parse(decryptPayload(Buffer.from(call.body), { uaPrivateKey: dev.uaPrivateKey, auth: dev.auth }).toString());
}

test('langganan lewat API, kirim uji, isi notifikasi dapat didekripsi perangkat', async () => {
  const { ctx, vapid } = await pushCtx();
  const s = await seedBasic(ctx);
  const { server, base } = await startServer(ctx);
  try {
    const ana = await login(ctx, base, s.ana.phone);
    const key = await ana('GET', '/api/push/key');
    assert.deepEqual(key.data, { enabled: true, public_key: vapid.publicKey, devices: 0 });
    const dev = await fakeBrowserSubscription();
    const r = await ana('POST', '/api/push/subscribe', { subscription: dev.subscription, device: 'Chrome Android' });
    assert.equal(r.status, 200);
    assert.equal(r.data.devices, 1);
    // Langganan disimpan terenkripsi.
    const row = await ctx.db.get('SELECT * FROM push_subscriptions');
    assert.ok(!row.endpoint_enc.includes('push.contoh.test'));

    assert.equal((await ana('POST', '/api/push/test')).status, 200);
    await ctx.worker.drain();
    const call = ctx.push.fetch.calls.at(-1);
    assert.equal(call.url, dev.subscription.endpoint);
    assert.equal(call.headers['content-encoding'], 'aes128gcm');
    assert.equal(verifyVapidAuthorization(call.headers.authorization).aud, 'https://push.contoh.test');
    assert.equal(decryptCall(call, dev).title, 'Kolab-Hub');

    // Isian tidak sah ditolak.
    assert.equal((await ana('POST', '/api/push/subscribe', { subscription: { ...dev.subscription, endpoint: 'http://x.test/1' } })).status, 400);
    assert.equal((await ana('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://x.test/1', keys: { p256dh: 'abc', auth: 'def' } } })).status, 400);

    // Keluar dari perangkat ini menghentikan notifikasinya.
    await ana('POST', '/api/auth/logout', { push_endpoint: dev.subscription.endpoint });
    assert.equal(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM push_subscriptions')).n), 0);
  } finally { server.close(); }
});

test('push nonaktif (tanpa kunci VAPID): langganan ditolak 409 dan penugasan tetap lewat WA', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  const { server, base } = await startServer(ctx);
  try {
    const ana = await login(ctx, base, s.ana.phone);
    assert.equal((await ana('GET', '/api/push/key')).data.enabled, false);
    const dev = await fakeBrowserSubscription();
    assert.equal((await ana('POST', '/api/push/subscribe', { subscription: dev.subscription })).status, 409);
  } finally { server.close(); }
});

test('push-first: penugasan ke orang berlangganan lewat push (tanpa biaya WA); yang tidak berlangganan tetap WA', async () => {
  const { ctx } = await pushCtx();
  const s = await seedBasic(ctx);
  const dev = await fakeBrowserSubscription();
  await ctx.db.tx((t) => ctx.push.subscribe(t, s.ana.id, dev.subscription));
  const waBefore = Number((await ctx.db.get("SELECT COUNT(*) AS n FROM wa_outbox WHERE kind = 'template'")).n);

  const viaAna = await ctx.db.tx(async (t) => {
    const { card } = await createCard(t, { board: s.board, title: 'Wawancara', assignee_id: s.ana.id, actor_id: s.coord.id, source: 'web' });
    return ctx.notifier.assignment(t, card, s.ana.id);
  });
  const viaBudi = await ctx.db.tx(async (t) => {
    const { card } = await createCard(t, { board: s.board, title: 'Transkrip', assignee_id: s.budi.id, actor_id: s.coord.id, source: 'web' });
    return ctx.notifier.assignment(t, card, s.budi.id);
  });
  await ctx.worker.drain();
  assert.equal(viaAna, 'push');
  assert.equal(viaBudi, 'wa');
  assert.equal(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM wa_outbox WHERE kind = 'template'")).n), waBefore + 1, 'hanya Budi yang lewat WA');
  assert.equal(decryptCall(ctx.push.fetch.calls[0], dev).title, 'Tugas baru DIS-0002');
});

test('notifikasi dari event log: selesai → koordinator & pemilik, revisi → penanggung jawab, bantuan → koordinator; pelaku tidak diberi tahu', async () => {
  const { ctx } = await pushCtx();
  const s = await seedBasic(ctx);
  const devs = {};
  for (const [name, p] of [['owner', s.owner], ['coord', s.coord], ['ana', s.ana]]) {
    devs[name] = await fakeBrowserSubscription();
    await ctx.db.tx((t) => ctx.push.subscribe(t, p.id, devs[name].subscription));
  }
  const byEndpoint = () => {
    const out = {};
    for (const [name, d] of Object.entries(devs)) out[name] = ctx.push.fetch.calls.filter((c) => c.url === d.subscription.endpoint).map((c) => decryptCall(c, d).title);
    return out;
  };
  // Putaran pertama hanya memasang kursor; riwayat lama tidak memicu notifikasi.
  await ctx.worker.drain();
  assert.equal(ctx.push.fetch.calls.length, 0);

  const act = (who, action, args = {}) => ctx.db.tx((t) => performCardAction(t, { card: s.card, actor: { person_id: who.id }, action, args, source: 'web' }));
  await sendWa(ctx, s.ana.phone, '#DIS-0001 mulai');
  await sendWa(ctx, s.ana.phone, '#DIS-0001 selesai');
  let got = byEndpoint();
  assert.deepEqual(got.owner, ['Menunggu tinjauan: DIS-0001']);
  assert.deepEqual(got.coord, ['Menunggu tinjauan: DIS-0001']);
  assert.deepEqual(got.ana, [], 'Ana yang menandai selesai, tidak diberi tahu');

  await act(s.coord, 'revisi', { note: 'lengkapi foto' });
  await act(s.ana, 'bantuan', { note: 'izin lokasi' });
  await ctx.worker.drain();
  got = byEndpoint();
  assert.deepEqual(got.ana, ['Revisi diminta: DIS-0001']);
  assert.deepEqual(got.coord, ['Menunggu tinjauan: DIS-0001', 'Butuh bantuan: DIS-0001'], 'koordinator yang meminta revisi tidak diberi tahu revisinya sendiri');
  assert.deepEqual(got.owner, ['Menunggu tinjauan: DIS-0001', 'Butuh bantuan: DIS-0001']);

  // Tidak ada notifikasi ganda bila worker berputar lagi.
  const n = ctx.push.fetch.calls.length;
  await ctx.worker.drain();
  assert.equal(ctx.push.fetch.calls.length, n);
});

test('pengiriman: 410 menghapus langganan, 500 dicoba ulang hanya untuk perangkat itu, 400 tidak dicoba ulang', async () => {
  const { ctx } = await pushCtx();
  const s = await seedBasic(ctx);
  const ok = await fakeBrowserSubscription(1);
  const gone = await fakeBrowserSubscription(2);
  const flaky = await fakeBrowserSubscription(3);
  const bad = await fakeBrowserSubscription(4);
  for (const d of [ok, gone, flaky, bad]) await ctx.db.tx((t) => ctx.push.subscribe(t, s.ana.id, d.subscription));
  ctx.push.fetch = fakePushService((url) => (url === gone.subscription.endpoint ? 410 : url === flaky.subscription.endpoint ? 503 : url === bad.subscription.endpoint ? 400 : 201));
  await ctx.db.tx((t) => ctx.push.notify(t, s.ana.id, { title: 'x', body: 'y' }));
  await ctx.worker.drain();
  const remaining = (await ctx.db.all('SELECT endpoint_hash FROM push_subscriptions')).length;
  assert.equal(remaining, 3, 'langganan 410 dihapus');
  const jobs = await ctx.db.all("SELECT status, attempts FROM jobs WHERE type = 'push.send' ORDER BY status");
  assert.deepEqual(jobs.map((j) => j.status).sort(), ['done', 'done', 'done', 'queued'], 'hanya perangkat 503 yang antre ulang');
  assert.equal(ctx.push.fetch.calls.filter((c) => c.url === ok.subscription.endpoint).length, 1);
});

test('hapus akun mencabut semua langganan push; ekspor data memuat perangkat push', async () => {
  const { ctx } = await pushCtx();
  const s = await seedBasic(ctx);
  const { server, base } = await startServer(ctx);
  try {
    const budi = await login(ctx, base, s.budi.phone);
    await budi('POST', '/api/push/subscribe', { subscription: (await fakeBrowserSubscription()).subscription, device: 'Safari iOS' });
    const exp = await budi('GET', '/api/me/export');
    assert.deepEqual(exp.data.push_devices.map((d) => d.device), ['Safari iOS']);
    assert.equal(exp.data.person.digest_channel, 'auto');
    assert.equal((await budi('DELETE', '/api/me')).status, 200);
    assert.equal(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE person_id = ?', [s.budi.id])).n), 0);
  } finally { server.close(); }
});

test('VAPID: kunci privat P-256 dengan nol di depan (31 byte) tetap sah dan dinormalkan ke 32 byte', async () => {
  const { createECDH } = await import('node:crypto');
  // Cari kunci yang skalar privatnya diawali 0x00 (≈1/256), seperti hasil getPrivateKey() apa adanya.
  let ecdh;
  for (let i = 0; i < 20000; i++) { ecdh = createECDH('prime256v1'); ecdh.generateKeys(); if (ecdh.getPrivateKey().length < 32) break; }
  assert.ok(ecdh.getPrivateKey().length < 32, 'kunci pendek ditemukan');
  const legacy = { publicKey: b64u.enc(ecdh.getPublicKey()), privateKey: b64u.enc(ecdh.getPrivateKey()), subject: 'mailto:a@b.id' };
  // Kunci lama (31 byte) dari .env yang sudah ada tetap bekerja.
  const claims = verifyVapidAuthorization(vapidAuthorization('https://push.contoh.test/x', legacy));
  assert.equal(claims.aud, 'https://push.contoh.test');
  await setup({ VAPID_PUBLIC_KEY: legacy.publicKey, VAPID_PRIVATE_KEY: legacy.privateKey, VAPID_SUBJECT: legacy.subject });
  // Kunci baru selalu 32 byte.
  for (let i = 0; i < 2000; i++) assert.equal(b64u.dec(generateVapidKeys().privateKey).length, 32);
});
