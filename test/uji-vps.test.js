// Perbaikan dari uji coba di VPS (7 Nov 2026):
// 1) isian progres kosong tidak boleh tercatat 0%,
// 2) tombol aksi kartu sesuai status dan peran (cerminan aturan server),
// 3) register transfer dari `npm run create-owner` punya tanggal tinjau.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, seedBasic, addPerson, sendWa, lastReply, card } from './helpers.js';
import { createHandler } from '../src/server.js';
import { parsePercent, allowedActions, performCardAction } from '../src/domain/actions.js';
import { createCard } from '../src/domain/store.js';
import { insertDefaultTransfers, defaultReviewDate } from '../src/api/routes.js';
import { renderMigration } from '../src/db/migrate.js';
import { openSqlite } from '../src/db/index.js';
import { newId, nowIso } from '../src/lib/util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 1. Validasi progres ----------
test('parsePercent: kosong, spasi, null, boolean, desimal, dan di luar 0–100 ditolak', () => {
  for (const bad of ['', '   ', null, undefined, true, false, 'abc', '50.5', 50.5, -1, 101, '101', '1e2', [], {}, NaN, Infinity, '-5', '5 0']) {
    assert.equal(parsePercent(bad), null, `seharusnya ditolak: ${JSON.stringify(bad)}`);
  }
  assert.equal(parsePercent(0), 0);
  assert.equal(parsePercent('0'), 0);
  assert.equal(parsePercent(' 40 '), 40);
  assert.equal(parsePercent('75%'), 75);
  assert.equal(parsePercent(100), 100);
});

test('API: isian progres kosong ditolak 400 dan progres kartu tidak berubah', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  await ctx.db.tx((t) => performCardAction(t, { card: s.card, actor: { person_id: s.ana.id }, action: 'progres', args: { percent: 40 }, source: 'web' }));
  for (const percent of ['', ' ', null, undefined, 'abc', true]) {
    await assert.rejects(
      ctx.db.tx((t) => performCardAction(t, { card: s.card, actor: { person_id: s.ana.id }, action: 'progres', args: { percent }, source: 'web' })),
      (e) => e.status === 400 && e.code === 'bad_percent',
      `percent=${JSON.stringify(percent)}`,
    );
  }
  assert.equal(Number((await card(ctx, 'DIS-0001')).progress), 40, 'progres tetap 40%, bukan 0%');
  const n = await ctx.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'card.progress'");
  assert.equal(Number(n.n), 1, 'tidak ada event progres palsu');
  // 0 yang sengaja diisi tetap sah.
  await ctx.db.tx((t) => performCardAction(t, { card: s.card, actor: { person_id: s.ana.id }, action: 'progres', args: { percent: '0' }, source: 'web' }));
  assert.equal(Number((await card(ctx, 'DIS-0001')).progress), 0);
});

test('WA: "#KODE progres" tanpa angka ditolak dan progres tidak berubah', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  await sendWa(ctx, s.ana.phone, '#DIS-0001 60%');
  await sendWa(ctx, s.ana.phone, '#DIS-0001 progres');
  assert.equal(Number((await card(ctx, 'DIS-0001')).progress), 60);
  assert.match((await lastReply(ctx, s.ana.phone)).text, /0–100/);
});

// ---------- 2. Tombol sesuai status dan peran ----------
const BUTTONS = ['mulai', 'progres', 'selesai', 'tahan', 'bantuan', 'setujui', 'revisi', 'cek', 'komentar'];
const VALID_ARGS = { progres: { percent: 50 }, tahan: { reason: 'menunggu' }, revisi: { note: 'perbaiki' }, bantuan: { note: 'tolong' }, komentar: { text: 'catatan' } };
// Langkah dari Masuk menuju tiap kolom (dijalankan koordinator).
const PATHS = {
  masuk: [],
  dikerjakan: [['mulai']],
  ditinjau: [['mulai'], ['selesai']],
  selesai: [['mulai'], ['selesai'], ['setujui']],
  tertahan: [['tahan', { reason: 'izin' }]],
};

class Rollback extends Error {}

test('uji silang: tombol yang ditampilkan = tindakan yang diterima server, di setiap kolom dan peran', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  const viewer = await addPerson(ctx, { name: 'Pemantau', phone: '6281100000009' });
  await ctx.db.run("INSERT INTO memberships (workspace_id, person_id, role, wip_limit, created_at) VALUES (?, ?, 'viewer', 3, ?)", [s.ws, viewer.id, nowIso()]);
  const people = { owner: s.owner, koordinator: s.coord, 'kolaborator-pj': s.ana, 'kolaborator-lain': s.budi, pemantau: viewer };

  let checked = 0;
  for (const [col, path] of Object.entries(PATHS)) {
    for (const flagged of [false, true]) {
      const c = await ctx.db.tx(async (t) => (await createCard(t, { board: s.board, title: `Uji ${col}`, assignee_id: s.ana.id, actor_id: s.coord.id, source: 'web' })).card);
      for (const [action, args] of path) {
        await ctx.db.tx((t) => performCardAction(t, { card: c, actor: { person_id: s.coord.id }, action, args: args || {}, source: 'web' }));
      }
      if (flagged) await ctx.db.tx((t) => performCardAction(t, { card: c, actor: { person_id: s.ana.id }, action: 'komentar', args: { text: 'cek ya', needs_review: true }, source: 'web' }));
      const row = await ctx.db.get('SELECT * FROM cards WHERE id = ?', [c.id]);
      assert.equal(row.column_key, col);

      for (const [label, person] of Object.entries(people)) {
        const m = await ctx.db.get('SELECT * FROM memberships WHERE workspace_id = ? AND person_id = ?', [s.ws, person.id]);
        const shown = allowedActions(row, m, person.id);
        for (const action of BUTTONS) {
          let ok = true; let why = '';
          try {
            await ctx.db.tx(async (t) => {
              await performCardAction(t, { card: row, actor: { person_id: person.id }, action, args: VALID_ARGS[action] || {}, source: 'web' });
              throw new Rollback();
            });
          } catch (e) {
            if (!(e instanceof Rollback)) { ok = false; why = e.message; }
          }
          assert.equal(shown.includes(action), ok, `${col}${flagged ? '+perlu-dicek' : ''} · ${label} · ${action}: tombol ${shown.includes(action) ? 'tampil' : 'tersembunyi'}, server ${ok ? 'menerima' : `menolak (${why})`}`);
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked, 5 * 2 * 5 * BUTTONS.length);
});

test('tombol tidak masuk akal ditutup di server juga: tahan kartu yang sudah tertahan, bantuan pada kartu selesai', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  const act = (who, action, args = {}) => ctx.db.tx((t) => performCardAction(t, { card: s.card, actor: { person_id: who.id }, action, args, source: 'web' }));
  await act(s.ana, 'tahan', { reason: 'izin' });
  await assert.rejects(act(s.ana, 'tahan', { reason: 'lagi' }), (e) => e.status === 409);
  await act(s.ana, 'mulai'); await act(s.ana, 'selesai'); await act(s.coord, 'setujui');
  await assert.rejects(act(s.ana, 'bantuan', { note: 'x' }), (e) => e.status === 409);
});

let server; let base;
after(() => server?.close());

test('API mengirim card.actions sesuai peminta: penanggung jawab, kolaborator lain, pemantau, koordinator', async () => {
  const ctx = await setup();
  const s = await seedBasic(ctx);
  const viewer = await addPerson(ctx, { name: 'Pemantau', phone: '6281100000009' });
  await ctx.db.run("INSERT INTO memberships (workspace_id, person_id, role, wip_limit, created_at) VALUES (?, ?, 'viewer', 3, ?)", [s.ws, viewer.id, nowIso()]);
  server = createServer(createHandler(ctx));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const login = async (phone) => {
    const H = { 'content-type': 'application/json', 'x-kolab-csrf': '1' };
    await fetch(`${base}/api/auth/otp`, { method: 'POST', headers: H, body: JSON.stringify({ phone }) });
    const code = (await lastReply(ctx, phone)).text.match(/(\d{6})/)[1];
    const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ phone, code }) });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { ...H, cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: await res.json() };
    };
  };
  const ana = await login(s.ana.phone);
  const budi = await login(s.budi.phone);
  const pem = await login(viewer.phone);
  const koor = await login(s.coord.phone);

  assert.deepEqual((await ana('GET', '/api/cards/DIS-0001')).data.card.actions, ['mulai', 'progres', 'selesai', 'tahan', 'bantuan', 'komentar']);
  assert.deepEqual((await budi('GET', '/api/cards/DIS-0001')).data.card.actions, ['komentar'], 'bukan tugasnya: hanya komentar');
  assert.deepEqual((await pem('GET', '/api/cards/DIS-0001')).data.card.actions, [], 'pemantau: tanpa tombol');

  // Isian kosong dari web ditolak.
  const bad = await ana('POST', '/api/cards/DIS-0001/actions', { action: 'progres', percent: '' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'bad_percent');

  // Setelah tindakan, respons membawa tombol untuk keadaan baru.
  const r = await ana('POST', '/api/cards/DIS-0001/actions', { action: 'mulai' });
  assert.equal(r.status, 200);
  assert.ok(!r.data.actions.includes('mulai'));
  const tasks = (await ana('GET', '/api/my/tasks')).data;
  assert.deepEqual(tasks[0].actions, ['progres', 'selesai', 'tahan', 'bantuan', 'komentar']);

  await ana('POST', '/api/cards/DIS-0001/actions', { action: 'selesai' });
  assert.deepEqual((await ana('GET', '/api/cards/DIS-0001')).data.card.actions, ['tahan', 'bantuan', 'komentar'], 'menunggu tinjauan: tidak ada Mulai/Lapor/Selesai');
  assert.deepEqual((await koor('GET', '/api/cards/DIS-0001')).data.card.actions, ['tahan', 'bantuan', 'setujui', 'revisi', 'komentar']);
  const board = (await koor('GET', `/api/boards/${s.board.id}`)).data;
  assert.ok(board.cards.every((c) => Array.isArray(c.actions)));
});

// ---------- 3. Tanggal tinjau register transfer ----------
test('insertDefaultTransfers mengisi tanggal tinjau satu tahun', async () => {
  const ctx = await setup();
  const ws = newId();
  const ts = '2026-11-07T10:00:00.000Z';
  await ctx.db.run('INSERT INTO workspaces (id, name, retention_days, created_at) VALUES (?, ?, 90, ?)', [ws, 'X', ts]);
  await ctx.db.tx((t) => insertDefaultTransfers(t, ws, ts));
  const rows = await ctx.db.all('SELECT next_review FROM data_transfers WHERE workspace_id = ?', [ws]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.next_review === '2027-11-07'), JSON.stringify(rows));
  assert.equal(defaultReviewDate(new Date(ts)), '2027-11-07');
});

test('npm run create-owner (proses nyata, SQLite berkas) menulis register transfer dengan tanggal tinjau', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kolab-owner-'));
  try {
    const dbPath = join(dir, 'kolab.sqlite');
    const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', join(ROOT, 'scripts/create-owner.js'), '--name', 'Pemilik VPS', '--phone', '081234567890', '--workspace', 'Tim VPS'], {
      cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test', SQLITE_PATH: dbPath, WA_MODE: 'simulate' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Pemilik dibuat untuk 6281\*\*\*\*890/);
    return (async () => {
      const db = await openSqlite(dbPath);
      const rows = await db.all('SELECT next_review FROM data_transfers');
      await db.close();
      assert.equal(rows.length, 3);
      const expected = defaultReviewDate();
      assert.ok(rows.every((x) => x.next_review === expected), `${JSON.stringify(rows)} ≠ ${expected}`);
    })();
  } finally {
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 0);
  }
});

test('migrasi 002 mengisi tanggal tinjau yang kosong tanpa menyentuh yang sudah ada', async () => {
  const ctx = await setup(); // semua migrasi sudah jalan; uji ulang 002 pada baris lama
  const ws = newId();
  await ctx.db.run('INSERT INTO workspaces (id, name, retention_days, created_at) VALUES (?, ?, 90, ?)', [ws, 'Lama', nowIso()]);
  const ins = (id, review) => ctx.db.run('INSERT INTO data_transfers (id, workspace_id, purpose, country, recipient, data_categories, instrument, next_review, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, ws, 'p', 'c', 'r', 'd', 'i', review, '2026-11-07T09:00:00.000Z']);
  await ins('lama', null);
  await ins('ada', '2026-12-31');
  const sql = renderMigration(readFileSync(join(ROOT, 'src/db/migrations/002_transfer_review_backfill.sql'), 'utf8'), 'sqlite');
  await ctx.db.exec(sql);
  assert.equal((await ctx.db.get("SELECT next_review FROM data_transfers WHERE id = 'lama'")).next_review, '2027-11-07');
  assert.equal((await ctx.db.get("SELECT next_review FROM data_transfers WHERE id = 'ada'")).next_review, '2026-12-31');
  assert.ok(renderMigration(readFileSync(join(ROOT, 'src/db/migrations/002_transfer_review_backfill.sql'), 'utf8'), 'pg').includes("interval '365 days'"));
});
