// Ringkasan harian: satu pesan per orang per hari, bukan notifikasi per kejadian.
// Kanal: push bila berlangganan; selain itu template WA (di luar jendela 24 jam wajib template).
// Orang tanpa tugas aktif dan tanpa antrean tinjauan tidak dikirimi apa pun.

const LAST_DAY_KEY = 'digest.last_day';

/** Tanggal (YYYY-MM-DD) dan jam (HH:MM) lokal di zona `tz`. */
export function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

export function makeDigest(ctx) {
  const { cfg, crypto, push, outbound, queue } = ctx;

  async function compose(t, personId, day) {
    const tasks = await t.all(
      `SELECT c.code, c.title, c.column_key, c.due_date, c.progress FROM cards c
       JOIN memberships m ON m.workspace_id = c.workspace_id AND m.person_id = ? AND m.removed_at IS NULL
       WHERE c.assignee_id = ? AND c.deleted_at IS NULL AND c.column_key <> 'selesai'
       ORDER BY CASE WHEN c.due_date IS NULL THEN 1 ELSE 0 END, c.due_date, c.code`, [personId, personId]);
    const managed = await t.all("SELECT workspace_id FROM memberships WHERE person_id = ? AND removed_at IS NULL AND role IN ('owner','coordinator')", [personId]);
    const wsIds = managed.map((m) => m.workspace_id);
    let review = 0; let flagged = 0; let proposals = 0;
    if (wsIds.length) {
      const ph = wsIds.map(() => '?').join(',');
      review = Number((await t.get(`SELECT COUNT(*) AS n FROM cards WHERE workspace_id IN (${ph}) AND column_key = 'ditinjau' AND deleted_at IS NULL`, wsIds)).n);
      flagged = Number((await t.get(`SELECT COUNT(*) AS n FROM cards WHERE workspace_id IN (${ph}) AND needs_review = 1 AND deleted_at IS NULL`, wsIds)).n);
      proposals = Number((await t.get(`SELECT COUNT(*) AS n FROM proposals WHERE workspace_id IN (${ph}) AND status = 'baru'`, wsIds)).n);
    }
    const overdue = tasks.filter((x) => x.due_date && x.due_date < day);
    const dueToday = tasks.filter((x) => x.due_date === day);
    const held = tasks.filter((x) => x.column_key === 'tertahan');
    if (!tasks.length && !review && !flagged && !proposals) return null;

    const parts = [];
    if (tasks.length) parts.push(`${tasks.length} tugas aktif`);
    if (overdue.length) parts.push(`${overdue.length} terlambat`);
    if (dueToday.length) parts.push(`${dueToday.length} tenggat hari ini`);
    if (held.length) parts.push(`${held.length} tertahan`);
    if (review) parts.push(`${review} menunggu tinjauan`);
    if (flagged) parts.push(`${flagged} perlu dicek`);
    if (proposals) parts.push(`${proposals} usulan baru`);
    const summary = parts.join(', ');

    const label = { masuk: 'Masuk', dikerjakan: 'Dikerjakan', ditinjau: 'Ditinjau', tertahan: 'Tertahan' };
    const top = [...overdue, ...dueToday, ...tasks.filter((x) => !overdue.includes(x) && !dueToday.includes(x))].slice(0, 8);
    const lines = top.map((x) => {
      const tag = x.due_date && x.due_date < day ? ' ⚠️terlambat' : x.due_date === day ? ' ⏰hari ini' : '';
      return `• ${x.code} ${oneLine(x.title)} — ${label[x.column_key] || x.column_key}${x.progress ? ` ${x.progress}%` : ''}${tag}`;
    });
    const more = tasks.length > top.length ? `\n…dan ${tasks.length - top.length} lainnya` : '';
    const text = `Ringkasan ${day}: ${summary}.${lines.length ? `\n${lines.join('\n')}${more}` : ''}\n${cfg.baseUrl}/#/tugasku`;
    return { summary, text, counts: { tasks: tasks.length, overdue: overdue.length, due_today: dueToday.length, held: held.length, review, flagged, proposals } };
  }

  const api = {
    compose,

    /** Dipanggil worker tiap putaran. Menjadwalkan satu `digest.run` per hari setelah DIGEST_TIME lokal. */
    async maybeSchedule(nowMs = Date.now()) {
      if (!cfg.digest.enabled) return false;
      const { day, hhmm } = localParts(nowMs, cfg.digest.tz);
      if (hhmm < cfg.digest.time) return false;
      const last = (await ctx.db.get('SELECT value FROM kv WHERE key = ?', [LAST_DAY_KEY]))?.value;
      if (!last) {
        // Pemasangan pertama: jangan kirim ringkasan di jam acak saat server baru diperbarui; mulai besok.
        await ctx.db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [LAST_DAY_KEY, day]);
        return false;
      }
      if (last >= day) return false;
      return queue.enqueue('digest.run', { day }, { dedupeKey: `digest-run:${day}` });
    },

    /** Antrekan satu `digest.send` per orang aktif. Kunci dedupe menjamin satu pesan per orang per hari. */
    async run({ day }) {
      const people = await ctx.db.all(
        `SELECT DISTINCT p.id FROM people p JOIN memberships m ON m.person_id = p.id AND m.removed_at IS NULL
         WHERE p.erased_at IS NULL AND p.digest_channel <> 'off'`);
      await ctx.db.tx(async (t) => {
        for (const p of people) await queue.enqueue('digest.send', { person_id: p.id, day }, { t, dedupeKey: `digest:${day}:${p.id}` });
        await t.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [LAST_DAY_KEY, day]);
      });
      return people.length;
    },

    /** Kirim ringkasan untuk satu orang. Mengembalikan kanal yang dipakai, atau null bila dilewati. */
    async send({ person_id, day }) {
      return ctx.db.tx(async (t) => {
        const p = await t.get('SELECT * FROM people WHERE id = ? AND erased_at IS NULL', [person_id]);
        if (!p || p.digest_channel === 'off') return null;
        const d = await compose(t, p.id, day);
        if (!d) return null;
        if (p.digest_channel !== 'wa') {
          const n = await push.notify(t, p.id, { title: `Ringkasan ${day}`, body: d.summary, url: '/#/tugasku', tag: `ringkasan-${day}` });
          if (n) return 'push';
          if (p.digest_channel === 'push') return null; // hanya push, tetapi belum ada perangkat
        }
        const phone = crypto.decrypt(p.phone_enc);
        if (!phone) return null;
        // Parameter template WA tidak boleh berisi baris baru; teks lengkap disimpan untuk simulasi/riwayat.
        await outbound.template(t, {
          phone, person_id: p.id, text: d.text,
          template: { name: cfg.digest.template, components: [{ type: 'body', parameters: [{ type: 'text', text: day }, { type: 'text', text: d.summary }, { type: 'text', text: `${cfg.baseUrl}/#/tugasku` }] }] },
        });
        return 'wa';
      });
    },
  };
  return api;
}
