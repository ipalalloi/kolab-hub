// Antrean tugas berbasis tabel `jobs` (tahan banting: pesan tidak hilang bila proses mati).
// PostgreSQL memakai FOR UPDATE SKIP LOCKED sehingga beberapa worker aman berjalan bersamaan.
import { newId, nowIso, parseJson } from '../lib/util.js';

export function makeQueue(db) {
  return {
    async enqueue(type, payload, { dedupeKey = null, runAt = null, t = db } = {}) {
      const ts = nowIso();
      const r = await t.run(
        `INSERT INTO jobs (id, type, payload, dedupe_key, status, attempts, run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING`,
        [newId(), type, JSON.stringify(payload), dedupeKey, runAt || ts, ts, ts],
      );
      return r.changes > 0;
    },

    async claim() {
      const ts = nowIso();
      const lockSql = db.dialect === 'pg' ? 'FOR UPDATE SKIP LOCKED' : '';
      const r = await db.run(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at, id LIMIT 1 ${lockSql})
         RETURNING *`,
        [ts, ts],
      );
      const job = r.rows[0];
      return job ? { ...job, attempts: Number(job.attempts), payload: parseJson(job.payload, {}) } : null;
    },

    async complete(id) {
      await db.run("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?", [nowIso(), id]);
    },

    async fail(job, err, maxAttempts = 5) {
      const dead = job.attempts >= maxAttempts;
      const delayMs = Math.min(60_000 * 2 ** (job.attempts - 1), 30 * 60_000);
      await db.run(
        'UPDATE jobs SET status = ?, last_error = ?, run_at = ?, updated_at = ? WHERE id = ?',
        [dead ? 'failed' : 'queued', String(err?.stack || err).slice(0, 2000), new Date(Date.now() + delayMs).toISOString(), nowIso(), job.id],
      );
      return dead;
    },

    /** Kembalikan tugas yang macet di status running (mis. proses mati) ke antrean. */
    async recoverStale(olderThanMs = 5 * 60_000) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      await db.run("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running' AND updated_at < ?", [nowIso(), cutoff]);
    },
  };
}
