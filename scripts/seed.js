// Data contoh untuk mencoba Kolab-Hub dalam mode simulasi. Nomor-nomor di bawah fiktif.
import { loadDotEnv, loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { makeContext } from '../src/app.js';
import { createCard, defaultColumns, audit } from '../src/domain/store.js';
import { performCardAction } from '../src/domain/actions.js';
import { DEFAULT_TRANSFERS, CONSENT_VERSION } from '../src/api/routes.js';
import { newId, nowIso } from '../src/lib/util.js';

loadDotEnv();
const cfg = loadConfig();
if (cfg.env === 'production' && !process.argv.includes('--force')) {
  console.error('Seed contoh ditolak di produksi. Pakai `npm run create-owner` untuk akun pertama.');
  process.exit(1);
}
const db = await openDb(cfg.db);
await migrate(db);
const ctx = makeContext({ cfg, db });

if (await db.get('SELECT 1 FROM workspaces LIMIT 1')) {
  console.log('Basis data sudah berisi data; seed dilewati.');
  process.exit(0);
}

const people = [
  ['Rina (pemilik)', '6281200000001', 'owner'],
  ['Dodi (koordinator)', '6281200000002', 'coordinator'],
  ['Ana', '6281200000003', 'collaborator'],
  ['Budi', '6281200000004', 'collaborator'],
  ['Pak Hasan (pemantau)', '6281200000005', 'viewer'],
];

await db.tx(async (t) => {
  const ws = newId();
  const ts = nowIso();
  await t.run('INSERT INTO workspaces (id, name, retention_days, created_at) VALUES (?, ?, ?, ?)', [ws, 'Tim Riset Contoh', cfg.retention.defaultDays, ts]);
  const ids = {};
  for (const [name, phone, role] of people) {
    const id = newId();
    ids[role === 'collaborator' ? name : role] = id;
    await t.run('INSERT INTO people (id, name, phone_enc, phone_hash, verified_at, consent_at, consent_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, ctx.crypto.encrypt(phone), ctx.crypto.blindIndex(phone), ts, ts, CONSENT_VERSION, ts]);
    await t.run('INSERT INTO memberships (workspace_id, person_id, role, wip_limit, skills, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [ws, id, role, cfg.defaultWipLimit, role === 'collaborator' ? 'survei, entri data' : '', ts]);
  }
  for (const x of DEFAULT_TRANSFERS) {
    await t.run('INSERT INTO data_transfers (id, workspace_id, purpose, country, recipient, data_categories, instrument, next_review, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [newId(), ws, x.purpose, x.country, x.recipient, x.data_categories, x.instrument, '2027-11-07', ts]);
  }
  const boards = {};
  for (const [prefix, name] of [['DIS', 'Disertasi'], ['PEN', 'Penelitian Lapangan']]) {
    const id = newId();
    await t.run('INSERT INTO boards (id, workspace_id, name, prefix, columns, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, ws, name, prefix, JSON.stringify(defaultColumns()), ts]);
    boards[prefix] = await t.get('SELECT * FROM boards WHERE id = ?', [id]);
  }
  const coord = ids.coordinator;
  const ana = ids.Ana;
  const budi = ids.Budi;
  const mk = (b, title, assignee, due, priority = 'normal') => createCard(t, { board: boards[b], title, assignee_id: assignee, due_date: due, priority, actor_id: coord, source: 'web' });
  const c1 = (await mk('DIS', 'Survei lokasi penelitian', ana, '2026-11-14', 'tinggi')).card;
  await mk('DIS', 'Rangkum literatur bab 2', budi, '2026-11-20');
  const c3 = (await mk('DIS', 'Susun instrumen kuesioner', ana, '2026-11-10')).card;
  await mk('PEN', 'Pinjam alat ukur ke laboratorium', null, null);
  const c5 = (await mk('PEN', 'Entri data responden gelombang 1', budi, '2026-11-12', 'mendesak')).card;
  const act = async (card, actor, action, args = {}) => performCardAction(t, { card: await t.get('SELECT * FROM cards WHERE id = ?', [card.id]), actor: { person_id: actor }, action, args, source: 'wa' });
  await act(c1, ana, 'mulai');
  await act(c1, ana, 'progres', { percent: 40, note: 'sudah 2 dari 5 lokasi' });
  await act(c3, ana, 'mulai');
  await act(c3, ana, 'selesai', { note: 'draf terlampir' });
  await act(c5, budi, 'tahan', { reason: 'menunggu data dari kelurahan' });
  await audit(t, { workspace_id: ws, actor_id: ids.owner, action: 'seed.loaded' });
});

console.log('Data contoh dimuat. Masuk lewat web dengan salah satu nomor fiktif berikut (kode OTP terlihat di /sim):');
for (const [name, phone] of people) console.log(`  ${phone}  ${name}`);
await db.close();
