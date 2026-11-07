// Kolab-Hub web + PWA (tanpa build). DOM dibangun dengan h() agar tidak ada innerHTML dari data pengguna.
const COLS = [['masuk', 'Masuk'], ['dikerjakan', 'Dikerjakan'], ['ditinjau', 'Ditinjau'], ['selesai', 'Selesai'], ['tertahan', 'Tertahan']];
const COL_NAME = Object.fromEntries(COLS);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const state = { me: null, ws: localStorage.getItem('kh.ws') || null, stream: null, rerender: null };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM diizinkan CSP; atribut style inline tidak
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-kolab-csrf': '1', 'x-kolab-client': isStandalone ? 'pwa' : 'web' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Sesi berakhir di server: buang salinan data pribadi agar tidak terbaca luring oleh pengguna berikutnya.
    await clearPrivateCache();
    if (!location.hash.startsWith('#/masuk') && !location.hash.startsWith('#/gabung')) { location.hash = '#/masuk'; throw new Error('Silakan masuk'); }
  }
  if (!res.ok) throw new Error(data.error || `Gagal (${res.status})`);
  return data;
}

const run = (fn) => async (e) => { e?.preventDefault?.(); try { await fn(e); } catch (err) { toast(err.message); } };
const role = () => state.me?.memberships.find((m) => m.workspace_id === state.ws)?.role;
const isManager = () => ['owner', 'coordinator'].includes(role());
const today = () => new Date().toISOString().slice(0, 10);

function nav() {
  const n = document.getElementById('nav');
  n.replaceChildren();
  if (!state.me) return;
  const links = [['#/tugasku', 'Tugas saya'], ['#/', 'Proyek']];
  if (isManager()) links.push([`#/tinjauan`, 'Tinjauan']);
  links.push(['#/akun', 'Akun']);
  for (const [href, label] of links) n.append(h('a', { href, class: location.hash === href || (href === '#/' && location.hash.startsWith('#/papan')) ? 'active' : '' }, label));
}

function connectStream() {
  if (state.stream || !state.me) return;
  const es = new EventSource('/api/stream');
  es.addEventListener('kolab', (e) => {
    let data = {};
    try { data = JSON.parse(e.data); } catch {}
    if (!eventConcernsView(data)) return;
    clearTimeout(connectStream.t);
    connectStream.t = setTimeout(softRefresh, 300);
  });
  es.onerror = () => {};
  state.stream = es;
}

/** Hanya event yang menyangkut tampilan saat ini yang memicu penyegaran. */
function eventConcernsView(data) {
  const [, route, arg] = (location.hash || '#/tugasku').split('/');
  if (route === 'kartu') return data.card?.code === decodeURIComponent(arg || '');
  if (route === 'papan') return data.card?.board_id === arg;
  if (route === 'akun' || route === 'masuk' || route === 'gabung') return false;
  return true; // tugasku, tinjauan, beranda: ringkasan lintas kartu
}

/** Isian yang sedang diketik tidak boleh hilang karena pembaruan dari orang lain. */
function hasDraft() {
  const a = document.activeElement;
  const typing = a && a.closest?.('#app') && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName);
  return state.dirty || typing;
}

function softRefresh() {
  if (!hasDraft()) { state.rerender?.(); return; }
  const bar = document.getElementById('updates');
  bar.hidden = false;
}

document.addEventListener('input', (e) => { if (e.target.closest?.('#app')) state.dirty = true; });
document.addEventListener('click', (e) => {
  if (e.target.id === 'updatesReload') { document.getElementById('updates').hidden = true; state.dirty = false; state.rerender?.(); }
});

/** Hapus salinan respons API pribadi dari cache service worker (cangkang aplikasi tetap). */
async function clearPrivateCache() {
  if (!('caches' in window)) return;
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const req of await cache.keys()) if (new URL(req.url).pathname.startsWith('/api/')) await cache.delete(req);
  }
}

async function endSession() {
  state.me = null; state.stream?.close(); state.stream = null;
  await clearPrivateCache();
}

// ---------- Tampilan ----------
function viewLogin(main) {
  let phone = '';
  const form = h('form', { class: 'panel stack narrow' },
    h('h1', {}, 'Masuk'),
    h('p', { class: 'muted' }, 'Kode verifikasi dikirim lewat WhatsApp ke nomor yang terdaftar.'),
    h('div', {}, h('label', { for: 'ph' }, 'Nomor WhatsApp'), h('input', { id: 'ph', name: 'phone', inputmode: 'tel', autocomplete: 'tel', placeholder: '0812…', required: true })),
    h('div', { id: 'codeBox', hidden: true }, h('label', { for: 'cd' }, 'Kode 6 digit'), h('input', { id: 'cd', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Kirim kode'));
  form.addEventListener('submit', run(async () => {
    const codeBox = form.querySelector('#codeBox');
    if (codeBox.hidden) {
      phone = form.phone.value;
      const r = await api('POST', '/api/auth/otp', { phone });
      toast(r.message); codeBox.hidden = false; form.querySelector('button').textContent = 'Masuk'; form.code.focus();
    } else {
      await api('POST', '/api/auth/login', { phone, code: form.code.value });
      await loadMe(); location.hash = '#/tugasku';
    }
  }));
  main.append(form);
}

async function viewJoin(main, token) {
  const info = await api('GET', `/api/join/${token}`);
  let otpSent = false;
  const form = h('form', { class: 'panel stack narrow' },
    h('h1', {}, `Bergabung: ${info.workspace_name}`),
    h('p', { class: 'muted' }, `Anda diundang sebagai ${info.role}. Nomor WhatsApp akan diverifikasi dengan kode sekali pakai.`),
    h('div', {}, h('label', { for: 'nm' }, 'Nama'), h('input', { id: 'nm', name: 'name', required: true, autocomplete: 'name' })),
    h('div', {}, h('label', { for: 'ph' }, 'Nomor WhatsApp'), h('input', { id: 'ph', name: 'phone', inputmode: 'tel', required: true })),
    h('div', { class: 'panel' },
      h('p', {}, h('b', {}, 'Pemberitahuan pemrosesan data')),
      h('p', { class: 'muted' }, 'Kami mencatat nama, nomor WhatsApp, dan pesan kerja Anda untuk mengelola tugas. Isi pesan mentah dihapus otomatis sesuai masa retensi workspace (bawaan 90 hari). Anda dapat melihat, mengekspor, dan meminta penghapusan data kapan saja.'),
      h('p', { class: 'muted' }, 'Data diproses di luar Indonesia:'),
      h('ul', { class: 'muted' }, info.transfers.map((t) => h('li', {}, `${t.recipient} (${t.country}) — ${t.purpose}`))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'consent' }), `Saya setuju (versi ${info.consent_version}).`)),
    h('div', { id: 'codeBox', hidden: true }, h('label', { for: 'cd' }, 'Kode 6 digit'), h('input', { id: 'cd', name: 'code', inputmode: 'numeric', maxlength: 6 })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Kirim kode verifikasi'));
  form.addEventListener('submit', run(async () => {
    if (!otpSent) {
      if (!form.consent.checked) throw new Error('Centang persetujuan dulu');
      await api('POST', `/api/join/${token}/otp`, { phone: form.phone.value });
      otpSent = true; form.querySelector('#codeBox').hidden = false; form.querySelector('button').textContent = 'Verifikasi dan bergabung';
      toast('Kode dikirim ke WhatsApp');
    } else {
      const r = await api('POST', `/api/join/${token}`, { name: form.name.value, phone: form.phone.value, code: form.code.value, consent: form.consent.checked });
      state.ws = r.workspace_id; localStorage.setItem('kh.ws', r.workspace_id);
      await loadMe(); location.hash = '#/tugasku';
    }
  }));
  main.append(form);
}

function cardTile(c, { draggable = false } = {}) {
  const late = c.due_date && c.due_date < today() && c.column_key !== 'selesai';
  const el = h('a', { class: 'card', href: `#/kartu/${c.code}`, draggable: draggable ? 'true' : false, 'data-code': c.code },
    h('div', { class: 'code' }, c.code),
    h('div', { class: 'title' }, c.title),
    h('div', { class: 'meta' },
      c.assignee ? h('span', {}, `👤 ${c.assignee.name}`) : h('span', {}, 'Belum ditugaskan'),
      c.due_date ? h('span', { class: `tag ${late ? 'late' : ''}` }, `${late ? 'Terlambat · ' : ''}${c.due_date}`) : null,
      c.priority !== 'normal' ? h('span', { class: `tag ${c.priority}` }, c.priority) : null,
      c.needs_review ? h('span', { class: 'tag review' }, 'perlu dicek') : null,
      c.hold_reason ? h('span', { class: 'tag' }, `⏸ ${c.hold_reason}`) : null),
    c.progress ? h('div', { class: 'progress', 'aria-label': `progres ${c.progress}%` }, h('span', { style: `width:${c.progress}%` })) : null);
  if (draggable) el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', c.code));
  return el;
}

async function quick(code, action) {
  const args = { action };
  if (action === 'progres') { const p = prompt('Progres berapa persen? (0–100)'); if (p === null) return; args.percent = Number(p); args.note = prompt('Catatan singkat (opsional)') || ''; }
  if (action === 'selesai') args.note = prompt('Catatan hasil (opsional)') || '';
  if (action === 'bantuan') { const n = prompt('Bantuan apa yang dibutuhkan?'); if (n === null) return; args.note = n; }
  if (action === 'tahan') { const r = prompt('Alasan menahan kartu?'); if (!r) return; args.reason = r; }
  if (action === 'revisi') { const r = prompt('Catatan revisi?'); if (!r) return; args.note = r; }
  await api('POST', `/api/cards/${code}/actions`, args);
  toast(`${code} diperbarui`);
}

async function viewMyTasks(main) {
  const tasks = await api('GET', '/api/my/tasks');
  main.append(h('h1', {}, 'Tugas saya'));
  if (!isStandalone && /iphone|ipad/i.test(navigator.userAgent)) main.append(h('p', { class: 'muted' }, 'Tip iPhone: Bagikan → Tambah ke Layar Utama agar Kolab-Hub bisa dipakai seperti aplikasi.'));
  if (!tasks.length) { main.append(h('p', { class: 'panel' }, 'Tidak ada tugas aktif. 👍')); return; }
  for (const c of tasks) {
    const box = h('div', { class: 'panel', style: 'margin-bottom:12px' }, cardTile(c),
      h('div', { class: 'shortcuts' },
        h('button', { class: 'btn', onclick: run(async () => { await quick(c.code, c.column_key === 'tertahan' ? 'mulai' : 'mulai'); state.rerender(); }), disabled: c.column_key === 'dikerjakan' || c.column_key === 'ditinjau' }, h('b', {}, '▶'), 'Mulai'),
        h('button', { class: 'btn', onclick: run(async () => { await quick(c.code, 'progres'); state.rerender(); }), disabled: c.column_key === 'ditinjau' }, h('b', {}, '📈'), 'Lapor'),
        h('button', { class: 'btn', onclick: run(async () => { await quick(c.code, 'selesai'); state.rerender(); }), disabled: c.column_key === 'ditinjau' }, h('b', {}, '✅'), 'Selesai'),
        h('button', { class: 'btn', onclick: run(async () => { await quick(c.code, 'bantuan'); state.rerender(); }) }, h('b', {}, '🆘'), 'Bantuan')));
    main.append(box);
  }
}

async function viewHome(main) {
  const ms = state.me.memberships;
  if (!ms.length) {
    const f = h('form', { class: 'panel stack narrow' }, h('h1', {}, 'Buat workspace'), h('input', { name: 'name', placeholder: 'Nama tim/instansi', required: true }), h('button', { class: 'btn primary' }, 'Buat'));
    f.addEventListener('submit', run(async () => { const r = await api('POST', '/api/workspaces', { name: f.name.value }); state.ws = r.id; localStorage.setItem('kh.ws', r.id); await loadMe(); state.rerender(); }));
    main.append(f); return;
  }
  if (!ms.some((m) => m.workspace_id === state.ws)) { state.ws = ms[0].workspace_id; localStorage.setItem('kh.ws', state.ws); }
  const sel = h('select', { 'aria-label': 'Workspace', onchange: (e) => { state.ws = e.target.value; localStorage.setItem('kh.ws', state.ws); state.rerender(); } },
    ms.map((m) => h('option', { value: m.workspace_id, selected: m.workspace_id === state.ws }, `${m.workspace_name} (${m.role})`)));
  main.append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Proyek'), ms.length > 1 ? sel : null));
  const boards = await api('GET', `/api/workspaces/${state.ws}/boards`);
  const list = h('div', { class: 'grid2' }, boards.map((b) => h('a', { class: 'card', href: `#/papan/${b.id}` }, h('div', { class: 'code' }, b.prefix), h('div', { class: 'title' }, b.name))));
  main.append(boards.length ? list : h('p', { class: 'muted' }, 'Belum ada proyek.'));
  if (isManager()) {
    const f = h('form', { class: 'panel row', style: 'margin-top:16px' },
      h('input', { name: 'name', placeholder: 'Nama proyek', required: true, class: 'grow', style: 'flex:2' }),
      h('input', { name: 'prefix', placeholder: 'Kode (mis. DIS)', required: true, maxlength: 6, style: 'flex:1' }),
      h('button', { class: 'btn primary' }, 'Tambah proyek'));
    f.addEventListener('submit', run(async () => { await api('POST', `/api/workspaces/${state.ws}/boards`, { name: f.name.value, prefix: f.prefix.value }); state.rerender(); }));
    main.append(f);
    await sectionMembers(main);
  }
}

async function sectionMembers(main) {
  const members = await api('GET', `/api/workspaces/${state.ws}/members`);
  main.append(h('h2', {}, 'Anggota'));
  const tbl = h('table', {}, h('thead', {}, h('tr', {}, ['Nama', 'Peran', 'Status', 'WIP', 'Nomor'].map((x) => h('th', {}, x)))),
    h('tbody', {}, members.map((m) => h('tr', {}, h('td', {}, m.name), h('td', {}, m.role), h('td', {}, m.availability), h('td', {}, `${m.wip}/${m.wip_limit}`), h('td', {}, m.phone || '')))));
  main.append(h('div', { class: 'panel' }, tbl));
  const f = h('form', { class: 'row', style: 'margin-top:12px' },
    h('select', { name: 'role', style: 'max-width:220px' }, h('option', { value: 'collaborator' }, 'Kolaborator'), role() === 'owner' ? h('option', { value: 'coordinator' }, 'Koordinator') : null, h('option', { value: 'viewer' }, 'Pemantau')),
    h('button', { class: 'btn' }, 'Buat tautan undangan'));
  const out = h('div', { class: 'muted', style: 'margin-top:8px; word-break: break-all' });
  f.addEventListener('submit', run(async () => {
    const r = await api('POST', `/api/workspaces/${state.ws}/invites`, { role: f.role.value });
    out.replaceChildren('Bagikan tautan ini (berlaku 7 hari, sekali pakai): ', h('a', { href: r.url }, r.url));
    try { await navigator.clipboard.writeText(r.url); toast('Tautan disalin'); } catch {}
  }));
  main.append(f, out);
}

async function viewBoard(main, id) {
  const { board, cards, my_role } = await api('GET', `/api/boards/${id}`);
  state.ws = board.workspace_id; localStorage.setItem('kh.ws', state.ws);
  const mgr = ['owner', 'coordinator'].includes(my_role);
  main.append(h('div', { class: 'row' }, h('h1', { class: 'grow' }, `${board.prefix} · ${board.name}`)));
  if (mgr) {
    const members = await api('GET', `/api/workspaces/${board.workspace_id}/members`);
    const f = h('form', { class: 'panel row', style: 'margin-bottom:12px' },
      h('input', { name: 'title', placeholder: 'Instruksi baru…', required: true, style: 'flex:3' }),
      h('select', { name: 'assignee', style: 'flex:1' }, h('option', { value: '' }, '— penanggung jawab —'), members.filter((m) => m.role !== 'viewer').map((m) => h('option', { value: m.id }, `${m.name} (${m.wip}/${m.wip_limit}, ${m.availability})`))),
      h('input', { name: 'due', type: 'date', style: 'flex:1' }),
      h('select', { name: 'priority', style: 'flex:1' }, ['normal', 'rendah', 'tinggi', 'mendesak'].map((p) => h('option', { value: p }, p))),
      h('button', { class: 'btn primary' }, 'Tambah kartu'));
    f.addEventListener('submit', run(async () => {
      const c = await api('POST', `/api/boards/${id}/cards`, { title: f.title.value, assignee_id: f.assignee.value || null, due_date: f.due.value || null, priority: f.priority.value });
      toast(`Kartu ${c.code} dibuat`); state.rerender();
    }));
    main.append(f);
  }
  const boardEl = h('div', { class: 'board' });
  for (const [key, name] of COLS) {
    const colCards = cards.filter((c) => c.column_key === key);
    const col = h('section', { class: 'column', 'aria-label': name }, h('h3', {}, h('span', {}, name), h('span', {}, colCards.length)), colCards.map((c) => cardTile(c, { draggable: mgr })));
    if (mgr) {
      col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
      col.addEventListener('dragleave', () => col.classList.remove('drop'));
      col.addEventListener('drop', run(async (e) => {
        col.classList.remove('drop');
        const code = e.dataTransfer.getData('text/plain');
        const card = cards.find((c) => c.code === code);
        if (!card || card.column_key === key) return;
        const args = { action: 'pindah', to: key };
        if (key === 'tertahan') { const r = prompt('Alasan menahan kartu?'); if (!r) return; args.reason = r; }
        await api('POST', `/api/cards/${code}/actions`, args);
        state.rerender();
      }));
    }
    boardEl.append(col);
  }
  main.append(boardEl);
}

const EVENT_LABEL = {
  'card.created': 'membuat kartu', 'card.assigned': 'menugaskan', 'card.edited': 'mengubah', 'card.started': 'mulai mengerjakan',
  'card.progress': 'melapor progres', 'card.done': 'menandai selesai', 'card.approved': 'menyetujui', 'card.revision': 'meminta revisi',
  'card.held': 'menahan', 'card.resumed': 'melanjutkan', 'card.moved': 'memindah', 'card.commented': 'berkomentar',
  'card.help_requested': 'meminta bantuan', 'card.review_cleared': 'menandai sudah dicek', 'card.deleted': 'menghapus', 'event.reverted': 'membatalkan event',
};

function eventDetail(e) {
  const p = e.payload || {};
  const bits = [];
  if (p.percent !== undefined) bits.push(`${p.percent}%`);
  if (p.to) bits.push(`→ ${COL_NAME[p.to]}`);
  for (const k of ['note', 'reason', 'text']) if (p[k]) bits.push(`“${p[k]}”`);
  if (p.fields) bits.push(Object.entries(p.fields).map(([k, v]) => `${k}: ${v}`).join(', '));
  if (p.attachments?.length) bits.push(`📎 ${p.attachments.length} lampiran`);
  if (p.target_seq) bits.push(`#${p.target_seq}`);
  return bits.join(' ');
}

async function viewCard(main, code) {
  const { card: c, events, my_role } = await api('GET', `/api/cards/${code}`);
  state.ws = c.workspace_id;
  const mgr = ['owner', 'coordinator'].includes(my_role);
  main.append(h('p', {}, h('a', { href: `#/papan/${c.board_id}` }, '← Papan')), h('div', { class: 'grid2' },
    h('div', { class: 'panel stack' },
      h('div', { class: 'code' }, c.code), h('h1', {}, c.title),
      c.description ? h('p', {}, c.description) : null,
      h('div', { class: 'meta' }, h('span', { class: 'tag' }, COL_NAME[c.column_key]), c.assignee ? h('span', {}, `👤 ${c.assignee.name}`) : null, c.due_date ? h('span', {}, `Tenggat ${c.due_date}`) : null, h('span', {}, `Prioritas ${c.priority}`), c.needs_review ? h('span', { class: 'tag review' }, 'perlu dicek') : null),
      h('div', { class: 'progress' }, h('span', { style: `width:${c.progress}%` })),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: run(async () => { await quick(code, 'mulai'); state.rerender(); }) }, 'Mulai'),
        h('button', { class: 'btn', onclick: run(async () => { await quick(code, 'progres'); state.rerender(); }) }, 'Lapor progres'),
        h('button', { class: 'btn', onclick: run(async () => { await quick(code, 'selesai'); state.rerender(); }) }, 'Selesai'),
        h('button', { class: 'btn', onclick: run(async () => { await quick(code, 'tahan'); state.rerender(); }) }, 'Tahan'),
        mgr && c.column_key === 'ditinjau' ? h('button', { class: 'btn primary', onclick: run(async () => { await quick(code, 'setujui'); state.rerender(); }) }, 'Setujui') : null,
        mgr && c.column_key === 'ditinjau' ? h('button', { class: 'btn', onclick: run(async () => { await quick(code, 'revisi'); state.rerender(); }) }, 'Minta revisi') : null,
        mgr && c.needs_review ? h('button', { class: 'btn', onclick: run(async () => { await quick(code, 'cek'); state.rerender(); }) }, 'Tandai sudah dicek') : null),
      (() => {
        const f = h('form', { class: 'row' }, h('input', { name: 'text', placeholder: 'Tulis komentar…', class: 'grow' }), h('button', { class: 'btn' }, 'Kirim'));
        f.addEventListener('submit', run(async () => { await api('POST', `/api/cards/${code}/actions`, { action: 'komentar', text: f.text.value }); state.rerender(); }));
        return f;
      })(),
      mgr ? await assignForm(c) : null,
      mgr ? editForm(c) : null),
    h('div', { class: 'panel' }, h('h2', { style: 'margin-top:0' }, 'Riwayat'), h('ul', { class: 'history' }, [...events].reverse().map((e) => h('li', { class: e.reverted ? 'reverted' : '' },
      h('div', { class: 'row' }, h('span', { class: `src ${e.source}` }, e.source), h('b', {}, e.actor), h('span', {}, EVENT_LABEL[e.type] || e.type), h('span', { class: 'muted grow' }, new Date(e.created_at).toLocaleString('id-ID')),
        mgr && !e.reverted && !['card.created', 'event.reverted'].includes(e.type) ? h('button', { class: 'btn small', title: 'Batalkan event ini (dicatat sebagai event baru)', onclick: run(async () => { const r = prompt('Alasan pembatalan?'); if (r === null) return; await api('POST', `/api/events/${e.seq}/revert`, { reason: r }); state.rerender(); }) }, 'Batalkan') : null),
      h('div', { class: 'muted' }, eventDetail(e))))))));
}

async function assignForm(c) {
  const members = await api('GET', `/api/workspaces/${c.workspace_id}/members`);
  const f = h('form', { class: 'row' }, h('label', { class: 'grow' }, 'Penanggung jawab'),
    h('select', { name: 'assignee', style: 'max-width:260px' }, h('option', { value: '' }, '— belum ditugaskan —'),
      members.filter((m) => m.role !== 'viewer').map((m) => h('option', { value: m.id, selected: c.assignee?.id === m.id }, `${m.name} (${m.wip}/${m.wip_limit}, ${m.availability})`))),
    h('button', { class: 'btn small' }, 'Tugaskan'));
  f.addEventListener('submit', run(async () => {
    await api('POST', `/api/cards/${c.code}/actions`, { action: 'tugaskan', assignee_id: f.assignee.value || null });
    toast('Penugasan tersimpan; notifikasi WA dikirim'); state.rerender();
  }));
  return f;
}

function editForm(c) {
  const f = h('form', { class: 'stack' }, h('h2', {}, 'Ubah kartu'),
    h('input', { name: 'title', value: c.title }), h('textarea', { name: 'description' }, c.description || ''),
    h('div', { class: 'row' }, h('input', { name: 'due', type: 'date', value: c.due_date || '', class: 'grow' }),
      h('select', { name: 'priority', class: 'grow' }, ['rendah', 'normal', 'tinggi', 'mendesak'].map((p) => h('option', { value: p, selected: p === c.priority }, p)))),
    h('button', { class: 'btn' }, 'Simpan perubahan'));
  f.addEventListener('submit', run(async () => {
    await api('POST', `/api/cards/${c.code}/actions`, { action: 'ubah', title: f.title.value, description: f.description.value, due_date: f.due.value || null, priority: f.priority.value });
    toast('Tersimpan'); state.rerender();
  }));
  return f;
}

async function viewReview(main) {
  main.append(h('h1', {}, 'Tinjauan'));
  const props = await api('GET', `/api/workspaces/${state.ws}/proposals`);
  main.append(h('h2', {}, `Usulan kartu dari WhatsApp (${props.length})`));
  main.append(h('div', { class: 'panel' }, props.length ? h('table', {}, h('tbody', {}, props.map((p) => h('tr', {},
    h('td', {}, h('b', {}, p.title), h('div', { class: 'muted' }, `${p.prefix} · oleh ${p.person_name}`)),
    h('td', {}, h('div', { class: 'row' },
      h('button', { class: 'btn small primary', onclick: run(async () => { const r = await api('POST', `/api/proposals/${p.id}/accept`, {}); toast(`Jadi kartu ${r.code}`); state.rerender(); }) }, 'Jadikan kartu'),
      h('button', { class: 'btn small', onclick: run(async () => { await api('POST', `/api/proposals/${p.id}/reject`, { note: prompt('Catatan untuk pengusul (opsional)') || '' }); state.rerender(); }) }, 'Tolak'))))))) : h('p', { class: 'muted' }, 'Tidak ada usulan.')));
  const rv = await api('GET', `/api/workspaces/${state.ws}/review`);
  main.append(h('h2', {}, `Kartu perlu dicek (${rv.cards.length})`), h('div', { class: 'grid2' }, rv.cards.map((c) => cardTile(c))));
  main.append(h('h2', {}, `Pesan WA bermasalah (${rv.messages.length})`), h('div', { class: 'panel' }, rv.messages.length ? h('table', {}, h('tbody', {}, rv.messages.map((m) => h('tr', {},
    h('td', {}, new Date(m.received_at).toLocaleString('id-ID')), h('td', {}, h('span', { class: 'tag' }, m.status)), h('td', {}, m.text || ''), h('td', { class: 'muted' }, m.error || ''))))) : h('p', { class: 'muted' }, 'Tidak ada.')));
}

async function viewAccount(main) {
  const me = state.me;
  main.append(h('h1', {}, 'Akun'), h('div', { class: 'panel stack' },
    h('p', {}, h('b', {}, me.person.name), ` · ${me.person.phone}`),
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: '/api/me/export', download: 'data-saya-kolab-hub.json' }, 'Ekspor data saya'),
      h('button', { class: 'btn', onclick: run(async () => { await api('POST', '/api/auth/logout'); await endSession(); location.hash = '#/masuk'; }) }, 'Keluar'),
      h('button', { class: 'btn danger', onclick: run(async () => { if (!confirm('Hapus akun dan nomor Anda? Riwayat kerja tetap ada atas nama "Mantan anggota".')) return; await api('DELETE', '/api/me'); await endSession(); location.hash = '#/masuk'; location.reload(); }) }, 'Hapus akun'))));
  for (const m of me.memberships) {
    const f = h('form', { class: 'panel row', style: 'margin-top:12px' }, h('b', { class: 'grow' }, `${m.workspace_name} (${m.role})`),
      h('select', { name: 'availability', style: 'max-width:180px' }, ['tersedia', 'sibuk', 'cuti'].map((a) => h('option', { value: a, selected: a === m.availability }, a))),
      h('button', { class: 'btn small' }, 'Simpan status'));
    f.addEventListener('submit', run(async () => { await api('PATCH', `/api/workspaces/${m.workspace_id}/members/${me.person.id}`, { availability: f.availability.value }); toast('Status tersimpan'); await loadMe(); }));
    main.append(f);
    if (m.role === 'owner') {
      const r = h('form', { class: 'panel row', style: 'margin-top:8px' }, h('label', { class: 'grow' }, 'Retensi isi pesan WA mentah (30–365 hari)'),
        h('input', { name: 'days', type: 'number', min: 30, max: 365, value: m.retention_days, style: 'max-width:120px' }), h('button', { class: 'btn small' }, 'Simpan'));
      r.addEventListener('submit', run(async () => { await api('PATCH', `/api/workspaces/${m.workspace_id}`, { retention_days: Number(r.days.value) }); toast('Retensi tersimpan'); await loadMe(); }));
      main.append(r);
      const tr = await api('GET', `/api/workspaces/${m.workspace_id}/transfers`);
      main.append(h('div', { class: 'panel', style: 'margin-top:8px' }, h('b', {}, 'Register transfer data lintas negara'),
        h('table', {}, h('thead', {}, h('tr', {}, ['Penerima', 'Negara', 'Tujuan', 'Instrumen', 'Tinjau'].map((x) => h('th', {}, x)))),
          h('tbody', {}, tr.map((t) => h('tr', {}, h('td', {}, t.recipient), h('td', {}, t.country), h('td', {}, t.purpose), h('td', {}, t.instrument), h('td', {}, t.next_review || '')))))));
    }
  }
  if ('serviceWorker' in navigator && !isStandalone) main.append(h('p', { class: 'muted', style: 'margin-top:16px' }, 'Pasang Kolab-Hub ke layar utama dari menu browser agar bisa dibuka seperti aplikasi.'));
}

// ---------- Router ----------
async function loadMe() {
  try { state.me = await api('GET', '/api/me'); } catch { state.me = null; }
  if (state.me && !state.ws && state.me.memberships[0]) state.ws = state.me.memberships[0].workspace_id;
  return state.me;
}

async function render() {
  const main = document.getElementById('app');
  const hash = location.hash || '#/tugasku';
  const [, route, arg] = hash.split('/');
  const fresh = h('div');
  state.rerender = render;
  try {
    if (route === 'gabung') await viewJoin(fresh, arg);
    else if (route === 'masuk' || !state.me) { if (!state.me && route !== 'masuk') { location.hash = '#/masuk'; return; } viewLogin(fresh); }
    else if (route === 'tugasku') await viewMyTasks(fresh);
    else if (route === 'papan') await viewBoard(fresh, arg);
    else if (route === 'kartu') await viewCard(fresh, decodeURIComponent(arg));
    else if (route === 'tinjauan') await viewReview(fresh);
    else if (route === 'akun') await viewAccount(fresh);
    else await viewHome(fresh);
  } catch (e) { fresh.append(h('p', { class: 'panel' }, e.message)); }
  main.replaceChildren(fresh);
  state.dirty = false;
  document.getElementById('updates').hidden = true;
  nav();
  connectStream();
}

window.addEventListener('hashchange', render);
window.addEventListener('online', () => { document.getElementById('offline').hidden = true; render(); });
window.addEventListener('offline', () => { document.getElementById('offline').hidden = false; });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
document.getElementById('offline').hidden = navigator.onLine;
loadMe().then(render);
