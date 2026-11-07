// API JSON untuk web dan PWA. Semua perubahan lewat aturan yang sama dengan kanal WhatsApp.
import { HttpError, newId, nowIso, parseJson, maskPhone, normalizePhone } from '../lib/util.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { readJson } from '../http/http.js';
import { performCardAction, revertEvent, requireRole, getCardByCode, getMembership, MANAGER_ROLES } from '../domain/actions.js';
import { createCard, audit, defaultColumns, rowToEvent, appendWorkspaceEvent } from '../domain/store.js';
import { runRetention } from '../jobs/retention.js';

export const CONSENT_VERSION = 'privasi-2026-11-07';
const ROLES = ['owner', 'coordinator', 'collaborator', 'viewer'];

export const DEFAULT_TRANSFERS = [
  { purpose: 'Hosting aplikasi dan basis data', country: 'Singapura', recipient: 'Penyedia VPS', data_categories: 'Semua data workspace (terenkripsi saat simpan)', instrument: 'Perjanjian pemrosesan data + klausul transfer' },
  { purpose: 'Pengiriman dan penerimaan pesan WhatsApp', country: 'Amerika Serikat / lokasi server Meta', recipient: 'Meta Platforms (WhatsApp Cloud API)', data_categories: 'Nomor WA, isi pesan, lampiran', instrument: 'Ketentuan pemrosesan data WhatsApp Business' },
  { purpose: 'Onboarding dan penerusan webhook WhatsApp', country: 'Sesuai lokasi BSP', recipient: 'BSP lokal', data_categories: 'Nomor WA, isi pesan, metadata', instrument: 'Perjanjian pemrosesan data dengan BSP' },
];

export function registerRoutes(router, ctx) {
  const { db, crypto, cfg, auth, outbound } = ctx;

  const personView = (p) => (p ? { id: p.id, name: p.erased_at ? 'Mantan anggota' : p.name } : null);
  const client = (req) => (req.headers['x-kolab-client'] === 'pwa' ? 'pwa' : 'web');
  const need = (req) => { if (!req.person) throw new HttpError(401, 'Silakan masuk dulu', 'unauthenticated'); return req.person; };

  async function notifyAssignment(t, card, assigneeId) {
    if (!assigneeId) return;
    const p = await t.get('SELECT * FROM people WHERE id = ? AND erased_at IS NULL', [assigneeId]);
    const phone = p && crypto.decrypt(p.phone_enc);
    if (!phone) return;
    const url = `${cfg.baseUrl}/#/kartu/${card.code}`;
    await outbound.template(t, {
      phone, person_id: p.id, workspace_id: card.workspace_id, card_id: card.id,
      text: `Tugas baru ${card.code}: ${card.title}\nBalas pesan ini dengan "mulai" untuk mulai mengerjakan.\n${url}`,
      template: { name: cfg.wa.assignTemplate, components: [{ type: 'body', parameters: [{ type: 'text', text: card.code }, { type: 'text', text: card.title }, { type: 'text', text: url }] }] },
    });
  }

  async function cardView(t, card) {
    const assignee = card.assignee_id ? await t.get('SELECT id, name, erased_at FROM people WHERE id = ?', [card.assignee_id]) : null;
    return {
      id: card.id, code: card.code, board_id: card.board_id, workspace_id: card.workspace_id, title: card.title,
      description: card.description, assignee: personView(assignee), due_date: card.due_date, priority: card.priority,
      column_key: card.column_key, progress: Number(card.progress), hold_reason: card.hold_reason,
      needs_review: !!Number(card.needs_review), updated_at: card.updated_at,
    };
  }

  // ---------- Autentikasi ----------
  router.post('/api/auth/otp', async (req) => {
    const b = await readJson(req);
    await auth.requestOtp(b.phone, 'login');
    return { ok: true, message: 'Jika nomor terdaftar, kode dikirim lewat WhatsApp.' };
  });

  router.post('/api/auth/login', async (req) => {
    const b = await readJson(req);
    const { phoneHash } = await auth.verifyOtp(b.phone, b.code, 'login');
    const person = await db.get('SELECT * FROM people WHERE phone_hash = ? AND verified_at IS NOT NULL AND erased_at IS NULL', [phoneHash]);
    if (!person) throw new HttpError(400, 'Kode salah atau kedaluwarsa');
    const token = await auth.createSession(person.id);
    await audit(db, { actor_id: person.id, action: 'auth.login', ip: req.ip, detail: { client: client(req) } });
    return { status: 200, headers: { 'set-cookie': auth.cookieHeader(token) }, body: { ok: true, person: personView(person) } };
  });

  router.post('/api/auth/logout', async (req) => {
    await auth.destroySession(req.sessionToken);
    return { status: 200, headers: { 'set-cookie': auth.cookieHeader('', 0) }, body: { ok: true } };
  });

  router.get('/api/me', async (req) => {
    const p = need(req);
    const memberships = await db.all(
      `SELECT m.workspace_id, m.role, m.availability, m.wip_limit, m.skills, w.name AS workspace_name, w.retention_days
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.person_id = ? AND m.removed_at IS NULL ORDER BY w.name`, [p.id]);
    return { person: { ...personView(p), phone: maskPhone(crypto.decrypt(p.phone_enc)) }, memberships, wa_mode: cfg.wa.mode };
  });

  // ---------- Undangan dan verifikasi nomor ----------
  router.post('/api/workspaces/:id/invites', async (req, { id }) => {
    const p = need(req);
    const m = await requireRole(db, id, p.id, ['owner', 'coordinator']);
    const b = await readJson(req);
    const role = b.role || 'collaborator';
    if (!ROLES.includes(role) || role === 'owner') throw new HttpError(400, 'Peran undangan tidak valid');
    if (role === 'coordinator' && m.role !== 'owner') throw new HttpError(403, 'Hanya pemilik yang dapat mengundang koordinator');
    const token = randomToken(24);
    await db.run('INSERT INTO invites (token_hash, workspace_id, role, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [sha256Hex(token), id, role, p.id, new Date(Date.now() + 7 * 86_400_000).toISOString(), nowIso()]);
    await audit(db, { workspace_id: id, actor_id: p.id, action: 'invite.created', detail: { role }, ip: req.ip });
    return { token, url: `${cfg.baseUrl}/#/gabung/${token}`, expires_in_days: 7, role };
  });

  async function loadInvite(token) {
    const inv = await db.get('SELECT i.*, w.name AS workspace_name FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE token_hash = ?', [sha256Hex(token)]);
    if (!inv || inv.used_at || inv.expires_at < nowIso()) throw new HttpError(404, 'Undangan tidak berlaku atau sudah dipakai');
    return inv;
  }

  router.get('/api/join/:token', async (req, { token }) => {
    const inv = await loadInvite(token);
    return { workspace_name: inv.workspace_name, role: inv.role, consent_version: CONSENT_VERSION, transfers: DEFAULT_TRANSFERS.map((x) => ({ country: x.country, recipient: x.recipient, purpose: x.purpose })) };
  });

  router.post('/api/join/:token/otp', async (req, { token }) => {
    await loadInvite(token);
    const b = await readJson(req);
    await auth.requestOtp(b.phone, 'join');
    return { ok: true, message: 'Kode verifikasi dikirim ke WhatsApp Anda.' };
  });

  router.post('/api/join/:token', async (req, { token }) => {
    const inv = await loadInvite(token);
    const b = await readJson(req);
    if (b.consent !== true) throw new HttpError(400, 'Persetujuan pemrosesan data wajib dicentang untuk bergabung');
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Nama wajib diisi');
    const { phone, phoneHash } = await auth.verifyOtp(b.phone, b.code, 'join');
    const person = await db.tx(async (t) => {
      const ts = nowIso();
      // Klaim undangan secara atomik sebelum memberi keanggotaan: satu undangan = satu orang.
      const claimed = await t.run('UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', [ts, inv.token_hash, ts]);
      if (claimed.changes === 0) throw new HttpError(404, 'Undangan tidak berlaku atau sudah dipakai');
      let p = await t.get('SELECT * FROM people WHERE phone_hash = ?', [phoneHash]);
      if (!p) {
        const id = newId();
        await t.run('INSERT INTO people (id, name, phone_enc, phone_hash, verified_at, consent_at, consent_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, name, crypto.encrypt(phone), phoneHash, ts, ts, CONSENT_VERSION, ts]);
        p = await t.get('SELECT * FROM people WHERE id = ?', [id]);
      } else {
        await t.run('UPDATE people SET verified_at = COALESCE(verified_at, ?), consent_at = ?, consent_version = ? WHERE id = ?', [ts, ts, CONSENT_VERSION, p.id]);
      }
      const existing = await t.get('SELECT * FROM memberships WHERE workspace_id = ? AND person_id = ?', [inv.workspace_id, p.id]);
      // Anggota aktif mempertahankan perannya (undangan tidak boleh menurunkan pemilik); hanya anggota yang pernah keluar diaktifkan lagi.
      if (existing && !existing.removed_at) { /* peran tetap */ }
      else if (existing) await t.run('UPDATE memberships SET role = ?, removed_at = NULL WHERE workspace_id = ? AND person_id = ?', [inv.role, inv.workspace_id, p.id]);
      else await t.run('INSERT INTO memberships (workspace_id, person_id, role, wip_limit, created_at) VALUES (?, ?, ?, ?, ?)', [inv.workspace_id, p.id, inv.role, cfg.defaultWipLimit, ts]);
      await appendWorkspaceEvent(t, inv.workspace_id, { type: 'member.joined', source: client(req), actor_id: p.id, payload: { role: inv.role, consent_version: CONSENT_VERSION } });
      await audit(t, { workspace_id: inv.workspace_id, actor_id: p.id, action: 'member.joined', detail: { role: inv.role, consent_version: CONSENT_VERSION }, ip: req.ip });
      return p;
    });
    const sess = await auth.createSession(person.id);
    return { status: 200, headers: { 'set-cookie': auth.cookieHeader(sess) }, body: { ok: true, workspace_id: inv.workspace_id } };
  });

  // ---------- Workspace ----------
  router.post('/api/workspaces', async (req) => {
    const p = need(req);
    const b = await readJson(req);
    const name = String(b.name || '').trim();
    if (!name) throw new HttpError(400, 'Nama workspace wajib diisi');
    const id = newId();
    await db.tx(async (t) => {
      await t.run('INSERT INTO workspaces (id, name, retention_days, created_at) VALUES (?, ?, ?, ?)', [id, name.slice(0, 100), cfg.retention.defaultDays, nowIso()]);
      await t.run('INSERT INTO memberships (workspace_id, person_id, role, wip_limit, created_at) VALUES (?, ?, ?, ?, ?)', [id, p.id, 'owner', cfg.defaultWipLimit, nowIso()]);
      for (const x of DEFAULT_TRANSFERS) {
        await t.run('INSERT INTO data_transfers (id, workspace_id, purpose, country, recipient, data_categories, instrument, next_review, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [newId(), id, x.purpose, x.country, x.recipient, x.data_categories, x.instrument, new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10), nowIso()]);
      }
      await audit(t, { workspace_id: id, actor_id: p.id, action: 'workspace.created', detail: { name }, ip: req.ip });
    });
    return { id };
  });

  router.patch('/api/workspaces/:id', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner']);
    const b = await readJson(req);
    const ws = await db.get('SELECT * FROM workspaces WHERE id = ?', [id]);
    const changes = {};
    if (b.retention_days !== undefined) {
      const d = Number(b.retention_days);
      if (!Number.isInteger(d) || d < cfg.retention.minDays || d > cfg.retention.maxDays) throw new HttpError(400, `Retensi harus ${cfg.retention.minDays}–${cfg.retention.maxDays} hari`);
      changes.retention_days = [ws.retention_days, d];
      await db.run('UPDATE workspaces SET retention_days = ? WHERE id = ?', [d, id]);
    }
    if (b.name !== undefined && String(b.name).trim()) {
      changes.name = [ws.name, String(b.name).trim()];
      await db.run('UPDATE workspaces SET name = ? WHERE id = ?', [String(b.name).trim().slice(0, 100), id]);
    }
    await audit(db, { workspace_id: id, actor_id: p.id, action: 'workspace.updated', detail: changes, ip: req.ip });
    return { ok: true };
  });

  router.get('/api/workspaces/:id/members', async (req, { id }) => {
    const p = need(req);
    const me = await requireRole(db, id, p.id);
    const rows = await db.all(
      `SELECT p.id, p.name, p.erased_at, p.phone_enc, m.role, m.availability, m.wip_limit, m.skills,
         (SELECT COUNT(*) FROM cards c WHERE c.workspace_id = m.workspace_id AND c.assignee_id = p.id AND c.column_key = 'dikerjakan' AND c.deleted_at IS NULL) AS wip
       FROM memberships m JOIN people p ON p.id = m.person_id WHERE m.workspace_id = ? AND m.removed_at IS NULL ORDER BY p.name`, [id]);
    return rows.map((r) => ({
      ...personView(r), role: r.role, availability: r.availability, wip_limit: Number(r.wip_limit), wip: Number(r.wip), skills: r.skills,
      phone: MANAGER_ROLES.has(me.role) ? maskPhone(crypto.decrypt(r.phone_enc)) : undefined,
    }));
  });

  router.patch('/api/workspaces/:id/members/:pid', async (req, { id, pid }) => {
    const p = need(req);
    const me = await requireRole(db, id, p.id);
    const target = await getMembership(db, id, pid);
    if (!target) throw new HttpError(404, 'Anggota tidak ditemukan');
    const b = await readJson(req);
    const self = pid === p.id;
    const sets = [];
    const params = [];
    if (b.availability !== undefined) {
      if (!self && !MANAGER_ROLES.has(me.role)) throw new HttpError(403, 'Tidak diizinkan');
      if (!['tersedia', 'sibuk', 'cuti'].includes(b.availability)) throw new HttpError(400, 'Status tidak dikenal');
      sets.push('availability = ?'); params.push(b.availability);
    }
    if (b.skills !== undefined) { if (!self && !MANAGER_ROLES.has(me.role)) throw new HttpError(403, 'Tidak diizinkan'); sets.push('skills = ?'); params.push(String(b.skills).slice(0, 300)); }
    if (b.wip_limit !== undefined) {
      if (!MANAGER_ROLES.has(me.role)) throw new HttpError(403, 'Hanya koordinator yang mengatur batas WIP');
      const w = Number(b.wip_limit); if (!Number.isInteger(w) || w < 1 || w > 20) throw new HttpError(400, 'Batas WIP 1–20');
      sets.push('wip_limit = ?'); params.push(w);
    }
    if (b.role !== undefined) {
      if (me.role !== 'owner') throw new HttpError(403, 'Hanya pemilik yang dapat mengubah peran');
      if (!ROLES.includes(b.role)) throw new HttpError(400, 'Peran tidak dikenal');
      if (self && b.role !== 'owner') throw new HttpError(400, 'Pemilik tidak dapat menurunkan perannya sendiri');
      sets.push('role = ?'); params.push(b.role);
    }
    if (!sets.length) throw new HttpError(400, 'Tidak ada perubahan');
    await db.run(`UPDATE memberships SET ${sets.join(', ')} WHERE workspace_id = ? AND person_id = ?`, [...params, id, pid]);
    await audit(db, { workspace_id: id, actor_id: p.id, action: 'member.updated', target: pid, detail: b, ip: req.ip });
    return { ok: true };
  });

  router.delete('/api/workspaces/:id/members/:pid', async (req, { id, pid }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner']);
    if (pid === p.id) throw new HttpError(400, 'Pemilik tidak dapat mengeluarkan dirinya sendiri');
    await db.run('UPDATE memberships SET removed_at = ? WHERE workspace_id = ? AND person_id = ?', [nowIso(), id, pid]);
    await audit(db, { workspace_id: id, actor_id: p.id, action: 'member.removed', target: pid, ip: req.ip });
    return { ok: true };
  });

  router.get('/api/workspaces/:id/transfers', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner', 'coordinator']);
    return db.all('SELECT * FROM data_transfers WHERE workspace_id = ? ORDER BY created_at', [id]);
  });

  router.post('/api/workspaces/:id/transfers', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner']);
    const b = await readJson(req);
    for (const k of ['purpose', 'country', 'recipient', 'data_categories', 'instrument']) if (!String(b[k] || '').trim()) throw new HttpError(400, `${k} wajib diisi`);
    const tid = newId();
    await db.run('INSERT INTO data_transfers (id, workspace_id, purpose, country, recipient, data_categories, instrument, next_review, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tid, id, b.purpose, b.country, b.recipient, b.data_categories, b.instrument, b.next_review || null, nowIso()]);
    await audit(db, { workspace_id: id, actor_id: p.id, action: 'transfer.registered', target: tid, detail: b, ip: req.ip });
    return { id: tid };
  });

  router.get('/api/workspaces/:id/audit', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner']);
    return (await db.all('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY seq DESC LIMIT 200', [id])).map((r) => ({ ...r, seq: Number(r.seq), detail: parseJson(r.detail, {}) }));
  });

  // ---------- Papan dan kartu ----------
  router.get('/api/workspaces/:id/boards', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id);
    return (await db.all('SELECT id, name, prefix, closed_at FROM boards WHERE workspace_id = ? ORDER BY prefix', [id]));
  });

  router.post('/api/workspaces/:id/boards', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner', 'coordinator']);
    const b = await readJson(req);
    const prefix = String(b.prefix || '').trim().toUpperCase();
    if (!/^[A-Z]{2,6}$/.test(prefix)) throw new HttpError(400, 'Kode proyek 2–6 huruf, mis. DIS');
    if (!String(b.name || '').trim()) throw new HttpError(400, 'Nama proyek wajib diisi');
    if (await db.get('SELECT 1 FROM boards WHERE prefix = ?', [prefix])) throw new HttpError(409, `Kode ${prefix} sudah dipakai proyek lain`);
    const bid = newId();
    await db.run('INSERT INTO boards (id, workspace_id, name, prefix, columns, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [bid, id, String(b.name).trim().slice(0, 100), prefix, JSON.stringify(defaultColumns()), nowIso()]);
    await audit(db, { workspace_id: id, actor_id: p.id, action: 'board.created', target: bid, detail: { prefix }, ip: req.ip });
    return { id: bid, prefix };
  });

  router.get('/api/boards/:id', async (req, { id }) => {
    const p = need(req);
    const board = await db.get('SELECT * FROM boards WHERE id = ?', [id]);
    if (!board) throw new HttpError(404, 'Proyek tidak ditemukan');
    const me = await requireRole(db, board.workspace_id, p.id);
    const cards = await db.all('SELECT * FROM cards WHERE board_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC', [id]);
    const views = [];
    for (const c of cards) views.push(await cardView(db, c));
    return { board: { id: board.id, name: board.name, prefix: board.prefix, workspace_id: board.workspace_id, columns: parseJson(board.columns, defaultColumns()) }, cards: views, my_role: me.role };
  });

  router.post('/api/boards/:id/cards', async (req, { id }) => {
    const p = need(req);
    const board = await db.get('SELECT * FROM boards WHERE id = ? AND closed_at IS NULL', [id]);
    if (!board) throw new HttpError(404, 'Proyek tidak ditemukan');
    await requireRole(db, board.workspace_id, p.id, ['owner', 'coordinator']);
    const b = await readJson(req);
    if (b.assignee_id) {
      const am = await getMembership(db, board.workspace_id, b.assignee_id);
      if (!am || am.role === 'viewer') throw new HttpError(400, 'Penanggung jawab harus anggota aktif');
    }
    const card = await db.tx(async (t) => {
      const { card } = await createCard(t, { board, title: b.title, description: b.description, assignee_id: b.assignee_id, due_date: b.due_date, priority: b.priority, actor_id: p.id, source: client(req) });
      await notifyAssignment(t, card, b.assignee_id);
      return card;
    });
    return cardView(db, await db.get('SELECT * FROM cards WHERE id = ?', [card.id]));
  });

  router.get('/api/cards/:code', async (req, { code }) => {
    const p = need(req);
    const card = await getCardByCode(db, code);
    if (!card) throw new HttpError(404, 'Kartu tidak ditemukan');
    const me = await requireRole(db, card.workspace_id, p.id);
    const evs = (await db.all('SELECT e.*, p.name AS actor_name, p.erased_at AS actor_erased FROM events e LEFT JOIN people p ON p.id = e.actor_id WHERE e.card_id = ? ORDER BY e.seq', [card.id])).map(rowToEvent);
    const reverted = new Set(evs.filter((e) => e.type === 'event.reverted').map((e) => e.payload.target_seq));
    return {
      card: await cardView(db, card), my_role: me.role,
      events: evs.map((e) => ({ seq: e.seq, type: e.type, source: e.source, actor: e.actor_id ? (e.actor_erased ? 'Mantan anggota' : e.actor_name) : 'Sistem', payload: e.payload, created_at: e.created_at, reverted: reverted.has(e.seq) })),
    };
  });

  router.post('/api/cards/:code/actions', async (req, { code }) => {
    const p = need(req);
    const b = await readJson(req);
    const card = await getCardByCode(db, code);
    if (!card) throw new HttpError(404, 'Kartu tidak ditemukan');
    await db.tx(async (t) => {
      const fresh = await t.get('SELECT * FROM cards WHERE id = ?', [card.id]);
      const { action, ...args } = b;
      await performCardAction(t, { card: fresh, actor: { person_id: p.id }, action, args, source: client(req) });
      if (action === 'tugaskan' && args.assignee_id && args.assignee_id !== fresh.assignee_id) await notifyAssignment(t, fresh, args.assignee_id);
    });
    return cardView(db, await db.get('SELECT * FROM cards WHERE id = ?', [card.id]));
  });

  router.post('/api/events/:seq/revert', async (req, { seq }) => {
    const p = need(req);
    const b = await readJson(req);
    await db.tx((t) => revertEvent(t, { seq: Number(seq), actor: { person_id: p.id }, reason: b.reason, source: client(req) }));
    return { ok: true };
  });

  router.get('/api/my/tasks', async (req) => {
    const p = need(req);
    const rows = await db.all(
      `SELECT c.* FROM cards c JOIN memberships m ON m.workspace_id = c.workspace_id AND m.person_id = ? AND m.removed_at IS NULL
       WHERE c.assignee_id = ? AND c.deleted_at IS NULL AND c.column_key <> 'selesai'
       ORDER BY CASE WHEN c.due_date IS NULL THEN 1 ELSE 0 END, c.due_date, c.code`, [p.id, p.id]);
    const out = [];
    for (const r of rows) out.push(await cardView(db, r));
    return out;
  });

  // ---------- Usulan dan tinjauan ----------
  router.get('/api/workspaces/:id/proposals', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner', 'coordinator']);
    const rows = await db.all(
      `SELECT pr.*, p.name AS person_name, b.prefix FROM proposals pr JOIN people p ON p.id = pr.person_id JOIN boards b ON b.id = pr.board_id
       WHERE pr.workspace_id = ? AND pr.status = 'baru' ORDER BY pr.created_at`, [id]);
    return rows;
  });

  router.post('/api/proposals/:id/:decision', async (req, { id, decision }) => {
    const p = need(req);
    if (!['accept', 'reject'].includes(decision)) throw new HttpError(404, 'Tidak ditemukan');
    const pr = await db.get("SELECT * FROM proposals WHERE id = ? AND status = 'baru'", [id]);
    if (!pr) throw new HttpError(404, 'Usulan tidak ditemukan atau sudah diputuskan');
    await requireRole(db, pr.workspace_id, p.id, ['owner', 'coordinator']);
    const b = await readJson(req);
    return db.tx(async (t) => {
      // Klaim keputusan secara atomik: hanya satu koordinator yang bisa memutuskan usulan ini.
      const claimed = await t.run("UPDATE proposals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'baru'",
        [decision === 'reject' ? 'ditolak' : 'diterima', p.id, nowIso(), id]);
      if (claimed.changes === 0) throw new HttpError(409, 'Usulan sudah diputuskan koordinator lain');
      const proposer = await t.get('SELECT * FROM people WHERE id = ?', [pr.person_id]);
      // Kabari pengusul hanya bila ia masih anggota aktif workspace ini.
      const phone = (await getMembership(t, pr.workspace_id, pr.person_id)) ? crypto.decrypt(proposer?.phone_enc) : null;
      if (decision === 'reject') {
        if (phone) await outbound.text(t, { phone, person_id: proposer.id, workspace_id: pr.workspace_id, text: `Usulan "${pr.title}" belum dijadikan kartu.${b.note ? ` Catatan: ${b.note}` : ''}` });
        return { ok: true };
      }
      const board = await t.get('SELECT * FROM boards WHERE id = ?', [pr.board_id]);
      let assignee = b.assignee_id === undefined ? pr.person_id : b.assignee_id;
      if (assignee) {
        const am = await getMembership(t, pr.workspace_id, assignee);
        if (!am || am.role === 'viewer') {
          if (b.assignee_id !== undefined) throw new HttpError(400, 'Penanggung jawab harus anggota aktif');
          assignee = null; // pengusul sudah keluar atau hanya pemantau → kartu dibuat tanpa penanggung jawab
        }
      }
      const { card } = await createCard(t, { board, title: b.title || pr.title, assignee_id: assignee, actor_id: p.id, source: client(req), extra: { from_proposal: pr.id, proposed_by: pr.person_id } });
      await t.run('UPDATE proposals SET card_id = ? WHERE id = ?', [card.id, id]);
      if (assignee) await notifyAssignment(t, card, assignee);
      else if (phone) await outbound.text(t, { phone, person_id: proposer.id, workspace_id: pr.workspace_id, card_id: card.id, text: `Usulan Anda dijadikan kartu ${card.code}.` });
      return { ok: true, code: card.code };
    });
  });

  router.get('/api/workspaces/:id/review', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner', 'coordinator']);
    const cards = await db.all('SELECT * FROM cards WHERE workspace_id = ? AND needs_review = 1 AND deleted_at IS NULL ORDER BY updated_at DESC', [id]);
    const cv = [];
    for (const c of cards) cv.push(await cardView(db, c));
    const msgs = await db.all(
      `SELECT meta_id, status, error, received_at, person_id, body_enc, content_purged_at FROM wa_messages
       WHERE status IN ('rejected','needs_review','failed')
         AND (workspace_id = ? OR (workspace_id IS NULL AND person_id IN (SELECT person_id FROM memberships WHERE workspace_id = ? AND removed_at IS NULL)))
       ORDER BY received_at DESC LIMIT 100`, [id, id]);
    // Pesan dari nomor asing tidak terkait workspace mana pun, jadi tidak ditampilkan ke pemilik workspace mana pun.
    return {
      cards: cv,
      messages: msgs.map((m) => ({ meta_id: m.meta_id, status: m.status, error: m.error, received_at: m.received_at, text: m.content_purged_at ? '[isi dihapus sesuai retensi]' : crypto.decrypt(m.body_enc) })),
    };
  });

  // ---------- Hak subjek data ----------
  router.get('/api/me/export', async (req) => {
    const p = need(req);
    const memberships = await db.all('SELECT workspace_id, role, availability, skills, created_at, removed_at FROM memberships WHERE person_id = ?', [p.id]);
    const events = (await db.all('SELECT seq, workspace_id, card_id, type, source, payload, created_at FROM events WHERE actor_id = ? ORDER BY seq', [p.id])).map(rowToEvent);
    const messages = (await db.all('SELECT meta_id, msg_type, body_enc, status, received_at, content_purged_at FROM wa_messages WHERE person_id = ? ORDER BY received_at', [p.id]))
      .map((m) => ({ meta_id: m.meta_id, type: m.msg_type, status: m.status, received_at: m.received_at, text: m.content_purged_at ? null : crypto.decrypt(m.body_enc) }));
    await audit(db, { actor_id: p.id, action: 'person.exported', ip: req.ip });
    return {
      status: 200,
      headers: { 'content-disposition': 'attachment; filename="data-saya-kolab-hub.json"' },
      body: { exported_at: nowIso(), person: { name: p.name, phone: crypto.decrypt(p.phone_enc), consent_at: p.consent_at, consent_version: p.consent_version }, memberships, events, wa_messages: messages },
    };
  });

  router.delete('/api/me', async (req) => {
    const p = need(req);
    await db.tx(async (t) => {
      const ts = nowIso();
      const owned = await t.all("SELECT workspace_id FROM memberships WHERE person_id = ? AND role = 'owner' AND removed_at IS NULL", [p.id]);
      for (const o of owned) {
        const other = await t.get("SELECT 1 FROM memberships WHERE workspace_id = ? AND role = 'owner' AND person_id <> ? AND removed_at IS NULL", [o.workspace_id, p.id]);
        if (!other) throw new HttpError(409, 'Serahkan peran pemilik ke anggota lain sebelum menghapus akun');
      }
      await t.run('UPDATE wa_messages SET body_enc = NULL, media = NULL, content_purged_at = ? WHERE phone_hash = ? AND content_purged_at IS NULL', [ts, p.phone_hash]);
      await t.run('UPDATE wa_outbox SET body_enc = NULL, to_enc = NULL, template = NULL, content_purged_at = ? WHERE phone_hash = ?', [ts, p.phone_hash]);
      await t.run("UPDATE people SET name = 'Mantan anggota', phone_enc = NULL, phone_hash = NULL, erased_at = ? WHERE id = ?", [ts, p.id]);
      await t.run('UPDATE memberships SET removed_at = ? WHERE person_id = ? AND removed_at IS NULL', [ts, p.id]);
      await t.run('DELETE FROM sessions WHERE person_id = ?', [p.id]);
      await audit(t, { actor_id: p.id, action: 'person.erased', ip: req.ip });
    });
    return { status: 200, headers: { 'set-cookie': auth.cookieHeader('', 0) }, body: { ok: true } };
  });

  // ---------- Operasional ----------
  router.post('/api/workspaces/:id/retention/run', async (req, { id }) => {
    const p = need(req);
    await requireRole(db, id, p.id, ['owner']);
    const r = await runRetention(ctx);
    await audit(db, { workspace_id: id, actor_id: p.id, action: 'retention.manual_run', detail: r, ip: req.ip });
    return r;
  });

  // ---------- Simulasi WA (hanya WA_MODE=simulate) ----------
  if (cfg.wa.mode === 'simulate') {
    router.post('/api/sim/inbound', async (req) => {
      const b = await readJson(req);
      const phone = normalizePhone(b.phone);
      if (!phone) throw new HttpError(400, 'Nomor tidak valid');
      const metaId = `wamid.SIM${newId()}`;
      const msg = { from: phone, id: metaId, timestamp: String(Math.floor(Date.now() / 1000)) };
      if (b.media_type) Object.assign(msg, { type: b.media_type, [b.media_type]: { id: `media.${newId()}`, mime_type: b.media_type === 'image' ? 'image/jpeg' : 'application/pdf', caption: b.text || '' } });
      else Object.assign(msg, { type: 'text', text: { body: String(b.text || '') } });
      if (b.context_id) msg.context = { id: b.context_id };
      const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'SIM', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'SIM' }, contacts: [{ wa_id: phone }], messages: [msg] } }] }] }));
      const { hmacHex } = await import('../lib/crypto.js');
      const r = await ctx.webhook.receive(raw, `sha256=${hmacHex(cfg.wa.appSecret, raw)}`);
      if (cfg.workerInline) await ctx.worker.drain();
      return { meta_id: metaId, webhook_status: r.status };
    });

    router.get('/api/sim/outbox', async () => {
      const rows = await db.all('SELECT * FROM wa_outbox ORDER BY created_at DESC LIMIT 100');
      return rows.map((r) => ({ id: r.id, provider_id: r.provider_id, to: crypto.decrypt(r.to_enc), kind: r.kind, status: r.status, card_id: r.card_id, text: r.content_purged_at ? '[dihapus]' : crypto.decrypt(r.body_enc), created_at: r.created_at }));
    });
  }
}
