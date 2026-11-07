// Pesan keluar: dicatat di wa_outbox lalu dikirim lewat antrean.
// Mode `cloud`: WhatsApp Cloud API resmi (langsung atau lewat BSP yang meneruskan Cloud API).
// Mode `simulate`: tidak ada panggilan jaringan; pesan tampil di halaman /sim.
import { newId, nowIso, parseJson } from '../lib/util.js';

export function makeOutbound(ctx) {
  const { crypto, cfg, queue } = ctx;

  async function record(t, { phone, person_id, workspace_id, card_id, kind, text, template }) {
    const id = newId();
    await t.run(
      `INSERT INTO wa_outbox (id, person_id, phone_hash, to_enc, workspace_id, card_id, kind, body_enc, template, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      [id, person_id || null, crypto.blindIndex(phone), crypto.encrypt(phone), workspace_id || null, card_id || null, kind,
        crypto.encrypt(text), template ? JSON.stringify(template) : null, nowIso()],
    );
    await queue.enqueue('wa.send', { outbox_id: id }, { t, dedupeKey: `send:${id}` });
    return id;
  }

  return {
    /** Pesan teks bebas: hanya sah di dalam jendela layanan 24 jam (balasan atas pesan pengguna). */
    text: (t, o) => record(t, { ...o, kind: 'text' }),
    /** Pesan template yang sudah disetujui Meta (di luar jendela 24 jam, mis. OTP). */
    template: (t, o) => record(t, { ...o, kind: 'template' }),

    async send(outboxId) {
      const db = ctx.db;
      const row = await db.get('SELECT * FROM wa_outbox WHERE id = ?', [outboxId]);
      if (!row || row.status === 'sent') return;
      const to = crypto.decrypt(row.to_enc);
      const text = crypto.decrypt(row.body_enc);
      let providerId;
      if (cfg.wa.mode === 'simulate') {
        providerId = `sim.${row.id}`;
      } else {
        const tpl = parseJson(row.template);
        const body = row.kind === 'template'
          ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: tpl.name, language: { code: cfg.wa.templateLang }, components: tpl.components || [] } }
          : { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: true, body: text } };
        const res = await fetch(`${cfg.wa.apiBase}/${cfg.wa.phoneNumberId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.wa.accessToken}` },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          await db.run('UPDATE wa_outbox SET error = ? WHERE id = ?', [JSON.stringify(data).slice(0, 1000), row.id]);
          throw new Error(`WA API ${res.status}`);
        }
        providerId = data.messages?.[0]?.id || null;
      }
      await db.run("UPDATE wa_outbox SET status = 'sent', provider_id = ?, sent_at = ?, error = NULL WHERE id = ?", [providerId, nowIso(), row.id]);
    },
  };
}
