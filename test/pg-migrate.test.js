// Uji migrasi terhadap PostgreSQL sungguhan. Hanya berjalan bila PG_TEST_URL di-set
// (di CI: layanan postgres GitHub Actions). Skema `public` basis data uji dikosongkan dulu,
// jadi JANGAN arahkan PG_TEST_URL ke basis data produksi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from '../src/db/migrate.js';

const URL = process.env.PG_TEST_URL;
const skip = URL ? false : 'PG_TEST_URL tidak di-set; uji PostgreSQL dilewati';
const MIGRATIONS = readdirSync(join(dirname(fileURLToPath(import.meta.url)), '../src/db/migrations'))
  .filter((f) => f.endsWith('.sql')).sort();

test('migrasi PostgreSQL: diterapkan penuh, idempoten, event log append-only', { skip }, async () => {
  const { openPg } = await import('../src/db/index.js');
  const db = await openPg(URL);
  try {
    await db.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');

    const applied = [];
    await migrate(db, { log: (m) => applied.push(m) });
    assert.equal(applied.length, MIGRATIONS.length, 'semua berkas migrasi diterapkan');

    const names = (await db.all('SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name);
    assert.deepEqual(names, MIGRATIONS);

    // Jalankan ulang: tidak ada yang diterapkan lagi.
    const again = [];
    await migrate(db, { log: (m) => again.push(m) });
    assert.equal(again.length, 0, 'migrasi kedua tidak menerapkan apa pun');

    const tables = new Set((await db.all(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    )).map((r) => r.table_name));
    for (const t of ['workspaces', 'people', 'memberships', 'cards', 'events', 'audit_log', 'jobs', 'push_subscriptions']) {
      assert.ok(tables.has(t), `tabel ${t} ada`);
    }

    // Placeholder `?` → `$n` dan RETURNING lewat adapter.
    const now = new Date().toISOString();
    await db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', ['ws1', 'Uji', now]);
    const ins = await db.run(
      'INSERT INTO events (id, workspace_id, type, source, payload, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq',
      ['ev1', 'ws1', 'card.created', 'system', '{}', now],
    );
    assert.equal(ins.rows.length, 1);

    // Batas retensi tetap ditegakkan.
    await assert.rejects(db.run('UPDATE workspaces SET retention_days = 10 WHERE id = ?', ['ws1']));

    // Event log append-only: UPDATE dan DELETE ditolak pemicu.
    await assert.rejects(db.run("UPDATE events SET type = 'x' WHERE id = ?", ['ev1']), /append-only/);
    await assert.rejects(db.run('DELETE FROM events WHERE id = ?', ['ev1']), /append-only/);

    // Transaksi gagal di-rollback.
    await assert.rejects(db.tx(async (t) => {
      await t.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', ['ws2', 'Rollback', now]);
      throw new Error('batal');
    }));
    assert.equal(await db.get('SELECT id FROM workspaces WHERE id = ?', ['ws2']), null);
  } finally {
    await db.close();
  }
});
