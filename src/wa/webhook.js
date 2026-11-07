// Gerbang webhook WhatsApp: verifikasi tanda tangan, simpan pesan mentah (terenkripsi), masukkan antrean, balas 200 cepat.
import { verifyMetaSignature } from '../lib/crypto.js';
import { nowIso, normalizePhone } from '../lib/util.js';

export function extractMessages(payload) {
  const out = [];
  const statuses = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const s of v.statuses || []) statuses.push(s);
      for (const m of v.messages || []) {
        let body = '';
        let media = null;
        switch (m.type) {
          case 'text': body = m.text?.body || ''; break;
          case 'interactive': body = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || m.interactive?.button_reply?.title || ''; break;
          case 'button': body = m.button?.payload || m.button?.text || ''; break;
          case 'image': case 'document': case 'video': case 'audio': case 'sticker': {
            const obj = m[m.type] || {};
            media = { type: m.type, id: obj.id, mime_type: obj.mime_type, sha256: obj.sha256, filename: obj.filename };
            body = obj.caption || '';
            break;
          }
          default: body = '';
        }
        out.push({ meta_id: m.id, from: m.from, type: m.type, body, media, context_id: m.context?.id || null, timestamp: m.timestamp });
      }
    }
  }
  return { messages: out, statuses };
}

export function makeWebhook(ctx) {
  const { db, crypto, cfg, queue } = ctx;

  async function verifyGet(query) {
    if (query.get('hub.mode') === 'subscribe' && query.get('hub.verify_token') === cfg.wa.verifyToken) {
      return { status: 200, body: query.get('hub.challenge') || '' };
    }
    return { status: 403, body: 'forbidden' };
  }

  async function receive(rawBody, signatureHeader) {
    if (!verifyMetaSignature(cfg.wa.appSecret, rawBody, signatureHeader)) return { status: 401, body: 'invalid signature' };
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return { status: 400, body: 'bad json' }; }
    const { messages, statuses } = extractMessages(payload);
    let accepted = 0;
    for (const m of messages) {
      const phone = normalizePhone(m.from);
      if (!m.meta_id || !phone) continue;
      const phoneHash = crypto.blindIndex(phone);
      const since = new Date(Date.now() - 60_000).toISOString();
      const recent = await db.get('SELECT COUNT(*) AS n FROM wa_messages WHERE phone_hash = ? AND received_at > ?', [phoneHash, since]);
      const limited = Number(recent.n) >= cfg.wa.rateLimitPerMinute;
      const inserted = await db.run(
        `INSERT INTO wa_messages (meta_id, phone_hash, msg_type, body_enc, media, context_id, status, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (meta_id) DO NOTHING`,
        [m.meta_id, phoneHash, m.type, crypto.encrypt(m.body), m.media ? JSON.stringify(m.media) : null, m.context_id,
          limited ? 'rate_limited' : 'received', nowIso()],
      );
      if (inserted.changes > 0 && !limited) {
        await queue.enqueue('wa.process', { meta_id: m.meta_id }, { dedupeKey: `wa:${m.meta_id}` });
        accepted++;
      }
    }
    for (const s of statuses) {
      if (!s.id || !['delivered', 'read', 'failed'].includes(s.status)) continue;
      await db.run("UPDATE wa_outbox SET status = ? WHERE provider_id = ? AND status <> 'read'", [s.status, s.id]);
    }
    return { status: 200, body: 'EVENT_RECEIVED', accepted };
  }

  return { verifyGet, receive };
}
