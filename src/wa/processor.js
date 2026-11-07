// Mengubah pesan WA masuk menjadi event kartu. Tidak ada pesan yang dibuang:
// yang tidak cocok pola disimpan sebagai komentar "perlu dicek" atau masuk antrean tinjauan.
import { HttpError, nowIso, parseJson, newId } from '../lib/util.js';
import { parseMessage, HELP_TEXT } from './parser.js';
import { performCardAction, getCardByCode, MANAGER_ROLES } from '../domain/actions.js';
import { createCard } from '../domain/store.js';

const COLUMN_LABEL = { masuk: 'Masuk', dikerjakan: 'Dikerjakan', ditinjau: 'Ditinjau', selesai: 'Selesai', tertahan: 'Tertahan' };

export function makeProcessor(ctx) {
  const { db, crypto, cfg, outbound } = ctx;
  const link = (code) => `${cfg.baseUrl}/#/kartu/${code}`;

  async function reply(t, msg, person, text, extra = {}) {
    const phone = crypto.decrypt(person?.phone_enc) || extra.phone;
    if (!phone) return;
    await outbound.text(t, { phone, person_id: person?.id, workspace_id: extra.workspace_id, card_id: extra.card_id, text });
  }

  async function myTasks(t, person) {
    const rows = await t.all(
      `SELECT c.code, c.title, c.column_key, c.due_date, c.progress FROM cards c
       JOIN memberships m ON m.workspace_id = c.workspace_id AND m.person_id = ? AND m.removed_at IS NULL
       WHERE c.assignee_id = ? AND c.deleted_at IS NULL AND c.column_key <> 'selesai'
       ORDER BY CASE WHEN c.due_date IS NULL THEN 1 ELSE 0 END, c.due_date, c.code LIMIT 15`,
      [person.id, person.id],
    );
    if (!rows.length) return 'Tidak ada tugas aktif. 👍';
    const today = new Date().toISOString().slice(0, 10);
    const lines = rows.map((r) => {
      const late = r.due_date && r.due_date < today ? ' ⚠️terlambat' : '';
      const due = r.due_date ? ` · tenggat ${r.due_date}` : '';
      return `• ${r.code} ${r.title} — ${COLUMN_LABEL[r.column_key]}${r.progress ? ` ${r.progress}%` : ''}${due}${late}`;
    });
    return `Tugas Anda (${rows.length}):\n${lines.join('\n')}\n${cfg.baseUrl}/#/tugasku`;
  }

  async function resolveBoardForNew(t, person, parsed) {
    const boards = await t.all(
      `SELECT b.*, m.role FROM boards b JOIN memberships m ON m.workspace_id = b.workspace_id AND m.person_id = ? AND m.removed_at IS NULL
       WHERE b.closed_at IS NULL ORDER BY b.prefix`,
      [person.id],
    );
    if (parsed.prefixCandidate) {
      const b = boards.find((x) => x.prefix === parsed.prefixCandidate);
      if (b) return { board: b, title: parsed.titleIfPrefix };
    }
    if (boards.length === 1) return { board: boards[0], title: parsed.title };
    if (!boards.length) throw new HttpError(404, 'Anda belum tergabung di proyek mana pun');
    throw new HttpError(400, `Sebutkan kode proyek: #baru <PROYEK> <judul>. Proyek Anda: ${boards.map((b) => b.prefix).join(', ')}`);
  }

  async function handleNew(t, msg, person, parsed) {
    const { board, title } = await resolveBoardForNew(t, person, parsed);
    if (!title || !title.trim()) throw new HttpError(400, 'Judul wajib diisi: #baru <PROYEK> <judul>');
    if (MANAGER_ROLES.has(board.role)) {
      const { card } = await createCard(t, { board, title, actor_id: person.id, source: 'wa', wa_message_id: msg.meta_id });
      return { text: `Kartu ${card.code} dibuat: ${card.title}\n${link(card.code)}`, workspace_id: board.workspace_id, card_id: card.id };
    }
    if (board.role === 'viewer') throw new HttpError(403, 'Pemantau tidak dapat mengusulkan kartu');
    const id = newId();
    await t.run(
      'INSERT INTO proposals (id, workspace_id, board_id, person_id, title, wa_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, board.workspace_id, board.id, person.id, title.trim().slice(0, 200), msg.meta_id, nowIso()],
    );
    return { text: `Usulan "${title.trim()}" untuk ${board.prefix} diteruskan ke koordinator. Anda akan diberi tahu bila dijadikan kartu.`, workspace_id: board.workspace_id };
  }

  async function lastActiveCard(t, person) {
    return t.get(
      `SELECT c.* FROM cards c JOIN memberships m ON m.workspace_id = c.workspace_id AND m.person_id = ? AND m.removed_at IS NULL
       WHERE c.assignee_id = ? AND c.deleted_at IS NULL AND c.column_key IN ('dikerjakan','tertahan','masuk')
       ORDER BY CASE c.column_key WHEN 'dikerjakan' THEN 0 ELSE 1 END, c.updated_at DESC LIMIT 1`,
      [person.id, person.id],
    );
  }

  function confirmText(card, state, action) {
    const map = {
      mulai: `▶️ ${card.code} sekarang Dikerjakan.`,
      progres: `📈 ${card.code} progres ${state.progress}% tercatat.`,
      selesai: `✅ ${card.code} dikirim untuk ditinjau koordinator.`,
      tahan: `⏸️ ${card.code} ditahan: ${state.hold_reason}`,
      bantuan: `🆘 Permintaan bantuan untuk ${card.code} diteruskan ke koordinator.`,
      komentar: `💬 Catatan ditambahkan ke ${card.code}.`,
    };
    return `${map[action] || `${card.code} diperbarui.`}\n${link(card.code)}`;
  }

  async function handleCard(t, msg, person, card, parsed, media) {
    let { action, args } = parsed;
    if (!action) return { text: `${card.code}: ${card.title} — ${COLUMN_LABEL[card.column_key]} ${card.progress}%\n${link(card.code)}`, card_id: card.id, workspace_id: card.workspace_id };
    if (media) {
      args = { ...args, attachments: [media] };
      if (action === 'komentar') args.text = `${args.text || ''} [lampiran ${media.type}]`.trim();
    }
    const { state } = await performCardAction(t, { card, actor: { person_id: person.id }, action, args, source: 'wa', wa_message_id: msg.meta_id });
    await t.run('UPDATE wa_messages SET workspace_id = ?, card_id = ? WHERE meta_id = ?', [card.workspace_id, card.id, msg.meta_id]);
    return { text: confirmText(card, state, action), card_id: card.id, workspace_id: card.workspace_id };
  }

  async function process(metaId) {
    const msg = await db.get('SELECT * FROM wa_messages WHERE meta_id = ?', [metaId]);
    if (!msg || msg.status !== 'received') return { skipped: true };
    const body = crypto.decrypt(msg.body_enc) || '';
    const media = parseJson(msg.media);
    const person = await db.get('SELECT * FROM people WHERE phone_hash = ? AND verified_at IS NOT NULL AND erased_at IS NULL', [msg.phone_hash]);

    return db.tx(async (t) => {
      const setStatus = (status, parsed, error) => t.run(
        'UPDATE wa_messages SET status = ?, parsed = ?, error = ?, person_id = ?, processed_at = ? WHERE meta_id = ?',
        [status, parsed ? JSON.stringify(parsed) : null, error || null, person?.id || null, nowIso(), metaId],
      );
      if (!person) {
        await setStatus('unknown_sender', null, 'nomor belum terverifikasi');
        // Tidak membalas nomor asing (hemat biaya & mencegah penyalahgunaan); tampil di antrean tinjauan pemilik.
        return { status: 'unknown_sender' };
      }
      let parsed = parseMessage(body);
      if (parsed.kind === 'empty' && media) parsed = { kind: 'contextual', action: 'komentar', args: { text: '' } };
      try {
        let result;
        if (parsed.kind === 'help') result = { text: HELP_TEXT };
        else if (parsed.kind === 'mytasks') result = { text: await myTasks(t, person) };
        else if (parsed.kind === 'new') result = await handleNew(t, msg, person, parsed);
        else if (parsed.kind === 'card') {
          const card = await getCardByCode(t, parsed.code);
          if (!card) throw new HttpError(404, `Kartu ${parsed.code} tidak ditemukan. Ketik #tugasku untuk melihat kode tugas Anda.`);
          result = await handleCard(t, msg, person, card, parsed, media);
        } else if (parsed.kind === 'contextual' && msg.context_id) {
          const ctxRow = await t.get('SELECT card_id FROM wa_outbox WHERE provider_id = ? AND card_id IS NOT NULL', [msg.context_id]);
          const card = ctxRow && await t.get('SELECT * FROM cards WHERE id = ? AND deleted_at IS NULL', [ctxRow.card_id]);
          if (!card) throw new HttpError(400, 'Sertakan kode kartu, mis. #DIS-0142 selesai');
          result = await handleCard(t, msg, person, card, parsed, media);
        } else {
          // Tidak cocok pola: simpan sebagai komentar di kartu aktif terakhir, tandai perlu dicek.
          const card = await lastActiveCard(t, person);
          if (card) {
            const text = (body || '').trim() || `[lampiran ${media?.type || 'pesan'}]`;
            await performCardAction(t, { card, actor: { person_id: person.id }, action: 'komentar', args: { text, needs_review: true, attachments: media ? [media] : [] }, source: 'wa', wa_message_id: metaId });
            await t.run('UPDATE wa_messages SET workspace_id = ?, card_id = ? WHERE meta_id = ?', [card.workspace_id, card.id, metaId]);
            await setStatus('needs_review', parsed);
            await reply(t, msg, person, `Pesan dicatat di ${card.code} dan ditandai perlu dicek koordinator.\nKetik #bantuan untuk daftar perintah.`, { card_id: card.id, workspace_id: card.workspace_id });
            return { status: 'needs_review', card_id: card.id };
          }
          await setStatus('needs_review', parsed);
          await reply(t, msg, person, `Pesan belum dikenali.\n${HELP_TEXT}`);
          return { status: 'needs_review' };
        }
        await setStatus('processed', parsed);
        await reply(t, msg, person, result.text, result);
        return { status: 'processed', ...result };
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        await setStatus('rejected', parsed, e.message);
        await reply(t, msg, person, `⚠️ ${e.message}`);
        return { status: 'rejected', error: e.message };
      }
    });
  }

  return { process };
}
