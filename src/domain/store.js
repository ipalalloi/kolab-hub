// Penulisan event log + proyeksi kartu, dalam satu transaksi.
import { newId, nowIso, parseJson, HttpError } from '../lib/util.js';
import { replay, COLUMNS } from './reducer.js';

export function rowToEvent(r) {
  return { ...r, seq: Number(r.seq), payload: parseJson(r.payload, {}) };
}

export async function cardEvents(t, cardId) {
  return (await t.all('SELECT * FROM events WHERE card_id = ? ORDER BY seq', [cardId])).map(rowToEvent);
}

async function insertEvent(t, { workspace_id, card_id, type, source, actor_id, payload, wa_message_id }) {
  const id = newId();
  const created_at = nowIso();
  const r = await t.run(
    `INSERT INTO events (id, workspace_id, card_id, type, source, actor_id, payload, wa_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
    [id, workspace_id, card_id || null, type, source, actor_id || null, JSON.stringify(payload || {}), wa_message_id || null, created_at],
  );
  return { id, seq: Number(r.rows[0].seq), workspace_id, card_id, type, source, actor_id, payload: payload || {}, created_at };
}

async function project(t, cardId) {
  const state = replay(await cardEvents(t, cardId));
  await t.run(
    `UPDATE cards SET title = ?, description = ?, assignee_id = ?, due_date = ?, priority = ?, column_key = ?,
       progress = ?, hold_reason = ?, needs_review = ?, last_seq = ?, deleted_at = ?, updated_at = ? WHERE id = ?`,
    [state.title, state.description, state.assignee_id, state.due_date, state.priority, state.column_key,
      state.progress, state.hold_reason, state.needs_review, state.last_seq, state.deleted_at, nowIso(), cardId],
  );
  return state;
}

/**
 * Kunci baris kartu sampai transaksi selesai lalu kembalikan keadaan terbarunya.
 * PostgreSQL: SELECT … FOR UPDATE sehingga perubahan bersamaan dari web dan WA berurutan.
 * SQLite: transaksi BEGIN IMMEDIATE sudah menyerialkan seluruh penulisan.
 */
export async function lockCard(t, cardId) {
  const lock = t.dialect === 'pg' ? ' FOR UPDATE' : '';
  return t.get(`SELECT * FROM cards WHERE id = ?${lock}`, [cardId]);
}

/** Tambah event untuk kartu yang sudah ada, lalu hitung ulang proyeksinya. */
export async function appendCardEvent(t, card, ev) {
  const e = await insertEvent(t, { ...ev, workspace_id: card.workspace_id, card_id: card.id });
  const state = await project(t, card.id);
  return { event: e, state };
}

export async function appendWorkspaceEvent(t, workspaceId, ev) {
  return insertEvent(t, { ...ev, workspace_id: workspaceId, card_id: null });
}

/** Buat kartu baru dengan kode berawalan proyek, mis. DIS-0142. */
export async function createCard(t, { board, title, description, assignee_id, due_date, priority, actor_id, source, wa_message_id, extra }) {
  if (!title || !String(title).trim()) throw new HttpError(400, 'Judul kartu wajib diisi');
  const r = await t.run('UPDATE boards SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq', [board.id]);
  const seq = Number(r.rows[0].next_seq);
  const code = `${board.prefix}-${String(seq).padStart(4, '0')}`;
  const id = newId();
  const ts = nowIso();
  await t.run(
    `INSERT INTO cards (id, workspace_id, board_id, code, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, board.workspace_id, board.id, code, String(title).trim().slice(0, 200), actor_id || null, ts, ts],
  );
  const card = { id, workspace_id: board.workspace_id, board_id: board.id, code };
  const { event, state } = await appendCardEvent(t, card, {
    type: 'card.created', source, actor_id, wa_message_id,
    payload: { code, title: String(title).trim().slice(0, 200), description: description || '', assignee_id: assignee_id || null, due_date: due_date || null, priority: priority || 'normal', ...(extra || {}) },
  });
  return { card: { ...card, ...state }, event };
}

export async function audit(t, { workspace_id, actor_id, action, target, detail, ip }) {
  await t.run(
    'INSERT INTO audit_log (workspace_id, actor_id, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [workspace_id || null, actor_id || null, action, target || null, JSON.stringify(detail || {}), ip || null, nowIso()],
  );
}

export function defaultColumns() {
  return COLUMNS.map((c) => ({ ...c, wip: null }));
}
