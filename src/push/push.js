// Layanan Web Push: simpan langganan per perangkat, kirim lewat antrean `push.send`.
// Isi notifikasi dienkripsi saat menunggu di antrean (memuat judul kartu).
import { newId, nowIso, HttpError } from '../lib/util.js';
import { encryptPayload, vapidAuthorization, checkVapidKeys, b64u } from './webpush.js';

export function makePush(ctx, { fetchImpl } = {}) {
  const { cfg, crypto, queue } = ctx;
  const enabled = !!(cfg.push.publicKey && cfg.push.privateKey);
  if (enabled) checkVapidKeys(cfg.push);
  const api = {
    enabled,
    publicKey: enabled ? cfg.push.publicKey : null,
    fetch: fetchImpl || ((...a) => fetch(...a)),

    async subscribe(t, personId, sub, device = '') {
      if (!enabled) throw new HttpError(409, 'Notifikasi push belum diaktifkan di server', 'push_disabled');
      const endpoint = String(sub?.endpoint || '');
      const p256dh = String(sub?.keys?.p256dh || '');
      const auth = String(sub?.keys?.auth || '');
      let url;
      try { url = new URL(endpoint); } catch { throw new HttpError(400, 'Langganan push tidak sah', 'bad_subscription'); }
      if (url.protocol !== 'https:') throw new HttpError(400, 'Endpoint push harus https', 'bad_subscription');
      if (b64u.dec(p256dh).length !== 65 || b64u.dec(auth).length !== 16) throw new HttpError(400, 'Kunci langganan push tidak sah', 'bad_subscription');
      const hash = crypto.blindIndex(endpoint);
      const existing = await t.get('SELECT id FROM push_subscriptions WHERE endpoint_hash = ?', [hash]);
      if (existing) {
        // Perangkat yang sama berpindah akun: langganan mengikuti orang yang sedang masuk.
        await t.run('UPDATE push_subscriptions SET person_id = ?, p256dh_enc = ?, auth_enc = ?, device = ?, last_error = NULL, last_error_at = NULL WHERE id = ?',
          [personId, crypto.encrypt(p256dh), crypto.encrypt(auth), String(device).slice(0, 80), existing.id]);
        return existing.id;
      }
      const id = newId();
      await t.run('INSERT INTO push_subscriptions (id, person_id, endpoint_hash, endpoint_enc, p256dh_enc, auth_enc, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, personId, hash, crypto.encrypt(endpoint), crypto.encrypt(p256dh), crypto.encrypt(auth), String(device).slice(0, 80), nowIso()]);
      return id;
    },

    async unsubscribe(t, personId, endpoint) {
      const r = await t.run('DELETE FROM push_subscriptions WHERE person_id = ? AND endpoint_hash = ?', [personId, crypto.blindIndex(String(endpoint || ''))]);
      return r.changes > 0;
    },

    async removeAll(t, personId) {
      await t.run('DELETE FROM push_subscriptions WHERE person_id = ?', [personId]);
    },

    async count(t, personId) {
      if (!enabled) return 0;
      const r = await t.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE person_id = ?', [personId]);
      return Number(r?.n || 0);
    },

    /**
     * Antrekan notifikasi untuk semua perangkat seseorang.
     * msg: { title, body, url, tag }. Mengembalikan jumlah perangkat (0 = tidak terkirim lewat push).
     */
    async notify(t, personId, msg, { dedupeKey = null } = {}) {
      if (!enabled) return 0;
      const subs = await t.all('SELECT id FROM push_subscriptions WHERE person_id = ?', [personId]);
      if (!subs.length) return 0;
      const payload = JSON.stringify({ title: String(msg.title).slice(0, 120), body: String(msg.body || '').slice(0, 1500), url: msg.url || '/', tag: msg.tag || undefined });
      const data = crypto.encrypt(payload);
      // Satu tugas per perangkat: percobaan ulang untuk satu perangkat tidak menggandakan notifikasi di perangkat lain.
      for (const s of subs) await queue.enqueue('push.send', { sub_id: s.id, data }, { t, dedupeKey: dedupeKey ? `${dedupeKey}:${s.id}` : null });
      return subs.length;
    },

    /** Dijalankan worker untuk satu perangkat. Gagal sementara (429/5xx/jaringan) dilempar agar dicoba ulang. */
    async send({ sub_id, data }) {
      const payload = crypto.decrypt(data);
      const s = await ctx.db.get('SELECT * FROM push_subscriptions WHERE id = ?', [sub_id]);
      if (!payload || !s) return; // langganan sudah dicabut
      const endpoint = crypto.decrypt(s.endpoint_enc);
      const body = encryptPayload(payload, { p256dh: crypto.decrypt(s.p256dh_enc), auth: crypto.decrypt(s.auth_enc) });
      const res = await api.fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: vapidAuthorization(endpoint, cfg.push),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(cfg.push.ttlSec),
          urgency: 'normal',
        },
        body,
      });
      if (res.status === 404 || res.status === 410) {
        // Langganan kedaluwarsa atau dicabut pengguna: hapus agar tidak dicoba lagi.
        await ctx.db.run('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
        return;
      }
      if (res.status >= 200 && res.status < 300) {
        await ctx.db.run('UPDATE push_subscriptions SET last_success_at = ?, last_error = NULL, last_error_at = NULL WHERE id = ?', [nowIso(), s.id]);
        return;
      }
      await ctx.db.run('UPDATE push_subscriptions SET last_error = ?, last_error_at = ? WHERE id = ?', [`HTTP ${res.status}`, nowIso(), s.id]);
      if (res.status === 429 || res.status >= 500) throw new Error(`layanan push ${res.status}`);
      // 4xx lain (mis. 400/403/413): bukan masalah sementara, tidak dicoba ulang.
    },
  };
  return api;
}
