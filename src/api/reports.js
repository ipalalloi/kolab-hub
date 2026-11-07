// Fase 2: dasbor beban kerja dan ekspor laporan (CSV). Hanya pemilik dan koordinator,
// hanya dari web, dan setiap ekspor dicatat di audit log.
import { HttpError, nowIso, parseJson } from '../lib/util.js';
import { requireRole } from '../domain/actions.js';
import { audit } from '../domain/store.js';
import { localParts } from '../notify/digest.js';

const COLUMN_LABEL = { masuk: 'Masuk', dikerjakan: 'Dikerjakan', ditinjau: 'Ditinjau', selesai: 'Selesai', tertahan: 'Tertahan' };
export const EVENT_LABEL = {
  'card.created': 'dibuat', 'card.assigned': 'ditugaskan', 'card.edited': 'diubah', 'card.started': 'mulai', 'card.resumed': 'dilanjutkan',
  'card.progress': 'progres', 'card.done': 'selesai (ditinjau)', 'card.approved': 'disetujui', 'card.revision': 'revisi diminta',
  'card.held': 'ditahan', 'card.moved': 'dipindah', 'card.commented': 'komentar', 'card.help_requested': 'minta bantuan',
  'card.review_cleared': 'sudah dicek', 'card.deleted': 'dihapus', 'event.reverted': 'pembatalan',
};

/** Sel CSV aman: dikutip bila perlu, dan diawali ' bila bisa dibaca sebagai rumus (CSV injection). */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, rows, sep = ',') {
  // BOM agar Excel membaca UTF-8 (nama dan judul berbahasa Indonesia) dengan benar.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(sep)).join('\r\n') + '\r\n';
}

const DAY_MS = 86_400_000;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

function median(xs) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function registerReports(router, ctx, { need }) {
  const { db, cfg } = ctx;
  const today = () => localParts(Date.now(), cfg.digest.tz).day;

  async function workload(workspaceId, days) {
    const day = today();
    const in7 = new Date(Date.parse(day) + 7 * DAY_MS).toISOString().slice(0, 10);
    const since = new Date(Date.now() - days * DAY_MS).toISOString();
    const members = await db.all(
      `SELECT p.id, p.name, p.erased_at, m.role, m.availability, m.wip_limit, m.skills FROM memberships m JOIN people p ON p.id = m.person_id
       WHERE m.workspace_id = ? AND m.removed_at IS NULL AND m.role <> 'viewer' ORDER BY p.name`, [workspaceId]);
    const cards = await db.all("SELECT id, assignee_id, column_key, due_date, created_at FROM cards WHERE workspace_id = ? AND deleted_at IS NULL", [workspaceId]);
    // Kartu yang disetujui dalam periode, dihitung untuk penanggung jawab saat ini; event yang dibatalkan tidak dihitung.
    const approved = await db.all(
      `SELECT e.seq, e.card_id, e.created_at FROM events e WHERE e.workspace_id = ? AND e.type = 'card.approved' AND e.created_at >= ?
         AND NOT EXISTS (SELECT 1 FROM events r WHERE r.card_id = e.card_id AND r.type = 'event.reverted' AND r.payload LIKE '%"target_seq":' || e.seq || ',%')`,
      [workspaceId, since]);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const blank = () => ({ masuk: 0, dikerjakan: 0, ditinjau: 0, tertahan: 0, terlambat: 0, tenggat_7_hari: 0, selesai_periode: 0, lead_days: [] });
    const stats = new Map(members.map((m) => [m.id, blank()]));
    const unassigned = blank();
    for (const c of cards) {
      const st = (c.assignee_id && stats.get(c.assignee_id)) || (c.assignee_id ? null : unassigned);
      if (!st || c.column_key === 'selesai') continue;
      st[c.column_key] += 1;
      if (c.due_date && c.due_date < day) st.terlambat += 1;
      else if (c.due_date && c.due_date <= in7) st.tenggat_7_hari += 1;
    }
    for (const a of approved) {
      const c = byId.get(a.card_id);
      const st = c?.assignee_id && stats.get(c.assignee_id);
      if (!st) continue;
      st.selesai_periode += 1;
      st.lead_days.push((Date.parse(a.created_at) - Date.parse(c.created_at)) / DAY_MS);
    }
    const out = members.map((m) => {
      const st = stats.get(m.id);
      const aktif = st.masuk + st.dikerjakan + st.ditinjau + st.tertahan;
      const med = median(st.lead_days);
      return {
        id: m.id, name: m.erased_at ? 'Mantan anggota' : m.name, role: m.role, availability: m.availability, wip_limit: Number(m.wip_limit), skills: m.skills,
        masuk: st.masuk, dikerjakan: st.dikerjakan, ditinjau: st.ditinjau, tertahan: st.tertahan, aktif,
        terlambat: st.terlambat, tenggat_7_hari: st.tenggat_7_hari, selesai_periode: st.selesai_periode,
        median_hari_selesai: med === null ? null : Math.round(med * 10) / 10,
        melebihi_wip: st.dikerjakan >= Number(m.wip_limit),
      };
    });
    const { lead_days, ...belum } = unassigned;
    void lead_days;
    return {
      generated_at: nowIso(), today: day, period_days: days, members: out,
      unassigned: { ...belum, aktif: belum.masuk + belum.dikerjakan + belum.ditinjau + belum.tertahan },
      totals: ['masuk', 'dikerjakan', 'ditinjau', 'tertahan', 'terlambat'].reduce((acc, k) => ({ ...acc, [k]: out.reduce((n, m) => n + m[k], 0) + unassigned[k] }), {}),
    };
  }

  const periodDays = (q) => {
    const d = Number(q.get('hari') || 30);
    if (!Number.isInteger(d) || d < 1 || d > 365) throw new HttpError(400, 'Periode 1–365 hari');
    return d;
  };
  const query = (req) => new URL(req.url, 'http://x').searchParams;
  const sepOf = (q) => (q.get('pemisah') === 'titik-koma' ? ';' : ',');
  const csv = (name, body) => ({ status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` }, body });
  const stamp = () => today().replace(/-/g, '');

  router.get('/api/workspaces/:id/workload', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner', 'coordinator']);
    return workload(id, periodDays(query(req)));
  });

  router.get('/api/workspaces/:id/export/workload.csv', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner', 'coordinator']);
    const q = query(req);
    const w = await workload(id, periodDays(q));
    await audit(db, { workspace_id: id, actor_id: p.id, action: 'export.workload', detail: { hari: w.period_days }, ip: req.ip });
    const rows = w.members.map((m) => [m.name, m.role, m.availability, m.wip_limit, m.masuk, m.dikerjakan, m.ditinjau, m.tertahan, m.aktif, m.terlambat, m.tenggat_7_hari, m.selesai_periode, m.median_hari_selesai ?? '', m.melebihi_wip ? 'ya' : 'tidak']);
    rows.push(['(belum ditugaskan)', '', '', '', w.unassigned.masuk, w.unassigned.dikerjakan, w.unassigned.ditinjau, w.unassigned.tertahan, w.unassigned.aktif, w.unassigned.terlambat, w.unassigned.tenggat_7_hari, '', '', '']);
    return csv(`beban-kerja-${stamp()}.csv`, toCsv(['Nama', 'Peran', 'Ketersediaan', 'Batas WIP', 'Masuk', 'Dikerjakan', 'Ditinjau', 'Tertahan', 'Aktif', 'Terlambat', 'Tenggat 7 hari', `Selesai ${w.period_days} hari`, 'Median hari sampai selesai', 'Melebihi WIP'], rows, sepOf(q)));
  });

  router.get('/api/workspaces/:id/export/cards.csv', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner', 'coordinator']);
    const q = query(req);
    const board = q.get('proyek');
    const status = q.get('status');
    if (status && !COLUMN_LABEL[status]) throw new HttpError(400, 'Status tidak dikenal');
    const params = [id];
    let where = 'c.workspace_id = ? AND c.deleted_at IS NULL';
    if (board) { where += ' AND c.board_id = ?'; params.push(board); }
    if (status) { where += ' AND c.column_key = ?'; params.push(status); }
    const rows = await db.all(
      `SELECT c.*, b.prefix, b.name AS board_name, a.name AS assignee_name, a.erased_at AS assignee_erased FROM cards c
       JOIN boards b ON b.id = c.board_id LEFT JOIN people a ON a.id = c.assignee_id WHERE ${where} ORDER BY c.code`, params);
    const day = today();
    await audit(db, { workspace_id: id, actor_id: p.id, action: 'export.cards', detail: { proyek: board || null, status: status || null, baris: rows.length }, ip: req.ip });
    return csv(`kartu-${stamp()}.csv`, toCsv(
      ['Kode', 'Proyek', 'Judul', 'Status', 'Penanggung jawab', 'Prioritas', 'Tenggat', 'Progres (%)', 'Terlambat', 'Perlu dicek', 'Alasan tertahan', 'Dibuat', 'Diperbarui'],
      rows.map((c) => [c.code, c.board_name, c.title, COLUMN_LABEL[c.column_key], c.assignee_id ? (c.assignee_erased ? 'Mantan anggota' : c.assignee_name) : '', c.priority, c.due_date || '',
        Number(c.progress), c.due_date && c.due_date < day && c.column_key !== 'selesai' ? 'ya' : 'tidak', Number(c.needs_review) ? 'ya' : 'tidak', c.hold_reason || '', c.created_at, c.updated_at]),
      sepOf(q)));
  });

  router.get('/api/workspaces/:id/export/events.csv', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner', 'coordinator']);
    const q = query(req);
    const to = q.get('sampai') || today();
    const from = q.get('dari') || new Date(Date.parse(to) - 29 * DAY_MS).toISOString().slice(0, 10);
    if (!isDate(from) || !isDate(to) || from > to) throw new HttpError(400, 'Rentang tanggal tidak sah (YYYY-MM-DD)');
    if ((Date.parse(to) - Date.parse(from)) / DAY_MS > 366) throw new HttpError(400, 'Rentang maksimal 366 hari');
    // Batas memakai UTC; tanggal "sampai" inklusif sampai akhir hari.
    const evs = await db.all(
      `SELECT e.*, c.code, a.name AS actor_name, a.erased_at AS actor_erased FROM events e
       LEFT JOIN cards c ON c.id = e.card_id LEFT JOIN people a ON a.id = e.actor_id
       WHERE e.workspace_id = ? AND e.created_at >= ? AND e.created_at < ? ORDER BY e.seq`,
      [id, `${from}T00:00:00.000Z`, new Date(Date.parse(to) + DAY_MS).toISOString()]);
    const all = await db.all("SELECT payload FROM events WHERE workspace_id = ? AND type = 'event.reverted'", [id]);
    const reverted = new Set(all.map((r) => Number(parseJson(r.payload, {}).target_seq)));
    await audit(db, { workspace_id: id, actor_id: p.id, action: 'export.events', detail: { dari: from, sampai: to, baris: evs.length }, ip: req.ip });
    const detail = (e) => {
      const x = parseJson(e.payload, {});
      const bits = [];
      if (x.title && e.type === 'card.created') bits.push(x.title);
      if (x.percent !== undefined) bits.push(`${x.percent}%`);
      if (x.to) bits.push(`ke ${COLUMN_LABEL[x.to] || x.to}`);
      for (const k of ['note', 'reason', 'text']) if (x[k]) bits.push(String(x[k]));
      if (x.fields) bits.push(`ubah: ${Object.keys(x.fields).join(', ')}`);
      if (x.target_seq) bits.push(`membatalkan #${x.target_seq}`);
      return bits.join(' · ');
    };
    return csv(`riwayat-${from.replace(/-/g, '')}-${to.replace(/-/g, '')}.csv`, toCsv(
      ['No', 'Waktu (UTC)', 'Kode', 'Kejadian', 'Sumber', 'Pelaku', 'Rincian', 'Dilakukan luring', 'Dibatalkan'],
      evs.map((e) => [Number(e.seq), e.created_at, e.code || '', EVENT_LABEL[e.type] || e.type, e.source, e.actor_id ? (e.actor_erased ? 'Mantan anggota' : e.actor_name) : 'Sistem',
        detail(e), parseJson(e.payload, {}).offline_at || '', reverted.has(Number(e.seq)) ? 'ya' : 'tidak']),
      sepOf(q)));
  });
}
