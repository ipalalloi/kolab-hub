// Kolab-Hub web + PWA (tanpa build). DOM dibangun dengan h() agar tidak ada innerHTML dari data pengguna.
const COLS = [['masuk', 'Masuk'], ['dikerjakan', 'Dikerjakan'], ['ditinjau', 'Ditinjau'], ['selesai', 'Selesai'], ['tertahan', 'Tertahan']];
const COL_NAME = Object.fromEntries(COLS);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
import { outbox, flush, newOpId } from './offline.js';

const state = { me: null, ws: localStorage.getItem('kh.ws') || null, stream: null, rerender: null, pending: [] };

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

// ---------- Web Push ----------
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bytesToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function currentPushSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /android/i.test(ua) ? 'Android' : isIOS ? 'iOS' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : 'Perangkat';
  const br = /edg\//i.test(ua) ? 'Edge' : /firefox/i.test(ua) ? 'Firefox' : /chrome|crios/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : 'Peramban';
  return `${br} ${os}${isStandalone ? ' (aplikasi)' : ''}`;
}

async function enablePush() {
  const key = await api('GET', '/api/push/key');
  if (!key.enabled) throw new Error('Notifikasi push belum diaktifkan di server.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Izin notifikasi ditolak. Izinkan dari pengaturan situs di peramban, lalu coba lagi.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // Kunci server diganti: langganan lama tidak bisa dipakai lagi.
  if (sub && sub.options?.applicationServerKey && bytesToB64u(sub.options.applicationServerKey) !== key.public_key) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key.public_key) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON(), device: deviceLabel() });
}

async function disablePush() {
  const sub = await currentPushSub();
  if (!sub) return;
  await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/** Keluar: perangkat ini berhenti menerima notifikasi akun ini. */
async function logout() {
  const waiting = (await outbox.list(state.me?.person.id).catch(() => [])).filter((o) => o.status === 'menunggu').length;
  if (waiting && !confirm(`Ada ${waiting} tindakan luring yang belum terkirim. Keluar sekarang akan menghapusnya dari perangkat ini. Lanjutkan?`)) return false;
  const sub = await currentPushSub().catch(() => null);
  await api('POST', '/api/auth/logout', { push_endpoint: sub?.endpoint });
  await sub?.unsubscribe().catch(() => {});
  await outbox.clear().catch(() => {});
  await endSession();
  return true;
}

async function notificationPanel() {
  const me = state.me;
  const box = h('div', { class: 'panel stack', style: 'margin-top:12px' }, h('h2', { style: 'margin:0' }, 'Notifikasi'));
  const sub = await currentPushSub().catch(() => null);
  const status = (text) => h('p', { class: 'muted', id: 'pushStatus' }, text);
  if (!me.push?.enabled) box.append(status('Notifikasi push belum diaktifkan di server. Pemberitahuan tugas tetap dikirim lewat WhatsApp.'));
  else if (!pushSupported()) box.append(status(isIOS && !isStandalone
    ? 'Di iPhone/iPad, notifikasi hanya tersedia setelah Kolab-Hub dipasang: Bagikan → Tambah ke Layar Utama, lalu buka dari ikonnya (iOS 16.4 ke atas).'
    : 'Peramban ini tidak mendukung notifikasi push. Pemberitahuan tetap lewat WhatsApp.'));
  else if (Notification.permission === 'denied') box.append(status('Notifikasi diblokir untuk situs ini. Izinkan dari pengaturan situs di peramban.'));
  else {
    box.append(status(sub ? `Aktif di perangkat ini. Total perangkat Anda: ${me.push.devices}.` : (me.push.devices ? `Belum aktif di perangkat ini (aktif di ${me.push.devices} perangkat lain).` : 'Belum aktif. Tanpa push, pemberitahuan tugas dikirim lewat WhatsApp.')),
      h('div', { class: 'row' },
        sub ? h('button', { class: 'btn', id: 'pushOff', onclick: run(async () => { await disablePush(); await loadMe(); toast('Notifikasi dimatikan di perangkat ini'); state.rerender(); }) }, 'Matikan di perangkat ini')
          : h('button', { class: 'btn primary', id: 'pushOn', onclick: run(async () => { await enablePush(); await loadMe(); toast('Notifikasi aktif'); state.rerender(); }) }, 'Aktifkan notifikasi'),
        sub ? h('button', { class: 'btn', id: 'pushTest', onclick: run(async () => { await api('POST', '/api/push/test'); toast('Notifikasi uji dikirim'); }) }, 'Kirim uji') : null));
  }
  if (me.digest?.enabled) {
    const f = h('form', { class: 'row' }, h('label', { class: 'grow', for: 'digestSel' }, `Ringkasan harian pukul ${me.digest.time} (${me.digest.tz})`),
      h('select', { id: 'digestSel', name: 'digest', style: 'max-width:240px' },
        [['auto', 'Otomatis (push, atau WA)'], ['push', 'Hanya push'], ['wa', 'Hanya WhatsApp'], ['off', 'Jangan kirim']].map(([v, l]) => h('option', { value: v, selected: me.person.digest_channel === v }, l))),
      h('button', { class: 'btn small' }, 'Simpan'));
    f.addEventListener('submit', run(async () => { await api('PATCH', '/api/me', { digest_channel: f.digest.value }); state.dirty = false; await loadMe(); toast('Pilihan ringkasan tersimpan'); }));
    box.append(f);
  }
  return box;
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
      c.hold_reason ? h('span', { class: 'tag' }, `⏸ ${c.hold_reason}`) : null,
      state.pending.some((o) => o.code === c.code && o.status === 'menunggu') ? h('span', { class: 'tag pending' }, '⏳ menunggu kirim') : null),
    c.progress ? h('div', { class: 'progress', 'aria-label': `progres ${c.progress}%` }, h('span', { style: `width:${c.progress}%` })) : null);
  if (draggable) el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', c.code));
  return el;
}

// Sama dengan parsePercent di server: isian kosong atau bukan angka tidak pernah menjadi 0%.
function parsePercent(v) {
  const t = String(v ?? '').trim().replace(/%$/, '').trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n <= 100 ? n : null;
}

/** Tanya persentase sampai sah atau dibatalkan. Mengembalikan null bila dibatalkan. */
function askPercent() {
  let msg = 'Progres berapa persen? (angka bulat 0–100)';
  for (;;) {
    const raw = prompt(msg);
    if (raw === null) return null;
    const n = parsePercent(raw);
    if (n !== null) return n;
    msg = raw.trim() ? `"${raw.trim()}" bukan angka 0–100. Progres berapa persen?` : 'Isian kosong. Progres berapa persen? (angka bulat 0–100)';
  }
}

// Tombol tindakan kartu. Server mengirim `card.actions` sesuai status kartu dan peran peminta.
const ACTION_UI = {
  mulai: { icon: '▶', label: (c) => (c.column_key === 'tertahan' ? 'Lanjutkan' : 'Mulai') },
  progres: { icon: '📈', label: () => 'Lapor progres', short: 'Lapor' },
  selesai: { icon: '✅', label: () => 'Selesai' },
  tahan: { icon: '⏸', label: () => 'Tahan' },
  bantuan: { icon: '🆘', label: () => 'Minta bantuan', short: 'Bantuan' },
  setujui: { icon: '👍', label: () => 'Setujui', primary: true },
  revisi: { icon: '↩', label: () => 'Minta revisi' },
  cek: { icon: '✔', label: () => 'Tandai sudah dicek' },
};

function actionButtons(c, { compact = false } = {}) {
  return (c.actions || []).filter((a) => ACTION_UI[a]).map((a) => {
    const ui = ACTION_UI[a];
    const label = compact && ui.short ? ui.short : ui.label(c);
    return h('button', { class: `btn${ui.primary ? ' primary' : ''}`, 'data-action': a, onclick: run(async () => { await quick(c.code, a); state.rerender(); }) },
      compact ? h('b', {}, ui.icon) : null, label);
  });
}

async function quick(code, action) {
  const args = { action };
  if (action === 'progres') { const p = askPercent(); if (p === null) return; args.percent = p; args.note = prompt('Catatan singkat (opsional)') || ''; }
  if (action === 'selesai') args.note = prompt('Catatan hasil (opsional)') || '';
  if (action === 'bantuan') { const n = prompt('Bantuan apa yang dibutuhkan?'); if (n === null) return; args.note = n; }
  if (action === 'tahan') { const r = prompt('Alasan menahan kartu?'); if (!r) return; args.reason = r; }
  if (action === 'revisi') { const r = prompt('Catatan revisi?'); if (!r) return; args.note = r; }
  const r = await sendAction(code, args);
  toast(r.queued ? `Luring: ${code} disimpan dan dikirim saat tersambung` : `${code} diperbarui`);
}

// ---------- Antrean luring ----------
const ACTION_LABEL = { mulai: 'Mulai', progres: 'Lapor progres', selesai: 'Selesai', tahan: 'Tahan', bantuan: 'Minta bantuan', setujui: 'Setujui', revisi: 'Minta revisi', cek: 'Tandai dicek', komentar: 'Komentar' };

async function postOp(op, { replay }) {
  const res = await fetch(`/api/cards/${encodeURIComponent(op.code)}/actions`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-kolab-csrf': '1', 'x-kolab-client': isStandalone ? 'pwa' : 'web', 'x-kolab-op-id': op.op_id },
    body: JSON.stringify(replay ? { ...op.args, queued_at: op.queued_at } : op.args),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/** Kirim tindakan kartu; bila tidak ada sinyal, simpan ke antrean perangkat. */
async function sendAction(code, args) {
  const op = { op_id: newOpId(), code, args, queued_at: new Date().toISOString(), person_id: state.me?.person.id };
  const queue = async () => { await outbox.add(op); await refreshPending(); return { queued: true }; };
  if (!navigator.onLine) return queue();
  let r;
  try { r = await postOp(op, { replay: false }); } catch { return queue(); } // jaringan putus di tengah jalan: op_id menjaga dari dobel
  if (r.status === 401) { await clearPrivateCache(); location.hash = '#/masuk'; throw new Error('Silakan masuk'); }
  if (r.status < 200 || r.status >= 300) throw new Error(r.data.error || `Gagal (${r.status})`);
  return r.data;
}

async function refreshPending() {
  state.pending = state.me ? await outbox.list(state.me.person.id).catch(() => []) : [];
  const waiting = state.pending.filter((o) => o.status === 'menunggu').length;
  const bar = document.getElementById('offline');
  bar.textContent = navigator.onLine
    ? (waiting ? `Mengirim ${waiting} tindakan luring…` : '')
    : `Luring — tampilan mungkin tidak terbaru.${waiting ? ` ${waiting} tindakan menunggu dikirim.` : ' Tindakan tetap bisa dilakukan dan dikirim saat tersambung.'}`;
  bar.hidden = navigator.onLine && !waiting;
}

let flushing = false;
async function flushPending() {
  if (flushing || !navigator.onLine || !state.me) return;
  flushing = true;
  try {
    const r = await flush(state.me.person.id, (op) => postOp(op, { replay: true }));
    if (r.stopped === 'sesi') { location.hash = '#/masuk'; }
    if (r.sent) toast(`${r.sent} tindakan luring terkirim`);
    if (r.rejected.length) toast(`${r.rejected.length} tindakan luring ditolak server — lihat Tugas saya`);
    if (r.sent || r.rejected.length) state.rerender?.();
  } finally { flushing = false; await refreshPending(); }
}

function pendingPanel() {
  if (!state.pending.length) return null;
  const waiting = state.pending.filter((o) => o.status === 'menunggu');
  const rejected = state.pending.filter((o) => o.status === 'ditolak');
  const when = (o) => new Date(o.queued_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
  const detail = (o) => (o.args.percent !== undefined ? ` ${o.args.percent}%` : '');
  return h('div', { class: 'panel stack', id: 'pendingPanel', style: 'margin-bottom:12px' },
    waiting.length ? h('div', {}, h('b', {}, `Menunggu dikirim (${waiting.length})`),
      h('ul', { class: 'plain' }, waiting.map((o) => h('li', {}, `⏳ ${o.code} · ${ACTION_LABEL[o.args.action] || o.args.action}${detail(o)} · ${when(o)}`)))) : null,
    rejected.length ? h('div', {}, h('b', {}, `Ditolak server (${rejected.length})`),
      h('ul', { class: 'plain' }, rejected.map((o) => h('li', { class: 'row' }, h('span', { class: 'grow' }, `⚠️ ${o.code} · ${ACTION_LABEL[o.args.action] || o.args.action}${detail(o)} · ${when(o)} — ${o.error}`),
        h('button', { class: 'btn small', onclick: run(async () => { await outbox.remove(o.op_id); await refreshPending(); state.rerender(); }) }, 'Tutup'))))) : null);
}

async function viewMyTasks(main) {
  const tasks = await api('GET', '/api/my/tasks');
  main.append(h('h1', {}, 'Tugas saya'));
  await refreshPending();
  const pp = pendingPanel();
  if (pp) main.append(pp);
  if (!isStandalone && /iphone|ipad/i.test(navigator.userAgent)) main.append(h('p', { class: 'muted' }, 'Tip iPhone: Bagikan → Tambah ke Layar Utama agar Kolab-Hub bisa dipakai seperti aplikasi.'));
  if (!tasks.length) { main.append(h('p', { class: 'panel' }, 'Tidak ada tugas aktif. 👍')); return; }
  for (const c of tasks) {
    const box = h('div', { class: 'panel', style: 'margin-bottom:12px' }, cardTile(c),
      h('div', { class: 'shortcuts' }, actionButtons(c, { compact: true })));
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
  if (p.offline_at) bits.push(`(dilakukan luring ${new Date(p.offline_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })})`);
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
      (() => { const btns = actionButtons(c); return btns.length ? h('div', { class: 'row' }, btns) : h('p', { class: 'muted' }, my_role === 'viewer' ? 'Anda pemantau: hanya dapat melihat.' : 'Tidak ada tindakan untuk Anda pada kartu ini.'); })(),
      (c.actions || []).includes('komentar') && (() => {
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
      h('button', { class: 'btn', onclick: run(async () => { if (await logout()) location.hash = '#/masuk'; }) }, 'Keluar'),
      h('button', { class: 'btn danger', onclick: run(async () => { if (!confirm('Hapus akun dan nomor Anda? Riwayat kerja tetap ada atas nama "Mantan anggota".')) return; const sub = await currentPushSub().catch(() => null); await api('DELETE', '/api/me'); await sub?.unsubscribe().catch(() => {}); await outbox.clear().catch(() => {}); await endSession(); location.hash = '#/masuk'; location.reload(); }) }, 'Hapus akun'))),
    await notificationPanel());
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
  // Antrean milik akun lain yang pernah masuk di perangkat ini tidak boleh terkirim atas nama akun ini.
  if (state.me) await outbox.clear(state.me.person.id).catch(() => {});
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
window.addEventListener('online', async () => { await refreshPending(); await flushPending(); render(); });
window.addEventListener('offline', refreshPending);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flushPending(); });
setInterval(flushPending, 30_000);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // Klik notifikasi saat aplikasi sudah terbuka (peramban tanpa client.navigate).
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'open' && new URL(e.data.url).origin === location.origin) location.href = e.data.url; });
}
loadMe().then(async () => { await refreshPending(); await render(); await flushPending(); });
