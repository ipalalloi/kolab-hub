// Adapter basis data. SQL ditulis dengan placeholder `?` dan portabel antara PostgreSQL (produksi)
// dan SQLite bawaan Node (`node:sqlite`, untuk uji, simulasi, dan instalasi kecil).
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const toParam = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

function makeLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

export async function openSqlite(path = ':memory:') {
  const { DatabaseSync } = await import('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const lock = makeLock();
  const exec = {
    async all(sql, params = []) { return raw.prepare(sql).all(...params.map(toParam)); },
    async get(sql, params = []) { return raw.prepare(sql).get(...params.map(toParam)) ?? null; },
    async run(sql, params = []) {
      const st = raw.prepare(sql);
      if (/\breturning\b/i.test(sql)) { const rows = st.all(...params.map(toParam)); return { changes: rows.length, rows }; }
      const r = st.run(...params.map(toParam));
      return { changes: Number(r.changes), rows: [] };
    },
  };
  const db = {
    dialect: 'sqlite',
    all: (s, p) => lock(() => exec.all(s, p)),
    get: (s, p) => lock(() => exec.get(s, p)),
    run: (s, p) => lock(() => exec.run(s, p)),
    exec: (s) => lock(async () => raw.exec(s)),
    tx: (fn) => lock(async () => {
      raw.exec('BEGIN IMMEDIATE');
      try { const out = await fn({ ...exec, dialect: 'sqlite' }); raw.exec('COMMIT'); return out; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    }),
    close: async () => raw.close(),
  };
  return db;
}

function pgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function openPg(url) {
  let pg;
  try { pg = (await import('pg')).default; }
  catch { throw new Error('Paket "pg" belum terpasang. Jalankan `npm install` di VPS (butuh akses internet).'); }
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // Tanpa parameter → protokol query sederhana (mengizinkan banyak pernyataan, mis. migrasi).
  const query = (q, sql, params) => (params.length ? q.query(pgSql(sql), params.map(toParam)) : q.query(sql));
  const wrap = (q) => ({
    async all(sql, params = []) { return (await query(q, sql, params)).rows; },
    async get(sql, params = []) { return (await query(q, sql, params)).rows[0] ?? null; },
    async run(sql, params = []) { const r = await query(q, sql, params); return { changes: r.rowCount ?? 0, rows: r.rows || [] }; },
  });
  return {
    dialect: 'pg',
    ...wrap(pool),
    exec: async (sql) => { await pool.query(sql); },
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ ...wrap(client), dialect: 'pg' });
        await client.query('COMMIT');
        return out;
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    },
    close: () => pool.end(),
  };
}

export async function openDb(cfg) {
  if (cfg.driver === 'pg') return openPg(cfg.url);
  return openSqlite(cfg.sqlitePath);
}
