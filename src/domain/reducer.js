// Status kartu dihitung dari urutan event (event sourcing). Fungsi murni, mudah diuji.
export const COLUMNS = [
  { key: 'masuk', name: 'Masuk' },
  { key: 'dikerjakan', name: 'Dikerjakan' },
  { key: 'ditinjau', name: 'Ditinjau' },
  { key: 'selesai', name: 'Selesai' },
  { key: 'tertahan', name: 'Tertahan' },
];

export function emptyCard() {
  return {
    title: '', description: '', assignee_id: null, due_date: null, priority: 'normal',
    column_key: 'masuk', progress: 0, hold_reason: null, held_from: null,
    needs_review: 0, deleted_at: null, last_seq: 0,
  };
}

export function applyEvent(card, ev) {
  const p = ev.payload || {};
  const c = { ...card, last_seq: ev.seq ?? card.last_seq };
  switch (ev.type) {
    case 'card.created':
      Object.assign(c, {
        title: p.title, description: p.description || '', assignee_id: p.assignee_id || null,
        due_date: p.due_date || null, priority: p.priority || 'normal', column_key: 'masuk',
      });
      break;
    case 'card.assigned': c.assignee_id = p.assignee_id || null; break;
    case 'card.edited':
      for (const k of ['title', 'description', 'due_date', 'priority']) if (p.fields && k in p.fields) c[k] = p.fields[k];
      break;
    case 'card.started': c.column_key = 'dikerjakan'; c.hold_reason = null; c.held_from = null; break;
    case 'card.progress':
      c.column_key = 'dikerjakan';
      if (Number.isFinite(p.percent)) c.progress = Math.max(0, Math.min(100, p.percent));
      break;
    case 'card.done': c.column_key = 'ditinjau'; c.progress = 100; break;
    case 'card.approved': c.column_key = 'selesai'; break;
    case 'card.revision': c.column_key = 'dikerjakan'; break;
    case 'card.held': c.held_from = c.column_key === 'tertahan' ? c.held_from : c.column_key; c.column_key = 'tertahan'; c.hold_reason = p.reason; break;
    case 'card.resumed': c.column_key = c.held_from && c.held_from !== 'masuk' ? c.held_from : 'dikerjakan'; c.hold_reason = null; c.held_from = null; break;
    case 'card.moved':
      if (p.to === 'tertahan') { c.held_from = c.column_key; c.hold_reason = p.reason || c.hold_reason; }
      else { c.hold_reason = null; c.held_from = null; }
      c.column_key = p.to;
      break;
    case 'card.commented': if (p.needs_review) c.needs_review = 1; break;
    case 'card.help_requested': c.needs_review = 1; break;
    case 'card.review_cleared': c.needs_review = 0; break;
    case 'card.deleted': c.deleted_at = ev.created_at; break;
    default: break;
  }
  return c;
}

/** Putar ulang event; event yang dibatalkan (event.reverted) dilewati. */
export function replay(events) {
  const reverted = new Set(events.filter((e) => e.type === 'event.reverted').map((e) => Number(e.payload.target_seq)));
  let card = emptyCard();
  for (const ev of events) {
    if (ev.type === 'event.reverted') { card.last_seq = ev.seq ?? card.last_seq; continue; }
    if (reverted.has(Number(ev.seq))) continue;
    card = applyEvent(card, ev);
  }
  return card;
}
