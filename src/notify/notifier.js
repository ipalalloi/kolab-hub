// Kebijakan notifikasi "push-first": Web Push (gratis) bila orang itu berlangganan,
// WhatsApp hanya sebagai cadangan untuk hal yang wajib sampai (penugasan, ringkasan harian).
// Notifikasi tambahan Fase 2 (revisi, menunggu tinjauan, minta bantuan) hanya lewat push
// agar tidak menambah biaya pesan WA. Sumbernya event log, jadi berlaku sama untuk web, PWA, dan WA.
import { parseJson } from '../lib/util.js';

const CURSOR_KEY = 'notify.cursor';

export function makeNotifier(ctx) {
  const { cfg, crypto, push, outbound } = ctx;
  const link = (code) => `${cfg.baseUrl}/#/kartu/${code}`;

  async function person(t, id) {
    return id ? t.get('SELECT * FROM people WHERE id = ? AND erased_at IS NULL', [id]) : null;
  }

  async function managers(t, workspaceId) {
    return t.all(
      `SELECT p.id FROM memberships m JOIN people p ON p.id = m.person_id
       WHERE m.workspace_id = ? AND m.removed_at IS NULL AND m.role IN ('owner','coordinator') AND p.erased_at IS NULL`, [workspaceId]);
  }

  const api = {
    /** Penugasan kartu: push bila ada, selain itu template WA (seperti MVP). Mengembalikan kanal yang dipakai. */
    async assignment(t, card, assigneeId) {
      const p = await person(t, assigneeId);
      if (!p) return null;
      const url = link(card.code);
      const sent = await push.notify(t, p.id, { title: `Tugas baru ${card.code}`, body: card.title, url: `/#/kartu/${card.code}`, tag: `kartu-${card.code}` });
      if (sent) return 'push';
      const phone = crypto.decrypt(p.phone_enc);
      if (!phone) return null;
      await outbound.template(t, {
        phone, person_id: p.id, workspace_id: card.workspace_id, card_id: card.id,
        text: `Tugas baru ${card.code}: ${card.title}\nBalas pesan ini dengan "mulai" untuk mulai mengerjakan.\n${url}`,
        template: { name: cfg.wa.assignTemplate, components: [{ type: 'body', parameters: [{ type: 'text', text: card.code }, { type: 'text', text: card.title }, { type: 'text', text: url }] }] },
      });
      return 'wa';
    },

    /**
     * Baca event baru sejak kursor dan kirim notifikasi push yang relevan.
     * Kursor awal = event terakhir saat fitur dipasang, jadi riwayat lama tidak memicu notifikasi.
     */
    async scan(limit = 200) {
      if (!push.enabled) return 0;
      const db = ctx.db;
      const row = await db.get('SELECT value FROM kv WHERE key = ?', [CURSOR_KEY]);
      let cursor = row ? Number(row.value) : null;
      if (cursor === null) {
        cursor = Number((await db.get('SELECT MAX(seq) AS s FROM events'))?.s || 0);
        await db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [CURSOR_KEY, String(cursor)]);
        return 0;
      }
      // Batas atas dibaca lebih dulu: event yang masuk setelah ini diproses pada putaran berikutnya, tidak terlewat.
      const maxSeq = Number((await db.get('SELECT MAX(seq) AS s FROM events'))?.s || cursor);
      if (maxSeq <= cursor) return 0;
      const evs = await db.all(
        `SELECT seq, workspace_id, card_id, type, actor_id, payload FROM events
         WHERE seq > ? AND seq <= ? AND type IN ('card.revision','card.done','card.help_requested') ORDER BY seq LIMIT ?`, [cursor, maxSeq, limit]);
      let sent = 0;
      await db.tx(async (t) => {
        for (const e of evs) {
          const card = await t.get('SELECT * FROM cards WHERE id = ? AND deleted_at IS NULL', [e.card_id]);
          if (!card) continue;
          const p = parseJson(e.payload, {});
          const url = `/#/kartu/${card.code}`;
          const targets = [];
          let msg;
          if (e.type === 'card.revision') {
            if (card.assignee_id) targets.push(card.assignee_id);
            msg = { title: `Revisi diminta: ${card.code}`, body: `${card.title}${p.note ? ` — ${p.note}` : ''}` };
          } else if (e.type === 'card.done') {
            for (const m of await managers(t, card.workspace_id)) targets.push(m.id);
            msg = { title: `Menunggu tinjauan: ${card.code}`, body: card.title };
          } else {
            for (const m of await managers(t, card.workspace_id)) targets.push(m.id);
            msg = { title: `Butuh bantuan: ${card.code}`, body: `${card.title}${p.note ? ` — ${p.note}` : ''}` };
          }
          for (const pid of new Set(targets)) {
            if (pid === e.actor_id) continue; // tidak memberi tahu pelaku tindakannya sendiri
            sent += await push.notify(t, pid, { ...msg, url, tag: `kartu-${card.code}` }, { dedupeKey: `notify:${e.seq}:${pid}` });
          }
        }
        // Lompat ke event terakhir yang dibaca (atau ke ujung log bila tak ada event relevan di batch ini).
        const next = evs.length === limit ? Number(evs[evs.length - 1].seq) : maxSeq;
        await t.run('UPDATE kv SET value = ? WHERE key = ?', [String(next), CURSOR_KEY]);
      });
      return sent;
    },
  };
  return api;
}
