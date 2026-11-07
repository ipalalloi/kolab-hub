// Membuat workspace dan akun pemilik pertama di server produksi.
// Pemakaian: npm run create-owner -- --name "Nama" --phone 0812xxxx --workspace "Nama Tim"
import { loadDotEnv, loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { makeContext } from '../src/app.js';
import { audit } from '../src/domain/store.js';
import { DEFAULT_TRANSFERS } from '../src/api/routes.js';
import { newId, nowIso, normalizePhone } from '../src/lib/util.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const name = arg('name');
const phone = normalizePhone(arg('phone'));
const wsName = arg('workspace');
if (!name || !phone || !wsName) {
  console.error('Pemakaian: npm run create-owner -- --name "Nama" --phone 0812xxxx --workspace "Nama Tim"');
  process.exit(1);
}

loadDotEnv();
const cfg = loadConfig();
const db = await openDb(cfg.db);
await migrate(db);
const ctx = makeContext({ cfg, db });
const hash = ctx.crypto.blindIndex(phone);

await db.tx(async (t) => {
  const ts = nowIso();
  let person = await t.get('SELECT * FROM people WHERE phone_hash = ?', [hash]);
  if (!person) {
    const id = newId();
    // Persetujuan dicatat saat pemilik pertama kali masuk; nomor dianggap terverifikasi karena dibuat oleh admin server.
    await t.run('INSERT INTO people (id, name, phone_enc, phone_hash, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, name, ctx.crypto.encrypt(phone), hash, ts, ts]);
    person = { id };
  }
  const ws = newId();
  await t.run('INSERT INTO workspaces (id, name, retention_days, created_at) VALUES (?, ?, ?, ?)', [ws, wsName, cfg.retention.defaultDays, ts]);
  await t.run('INSERT INTO memberships (workspace_id, person_id, role, wip_limit, created_at) VALUES (?, ?, ?, ?, ?)', [ws, person.id, 'owner', cfg.defaultWipLimit, ts]);
  for (const x of DEFAULT_TRANSFERS) {
    await t.run('INSERT INTO data_transfers (id, workspace_id, purpose, country, recipient, data_categories, instrument, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [newId(), ws, x.purpose, x.country, x.recipient, x.data_categories, x.instrument, ts]);
  }
  await audit(t, { workspace_id: ws, actor_id: person.id, action: 'owner.created_by_admin' });
});
console.log(`Pemilik dibuat untuk ${phone.slice(0, 4)}****${phone.slice(-3)}. Masuk di ${cfg.baseUrl} dengan nomor tersebut.`);
await db.close();
