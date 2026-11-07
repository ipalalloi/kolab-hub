// Aturan transisi kartu dan hak akses. Dipakai bersama oleh web, PWA, dan WhatsApp.
import { HttpError } from '../lib/util.js';
import { appendCardEvent as appendEvent, lockCard } from './store.js';

export const MANAGER_ROLES = new Set(['owner', 'coordinator']);
const COLUMN_KEYS = new Set(['masuk', 'dikerjakan', 'ditinjau', 'selesai', 'tertahan']);

export async function getMembership(t, workspaceId, personId) {
  if (!personId) return null;
  return t.get('SELECT * FROM memberships WHERE workspace_id = ? AND person_id = ? AND removed_at IS NULL', [workspaceId, personId]);
}

export async function requireRole(t, workspaceId, personId, roles) {
  const m = await getMembership(t, workspaceId, personId);
  if (!m) throw new HttpError(403, 'Anda bukan anggota workspace ini', 'not_member');
  if (roles && !roles.includes(m.role)) throw new HttpError(403, 'Peran Anda tidak mengizinkan tindakan ini', 'forbidden');
  return m;
}

export async function getCardByCode(t, code) {
  return t.get('SELECT * FROM cards WHERE code = ? AND deleted_at IS NULL', [String(code).toUpperCase()]);
}

async function checkWip(t, card, personId) {
  const m = await getMembership(t, card.workspace_id, personId);
  if (!m) return;
  const r = await t.get(
    "SELECT COUNT(*) AS n FROM cards WHERE workspace_id = ? AND assignee_id = ? AND column_key = 'dikerjakan' AND deleted_at IS NULL AND id <> ?",
    [card.workspace_id, personId, card.id],
  );
  if (Number(r.n) >= Number(m.wip_limit)) {
    throw new HttpError(409, `Batas WIP tercapai: Anda sedang mengerjakan ${r.n} kartu (maksimal ${m.wip_limit}). Selesaikan atau tahan salah satu dulu.`, 'wip_limit');
  }
}

/**
 * Ubah isian persentase menjadi bilangan bulat 0–100, atau null bila tidak sah.
 * Isian kosong, spasi, null, boolean, dan teks bukan angka TIDAK dianggap 0
 * (Number('') === 0 adalah jebakan yang membuat kartu tercatat 0%).
 */
export function parsePercent(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 100 ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n <= 100 ? n : null;
}

/**
 * Tindakan tombol yang tersedia untuk seseorang pada kartu dalam keadaannya sekarang.
 * Cerminan aturan performCardAction (diuji silang di test/ui-actions.test.js) supaya
 * antarmuka tidak menampilkan tombol yang pasti ditolak server.
 * Batas WIP tidak dihitung di sini; itu diperiksa saat tindakan dijalankan.
 */
export function allowedActions(card, membership, personId) {
  if (!card || card.deleted_at || !membership || membership.role === 'viewer') return [];
  const out = [];
  const col = card.column_key;
  const isManager = MANAGER_ROLES.has(membership.role);
  const isWorker = isManager || (card.assignee_id && card.assignee_id === personId);
  if (isWorker && col !== 'selesai') {
    if (col === 'masuk' || col === 'tertahan') out.push('mulai');
    if (col !== 'ditinjau') out.push('progres', 'selesai');
    if (col !== 'tertahan') out.push('tahan');
    out.push('bantuan');
  }
  if (isManager && col === 'ditinjau') out.push('setujui', 'revisi');
  if (isManager && Number(card.needs_review)) out.push('cek');
  out.push('komentar');
  return out;
}

/**
 * Jalankan satu tindakan pada kartu.
 * @param actor {person_id}
 * @param action mulai|progres|selesai|tahan|lanjut|setujui|revisi|pindah|tugaskan|ubah|komentar|bantuan|hapus|cek
 */
/**
 * Waktu tindakan dilakukan di perangkat saat luring (ISO-8601). Diterima bila tidak lebih dari
 * 7 hari lalu dan tidak di masa depan (toleransi jam perangkat 5 menit). Selain itu diabaikan.
 */
export function parseOfflineAt(v, now = Date.now()) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms) || ms > now + 5 * 60_000 || ms < now - 7 * 86_400_000) return null;
  return new Date(ms).toISOString();
}

export async function performCardAction(t, { card: given, actor, action, args = {}, source, wa_message_id, offline_at }) {
  // Validasi selalu terhadap keadaan terkunci terbaru, bukan salinan yang dibaca sebelum transaksi.
  const card = await lockCard(t, given.id);
  if (!card || card.deleted_at) throw new HttpError(404, 'Kartu tidak ditemukan');
  const m = await requireRole(t, card.workspace_id, actor.person_id);
  const isManager = MANAGER_ROLES.has(m.role);
  const isAssignee = card.assignee_id && card.assignee_id === actor.person_id;
  const col = card.column_key;
  const base = { source, actor_id: actor.person_id, wa_message_id };
  const offlineAt = parseOfflineAt(offline_at);
  // Tindakan dari antrean luring mencatat kapan sebenarnya dilakukan; urutan tetap mengikuti saat diterima server.
  const appendCardEvent = (tx, c, ev) => appendEvent(tx, c, offlineAt ? { ...ev, payload: { ...ev.payload, offline_at: offlineAt } } : ev);
  const ensureWorker = () => {
    if (m.role === 'viewer') throw new HttpError(403, 'Pemantau hanya dapat melihat', 'forbidden');
    if (!isManager && !isAssignee) throw new HttpError(403, `Kartu ${card.code} bukan tugas Anda`, 'not_assignee');
  };
  const ensureManager = () => { if (!isManager) throw new HttpError(403, 'Hanya koordinator yang dapat melakukan ini', 'forbidden'); };
  const doneOrClosed = () => { if (col === 'selesai') throw new HttpError(409, `Kartu ${card.code} sudah selesai`, 'closed'); };
  const workerId = card.assignee_id || actor.person_id;

  switch (action) {
    case 'mulai': {
      ensureWorker(); doneOrClosed();
      if (col === 'dikerjakan') throw new HttpError(409, `Kartu ${card.code} sudah dikerjakan`, 'noop');
      if (col === 'ditinjau') throw new HttpError(409, `Kartu ${card.code} sedang ditinjau koordinator`, 'in_review');
      await checkWip(t, card, workerId);
      return appendCardEvent(t, card, { ...base, type: col === 'tertahan' ? 'card.resumed' : 'card.started', payload: {} });
    }
    case 'progres': {
      ensureWorker(); doneOrClosed();
      if (col === 'ditinjau') throw new HttpError(409, `Kartu ${card.code} sedang ditinjau koordinator`, 'in_review');
      const percent = parsePercent(args.percent);
      if (percent === null) throw new HttpError(400, 'Persentase progres wajib diisi dengan angka bulat 0–100', 'bad_percent');
      if (col !== 'dikerjakan') await checkWip(t, card, workerId);
      return appendCardEvent(t, card, { ...base, type: 'card.progress', payload: { percent, note: args.note || '' } });
    }
    case 'selesai': {
      ensureWorker(); doneOrClosed();
      if (col === 'ditinjau') throw new HttpError(409, `Kartu ${card.code} sudah menunggu tinjauan`, 'noop');
      return appendCardEvent(t, card, { ...base, type: 'card.done', payload: { note: args.note || '', attachments: args.attachments || [] } });
    }
    case 'tahan': {
      ensureWorker(); doneOrClosed();
      if (col === 'tertahan') throw new HttpError(409, `Kartu ${card.code} sudah tertahan`, 'noop');
      const reason = String(args.reason || '').trim();
      if (!reason) throw new HttpError(400, 'Alasan wajib diisi: #KODE tahan <alasan>', 'reason_required');
      return appendCardEvent(t, card, { ...base, type: 'card.held', payload: { reason } });
    }
    case 'setujui': {
      ensureManager();
      if (col !== 'ditinjau') throw new HttpError(409, 'Hanya kartu di kolom Ditinjau yang dapat disetujui', 'bad_state');
      return appendCardEvent(t, card, { ...base, type: 'card.approved', payload: { note: args.note || '' } });
    }
    case 'revisi': {
      ensureManager();
      if (col !== 'ditinjau') throw new HttpError(409, 'Hanya kartu di kolom Ditinjau yang dapat dikembalikan', 'bad_state');
      const note = String(args.note || '').trim();
      if (!note) throw new HttpError(400, 'Catatan revisi wajib diisi', 'note_required');
      return appendCardEvent(t, card, { ...base, type: 'card.revision', payload: { note } });
    }
    case 'pindah': {
      ensureManager();
      if (!COLUMN_KEYS.has(args.to)) throw new HttpError(400, 'Kolom tujuan tidak dikenal', 'bad_column');
      if (args.to === col) throw new HttpError(409, 'Kartu sudah di kolom itu', 'noop');
      if (args.to === 'tertahan' && !String(args.reason || '').trim()) throw new HttpError(400, 'Alasan wajib diisi untuk Tertahan', 'reason_required');
      return appendCardEvent(t, card, { ...base, type: 'card.moved', payload: { from: col, to: args.to, reason: args.reason || null } });
    }
    case 'tugaskan': {
      ensureManager();
      if (args.assignee_id) {
        const target = await getMembership(t, card.workspace_id, args.assignee_id);
        if (!target || target.role === 'viewer') throw new HttpError(400, 'Penanggung jawab harus anggota aktif', 'bad_assignee');
      }
      return appendCardEvent(t, card, { ...base, type: 'card.assigned', payload: { assignee_id: args.assignee_id || null, previous: card.assignee_id || null } });
    }
    case 'ubah': {
      ensureManager();
      const fields = {};
      const old = {};
      for (const k of ['title', 'description', 'due_date', 'priority']) {
        if (args[k] !== undefined && args[k] !== card[k]) { fields[k] = args[k]; old[k] = card[k]; }
      }
      if (fields.priority && !['rendah', 'normal', 'tinggi', 'mendesak'].includes(fields.priority)) throw new HttpError(400, 'Prioritas tidak dikenal');
      if ('title' in fields && !String(fields.title).trim()) throw new HttpError(400, 'Judul tidak boleh kosong');
      if (!Object.keys(fields).length) throw new HttpError(409, 'Tidak ada perubahan', 'noop');
      return appendCardEvent(t, card, { ...base, type: 'card.edited', payload: { fields, old } });
    }
    case 'komentar': {
      if (m.role === 'viewer') throw new HttpError(403, 'Pemantau hanya dapat melihat', 'forbidden');
      const text = String(args.text || '').trim();
      if (!text) throw new HttpError(400, 'Komentar kosong');
      return appendCardEvent(t, card, { ...base, type: 'card.commented', payload: { text: text.slice(0, 4000), needs_review: !!args.needs_review } });
    }
    case 'bantuan': {
      ensureWorker(); doneOrClosed();
      return appendCardEvent(t, card, { ...base, type: 'card.help_requested', payload: { note: String(args.note || '').slice(0, 1000) } });
    }
    case 'cek': {
      ensureManager();
      if (!Number(card.needs_review)) throw new HttpError(409, `Kartu ${card.code} tidak sedang ditandai perlu dicek`, 'noop');
      return appendCardEvent(t, card, { ...base, type: 'card.review_cleared', payload: {} });
    }
    case 'hapus': {
      ensureManager();
      return appendCardEvent(t, card, { ...base, type: 'card.deleted', payload: { reason: args.reason || '' } });
    }
    default:
      throw new HttpError(400, `Tindakan tidak dikenal: ${action}`, 'bad_action');
  }
}

/** Batalkan satu event (koreksi = event baru; riwayat asli tetap ada). */
export async function revertEvent(t, { seq, actor, reason, source }) {
  const ev = await t.get('SELECT * FROM events WHERE seq = ?', [seq]);
  if (!ev || !ev.card_id) throw new HttpError(404, 'Event tidak ditemukan');
  if (['card.created', 'event.reverted'].includes(ev.type)) throw new HttpError(409, 'Event ini tidak dapat dibatalkan');
  const card = await lockCard(t, ev.card_id);
  await requireRole(t, card.workspace_id, actor.person_id, ['owner', 'coordinator']);
  const already = await t.get("SELECT seq FROM events WHERE card_id = ? AND type = 'event.reverted' AND payload LIKE ?", [card.id, `%"target_seq":${Number(seq)},%`]);
  if (already) throw new HttpError(409, 'Event ini sudah dibatalkan');
  return appendEvent(t, card, { type: 'event.reverted', source, actor_id: actor.person_id, payload: { target_seq: Number(seq), target_type: ev.type, reason: reason || '' } });
}
