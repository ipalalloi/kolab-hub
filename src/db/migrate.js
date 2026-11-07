// Menjalankan migrasi SQL berurutan. Dipakai oleh `npm run migrate` dan oleh uji.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function renderMigration(text, dialect) {
  const serial = dialect === 'pg' ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  let section = 'all';
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^--\s*@(all|sqlite|pg)\s*$/);
    if (m) { section = m[1]; continue; }
    if (section === 'all' || section === dialect) out.push(line);
  }
  return out.join('\n').replaceAll('{{SERIAL}}', serial);
}

export async function migrate(db, { log = () => {} } = {}) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((await db.all('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = renderMigration(readFileSync(join(DIR, f), 'utf8'), db.dialect);
    await db.tx(async (t) => {
      if (t.dialect === 'pg') await t.run(sql);
      else for (const stmt of splitSqlite(sql)) await t.run(stmt);
      await t.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [f, new Date().toISOString()]);
    });
    log(`migrasi diterapkan: ${f}`);
  }
}

// SQLite prepare() hanya menerima satu pernyataan; pecah dengan memperhatikan blok TRIGGER ... END;
function splitSqlite(sql) {
  const stmts = [];
  let buf = '';
  for (const line of sql.split('\n')) {
    if (/^\s*--/.test(line) || !line.trim()) { continue; }
    buf += line + '\n';
    const inTrigger = /CREATE\s+TRIGGER/i.test(buf);
    if ((inTrigger && /END;\s*$/i.test(line)) || (!inTrigger && /;\s*$/.test(line))) { stmts.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) stmts.push(buf.trim());
  return stmts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadDotEnv, loadConfig } = await import('../config.js');
  const { openDb } = await import('./index.js');
  loadDotEnv();
  const cfg = loadConfig();
  const db = await openDb(cfg.db);
  await migrate(db, { log: console.log });
  console.log('migrasi selesai');
  await db.close();
}
