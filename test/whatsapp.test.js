import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, seedBasic, sendWa, signed, waPayload, lastReply, card, addPerson } from './helpers.js';
import { runRetention } from '../src/jobs/retention.js';

test('webhook menolak tanda tangan salah dan menerima yang benar', async () => {
  const ctx = await setup();
  const { raw } = signed(ctx, waPayload('6281100000003', 'halo'));
  assert.equal((await ctx.webhook.receive(raw, 'sha256=deadbeef')).status, 401);
  assert.equal((await ctx.webhook.receive(raw, undefined)).status, 401);
  const r = await ctx.webhook.verifyGet(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': ctx.cfg.wa.verifyToken, 'hub.challenge': '42' }));
  assert.deepEqual(r, { status: 200, body: '42' });
  assert.equal((await ctx.webhook.verifyGet(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'salah' }))).status, 403);
});

test('alur lengkap WA: mulai → progres → selesai → disetujui di web', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  await sendWa(ctx, s.ana.phone, '#DIS-0001 mulai');
  assert.equal((await card(ctx, 'DIS-0001')).column_key, 'dikerjakan');
  assert.match((await lastReply(ctx, s.ana.phone)).text, /DIS-0001 sekarang Dikerjakan/);

  await sendWa(ctx, s.ana.phone, '#DIS-0001 50% sudah survei 3 lokasi');
  assert.equal(Number((await card(ctx, 'DIS-0001')).progress), 50);

  await sendWa(ctx, s.ana.phone, '#DIS-0001 selesai', { media: 'image' });
  const c = await card(ctx, 'DIS-0001');
  assert.equal(c.column_key, 'ditinjau');
  const done = await ctx.db.get("SELECT * FROM events WHERE card_id = ? AND type = 'card.done'", [c.id]);
  assert.equal(done.source, 'wa');
  assert.equal(JSON.parse(done.payload).attachments[0].type, 'image');

  const msgs = await ctx.db.all("SELECT status FROM wa_messages WHERE status = 'processed'");
  assert.equal(msgs.length, 3);
  const sent = await ctx.db.all("SELECT status FROM wa_outbox WHERE status = 'sent'");
  assert.ok(sent.length >= 3, 'balasan konfirmasi terkirim (simulasi)');
});

test('idempoten: pesan Meta yang sama diproses sekali', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  const payload = waPayload(s.ana.phone, '#DIS-0001 mulai', { id: 'wamid.SAMA' });
  for (let i = 0; i < 3; i++) {
    const { raw, sig } = signed(ctx, payload);
    assert.equal((await ctx.webhook.receive(raw, sig)).status, 200);
  }
  await ctx.worker.drain();
  const c = await card(ctx, 'DIS-0001');
  const n = await ctx.db.get("SELECT COUNT(*) AS n FROM events WHERE card_id = ? AND type = 'card.started'", [c.id]);
  assert.equal(Number(n.n), 1);
  assert.equal(Number((await ctx.db.get('SELECT COUNT(*) AS n FROM jobs WHERE type = ?', ['wa.process'])).n), 1);
});

test('otorisasi: kolaborator lain tidak bisa mengubah kartu yang bukan miliknya', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  await sendWa(ctx, s.budi.phone, '#DIS-0001 mulai');
  assert.equal((await card(ctx, 'DIS-0001')).column_key, 'masuk');
  assert.match((await lastReply(ctx, s.budi.phone)).text, /bukan tugas Anda/);
  // koordinator boleh
  await sendWa(ctx, s.coord.phone, '#DIS-0001 mulai');
  assert.equal((await card(ctx, 'DIS-0001')).column_key, 'dikerjakan');
});

test('nomor asing tidak diproses dan tidak dibalas', async () => {
  const ctx = await setup();
  await seedBasic(ctx);
  await sendWa(ctx, '6289999999999', '#DIS-0001 mulai');
  assert.equal((await card(ctx, 'DIS-0001')).column_key, 'masuk');
  assert.equal(await lastReply(ctx, '6289999999999'), null);
  assert.equal((await ctx.db.get('SELECT status FROM wa_messages')).status, 'unknown_sender');
});

test('tahan wajib alasan; quote-reply tanpa kode memakai konteks kartu', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  await sendWa(ctx, s.ana.phone, '#DIS-0001 tahan');
  assert.match((await lastReply(ctx, s.ana.phone)).text, /Alasan wajib/);
  await sendWa(ctx, s.ana.phone, '#DIS-0001 tahan menunggu izin lokasi');
  const c = await card(ctx, 'DIS-0001');
  assert.equal(c.column_key, 'tertahan');
  assert.equal(c.hold_reason, 'menunggu izin lokasi');
  const notif = await lastReply(ctx, s.ana.phone);
  await sendWa(ctx, s.ana.phone, 'mulai', { context: notif.provider_id });
  assert.equal((await card(ctx, 'DIS-0001')).column_key, 'dikerjakan');
});

test('#tugasku, #baru oleh koordinator = kartu, oleh kolaborator = usulan', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  await sendWa(ctx, s.ana.phone, '#tugasku');
  assert.match((await lastReply(ctx, s.ana.phone)).text, /DIS-0001 Survei lokasi/);

  await sendWa(ctx, s.coord.phone, '#baru DIS Rapat pembimbing');
  assert.ok(await card(ctx, 'DIS-0002'));
  assert.equal((await card(ctx, 'DIS-0002')).title, 'Rapat pembimbing');

  await sendWa(ctx, s.ana.phone, '#baru DIS Cetak kuesioner');
  assert.equal(await card(ctx, 'DIS-0003'), null);
  const pr = await ctx.db.get('SELECT * FROM proposals');
  assert.equal(pr.title, 'Cetak kuesioner');
  assert.equal(pr.status, 'baru');
});

test('pesan tak dikenal jadi komentar "perlu dicek" di kartu aktif; tidak ada yang dibuang', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  await sendWa(ctx, s.ana.phone, '#DIS-0001 mulai');
  await sendWa(ctx, s.ana.phone, 'Pak, besok saya ke lokasi kedua');
  const c = await card(ctx, 'DIS-0001');
  assert.equal(Number(c.needs_review), 1);
  const ev = await ctx.db.get("SELECT * FROM events WHERE card_id = ? AND type = 'card.commented'", [c.id]);
  assert.equal(JSON.parse(ev.payload).text, 'Pak, besok saya ke lokasi kedua');
});

test('batas WIP per orang', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  await ctx.db.run('UPDATE memberships SET wip_limit = 1 WHERE person_id = ?', [s.ana.id]);
  await sendWa(ctx, s.coord.phone, '#baru DIS Kedua');
  await ctx.db.run("UPDATE cards SET assignee_id = ? WHERE code = 'DIS-0002'", [s.ana.id]);
  await sendWa(ctx, s.ana.phone, '#DIS-0001 mulai');
  await sendWa(ctx, s.ana.phone, '#DIS-0002 mulai');
  assert.equal((await card(ctx, 'DIS-0002')).column_key, 'masuk');
  assert.match((await lastReply(ctx, s.ana.phone)).text, /Batas WIP/);
});

test('batas laju per nomor', async () => {
  const ctx = await setup({ WA_RATE_LIMIT_PER_MINUTE: '2' });
  const s = await seedBasic(ctx);
  for (let i = 0; i < 4; i++) await sendWa(ctx, s.ana.phone, '#tugasku');
  assert.equal(Number((await ctx.db.get("SELECT COUNT(*) AS n FROM wa_messages WHERE status = 'rate_limited'")).n), 2);
});

test('retensi: isi pesan mentah dihapus setelah masa retensi, hasil parsing tetap', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  await sendWa(ctx, s.ana.phone, '#DIS-0001 mulai');
  await ctx.db.run('UPDATE workspaces SET retention_days = 30 WHERE id = ?', [s.ws]);
  let r = await runRetention(ctx, { now: Date.now() + 29 * 86_400_000 });
  assert.equal(r.purged, 0);
  r = await runRetention(ctx, { now: Date.now() + 31 * 86_400_000 });
  assert.ok(r.purged >= 2, 'pesan masuk dan balasan');
  const m = await ctx.db.get('SELECT * FROM wa_messages');
  assert.equal(m.body_enc, null);
  assert.ok(m.parsed, 'hasil parsing tetap');
  assert.ok(m.content_purged_at);
  const c = await card(ctx, 'DIS-0001');
  assert.equal(c.column_key, 'dikerjakan', 'event tidak tersentuh');
});

test('event log menolak UPDATE dan DELETE', async () => {
  const ctx = await setup();
  await seedBasic(ctx);
  await ctx.db.run("INSERT INTO audit_log (action, created_at) VALUES ('uji', '2026-11-07T00:00:00Z')");
  await assert.rejects(ctx.db.run("UPDATE events SET type = 'x'"), /append-only/);
  await assert.rejects(ctx.db.run('DELETE FROM events'), /append-only/);
  await assert.rejects(ctx.db.run('DELETE FROM audit_log'), /append-only/);
});

test('nomor belum terverifikasi diperlakukan sebagai nomor asing', async () => {
  const ctx = await setup();
  await seedBasic(ctx);
  const x = await addPerson(ctx, { name: 'X', phone: '6281100000099', verified: false });
  await sendWa(ctx, x.phone, '#tugasku');
  assert.equal(await lastReply(ctx, x.phone), null);
});
