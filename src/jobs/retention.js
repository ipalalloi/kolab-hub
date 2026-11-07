// Penghapusan otomatis harian sesuai Aturan retensi (FINAL) di dokumen rancangan.
import { nowIso } from '../lib/util.js';

const daysAgo = (d, now = Date.now()) => new Date(now - d * 86_400_000).toISOString();

export async function runRetention(ctx, { now = Date.now() } = {}) {
  const { db, cfg } = ctx;
  const ts = nowIso();
  let purged = 0;
  const workspaces = await db.all('SELECT id, retention_days FROM workspaces');
  for (const w of workspaces) {
    const cutoff = daysAgo(Number(w.retention_days), now);
    const r1 = await db.run(
      'UPDATE wa_messages SET body_enc = NULL, media = NULL, content_purged_at = ? WHERE workspace_id = ? AND content_purged_at IS NULL AND received_at < ?',
      [ts, w.id, cutoff],
    );
    const r2 = await db.run(
      'UPDATE wa_outbox SET body_enc = NULL, template = NULL, content_purged_at = ? WHERE workspace_id = ? AND content_purged_at IS NULL AND created_at < ?',
      [ts, w.id, cutoff],
    );
    purged += r1.changes + r2.changes;
  }
  // Pesan tanpa workspace (nomor asing, pesan yang ditolak sebelum kartu dikenali) memakai masa bawaan.
  const defCutoff = daysAgo(cfg.retention.defaultDays, now);
  purged += (await db.run('UPDATE wa_messages SET body_enc = NULL, media = NULL, content_purged_at = ? WHERE workspace_id IS NULL AND content_purged_at IS NULL AND received_at < ?', [ts, defCutoff])).changes;
  purged += (await db.run('UPDATE wa_outbox SET body_enc = NULL, template = NULL, content_purged_at = ? WHERE workspace_id IS NULL AND content_purged_at IS NULL AND created_at < ?', [ts, defCutoff])).changes;
  // Nomor tujuan di outbox hanya diperlukan sampai terkirim.
  await db.run("UPDATE wa_outbox SET to_enc = NULL WHERE status IN ('sent','delivered','read','failed') AND created_at < ?", [daysAgo(7, now)]);
  await db.run('DELETE FROM otp_codes WHERE expires_at < ?', [daysAgo(1, now)]);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [new Date(now).toISOString()]);
  await db.run("DELETE FROM jobs WHERE status = 'done' AND updated_at < ?", [daysAgo(cfg.retention.logDays, now)]);
  await db.run(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ['retention.last_run', JSON.stringify({ at: ts, purged })],
  );
  return { purged };
}
