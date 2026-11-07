// Fase 2 — dasbor beban kerja dan ekspor CSV.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, seedBasic, startServer, login } from './helpers.js';
import { performCardAction, revertEvent } from '../src/domain/actions.js';
import { createCard } from '../src/domain/store.js';
import { csvCell, toCsv } from '../src/api/reports.js';
import { localParts } from '../src/notify/digest.js';

let ctx; let s; let server; let base; let koor; let ana; let budi;
const day = () => localParts(Date.now(), 'Asia/Makassar').day;
const addDays = (d, n) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

/** Pengurai CSV kecil (RFC 4180) untuk memeriksa hasil ekspor. */
function parseCsv(text, sep = ',') {
  const rows = []; let row = []; let cell = ''; let q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\r') continue;
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  return rows;
}

before(async () => {
  ctx = await setup();
  s = await seedBasic(ctx);
  ({ server, base } = await startServer(ctx));
  const act = (card, who, action, args = {}) => ctx.db.tx((t) => performCardAction(t, { card, actor: { person_id: who.id }, action, args, source: 'web' }));
  const mk = (title, assignee, extra = {}) => ctx.db.tx(async (t) => (await createCard(t, { board: s.board, title, assignee_id: assignee?.id, actor_id: s.coord.id, source: 'web', ...extra })).card);
  // Ana: DIS-0001 dikerjakan & terlambat, DIS-0002 tenggat 3 hari lagi (masuk), DIS-0003 disetujui, DIS-0004 tertahan.
  await act(s.card, s.ana, 'mulai');
  await act(s.card, s.coord, 'ubah', { due_date: addDays(day(), -2) });
  await mk('Wawancara', s.ana, { due_date: addDays(day(), 3) });
  const c3 = await mk('Transkrip', s.ana);
  await act(c3, s.ana, 'mulai'); await act(c3, s.ana, 'selesai'); await act(c3, s.coord, 'setujui');
  const c4 = await mk('Izin lokasi', s.ana);
  await act(c4, s.ana, 'tahan', { reason: 'menunggu surat' });
  // Budi: satu kartu disetujui lalu persetujuannya dibatalkan (tidak dihitung selesai), judul berbahaya untuk CSV.
  const c5 = await mk('=HYPERLINK("http://jahat.test","klik")', s.budi);
  await act(c5, s.budi, 'mulai'); await act(c5, s.budi, 'selesai');
  const { event } = await act(c5, s.coord, 'setujui');
  await ctx.db.tx((t) => revertEvent(t, { seq: event.seq, actor: { person_id: s.coord.id }, reason: 'keliru', source: 'web' }));
  await mk('Belum ada orangnya', null, { due_date: addDays(day(), -1) });
  koor = await login(ctx, base, s.coord.phone);
  ana = await login(ctx, base, s.ana.phone);
  budi = await login(ctx, base, s.budi.phone);
});
after(() => server.close());

test('csvCell menetralkan rumus dan mengutip pemisah', () => {
  for (const bad of ['=1+1', '+62812', '-5', '@SUM(A1)', '\tx']) assert.ok(csvCell(bad).replace(/^"/, '').startsWith("'"), bad);
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('kata "kutip"'), '"kata ""kutip"""');
  assert.equal(csvCell(null), '');
  assert.ok(toCsv(['a'], [['b']]).startsWith('﻿'));
});

test('dasbor beban: hitungan per anggota, terlambat, tenggat 7 hari, selesai periode, WIP, belum ditugaskan', async () => {
  const r = await koor('GET', '/api/workspaces/' + s.ws + '/workload?hari=30');
  assert.equal(r.status, 200);
  const a = r.data.members.find((m) => m.name === 'Ana');
  assert.deepEqual(
    { masuk: a.masuk, dikerjakan: a.dikerjakan, ditinjau: a.ditinjau, tertahan: a.tertahan, aktif: a.aktif, terlambat: a.terlambat, tenggat_7_hari: a.tenggat_7_hari, selesai_periode: a.selesai_periode, melebihi_wip: a.melebihi_wip },
    { masuk: 1, dikerjakan: 1, ditinjau: 0, tertahan: 1, aktif: 3, terlambat: 1, tenggat_7_hari: 1, selesai_periode: 1, melebihi_wip: false });
  assert.equal(typeof a.median_hari_selesai, 'number');
  const b = r.data.members.find((m) => m.name === 'Budi');
  assert.equal(b.ditinjau, 1, 'persetujuan dibatalkan → kembali Ditinjau');
  assert.equal(b.selesai_periode, 0, 'persetujuan yang dibatalkan tidak dihitung');
  assert.deepEqual({ masuk: r.data.unassigned.masuk, terlambat: r.data.unassigned.terlambat }, { masuk: 1, terlambat: 1 });
  assert.equal(r.data.totals.terlambat, 2);
  assert.ok(!r.data.members.some((m) => m.role === 'viewer'));
});

test('hak akses: kolaborator tidak boleh melihat dasbor atau mengekspor; periode divalidasi', async () => {
  assert.equal((await ana('GET', `/api/workspaces/${s.ws}/workload`)).status, 403);
  assert.equal((await budi('GET', `/api/workspaces/${s.ws}/export/cards.csv`)).status, 403);
  assert.equal((await koor('GET', `/api/workspaces/${s.ws}/workload?hari=0`)).status, 400);
  assert.equal((await koor('GET', `/api/workspaces/${s.ws}/export/events.csv?dari=2026-01-01&sampai=2027-06-01`)).status, 400);
  assert.equal((await koor('GET', `/api/workspaces/${s.ws}/export/cards.csv?status=entah`)).status, 400);
});

test('ekspor kartu: CSV UTF-8 ber-BOM, rumus dinetralkan, filter status, audit tercatat', async () => {
  const r = await koor('GET', `/api/workspaces/${s.ws}/export/cards.csv`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="kartu-\d{8}\.csv"/);
  const rows = parseCsv(r.data);
  assert.deepEqual(rows[0].slice(0, 4), ['Kode', 'Proyek', 'Judul', 'Status']);
  assert.equal(rows.length, 1 + 6);
  const evil = rows.find((x) => x[0] === 'DIS-0005');
  assert.ok(evil[2].startsWith("'="), 'judul berawalan = dinetralkan');
  const late = rows.find((x) => x[0] === 'DIS-0001');
  assert.equal(late[8], 'ya');
  const held = parseCsv((await koor('GET', `/api/workspaces/${s.ws}/export/cards.csv?status=tertahan&pemisah=titik-koma`)).data, ';');
  assert.deepEqual(held.slice(1).map((x) => [x[0], x[10]]), [['DIS-0004', 'menunggu surat']]);
  const aud = await ctx.db.all("SELECT action FROM audit_log WHERE action LIKE 'export.%'");
  assert.ok(aud.filter((x) => x.action === 'export.cards').length >= 2);
});

test('ekspor riwayat: label kejadian, pelaku, rincian, tanda dibatalkan', async () => {
  const r = await koor('GET', `/api/workspaces/${s.ws}/export/events.csv`);
  assert.equal(r.status, 200);
  const rows = parseCsv(r.data);
  assert.deepEqual(rows[0], ['No', 'Waktu (UTC)', 'Kode', 'Kejadian', 'Sumber', 'Pelaku', 'Rincian', 'Dilakukan luring', 'Dibatalkan']);
  const approvedBudi = rows.find((x) => x[2] === 'DIS-0005' && x[3] === 'disetujui');
  assert.equal(approvedBudi[8], 'ya');
  assert.equal(approvedBudi[5], 'Koordinator');
  const hold = rows.find((x) => x[2] === 'DIS-0004' && x[3] === 'ditahan');
  assert.equal(hold[6], 'menunggu surat');
  const old = parseCsv((await koor('GET', `/api/workspaces/${s.ws}/export/events.csv?dari=2020-01-01&sampai=2020-01-31`)).data);
  assert.equal(old.length, 1, 'rentang lampau kosong: hanya kepala tabel');
});

test('ekspor beban kerja sejalan dengan dasbor', async () => {
  const rows = parseCsv((await koor('GET', `/api/workspaces/${s.ws}/export/workload.csv?hari=7`)).data);
  assert.equal(rows[0][11], 'Selesai 7 hari');
  const a = rows.find((x) => x[0] === 'Ana');
  assert.deepEqual([a[4], a[5], a[7], a[8], a[9]], ['1', '1', '1', '3', '1']);
  assert.equal(rows.at(-1)[0], '(belum ditugaskan)');
});
