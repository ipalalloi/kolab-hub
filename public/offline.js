// Antrean luring (IndexedDB): tindakan kartu yang dilakukan tanpa sinyal disimpan di perangkat,
// lalu dikirim berurutan saat tersambung. Setiap operasi punya op_id unik sehingga server
// tidak pernah mencatatnya dua kali walau terkirim ulang.
const DB = 'kolab-hub';
const STORE = 'outbox';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'op_id' });
      s.createIndex('person', 'person_id');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(out?.result ?? out); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export function newOpId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const outbox = {
  add: (op) => tx('readwrite', (s) => s.put({ status: 'menunggu', ...op })),
  put: (op) => tx('readwrite', (s) => s.put(op)),
  remove: (opId) => tx('readwrite', (s) => s.delete(opId)),
  async list(personId) {
    const all = await tx('readonly', (s) => s.getAll());
    return all.filter((o) => !personId || o.person_id === personId).sort((a, b) => a.queued_at.localeCompare(b.queued_at));
  },
  /** Hapus semua operasi (keluar akun) atau milik orang lain (akun lain masuk di perangkat ini). */
  async clear(exceptPersonId = null) {
    const all = await tx('readonly', (s) => s.getAll());
    await tx('readwrite', (s) => { for (const o of all) if (!exceptPersonId || o.person_id !== exceptPersonId) s.delete(o.op_id); });
  },
};

/**
 * Kirim operasi yang menunggu, satu per satu sesuai urutan dilakukan.
 * post(op) → { status, data }; melempar TypeError bila jaringan putus.
 * Berhenti saat jaringan putus, sesi habis (401), atau server bermasalah (5xx) agar dicoba lagi nanti.
 */
export async function flush(personId, post) {
  const result = { sent: 0, rejected: [], stopped: null };
  for (const op of await outbox.list(personId)) {
    if (op.status !== 'menunggu') continue;
    let res;
    try { res = await post(op); } catch (e) { result.stopped = 'jaringan'; break; }
    if (res.status === 401) { result.stopped = 'sesi'; break; }
    if (res.status >= 500) { result.stopped = 'server'; break; }
    if (res.status >= 200 && res.status < 300) { await outbox.remove(op.op_id); result.sent += 1; continue; }
    // Ditolak aturan (mis. kartu sudah diubah orang lain): simpan untuk ditunjukkan, jangan dicoba lagi.
    const failed = { ...op, status: 'ditolak', error: res.data?.error || `Ditolak (${res.status})` };
    await outbox.put(failed);
    result.rejected.push(failed);
  }
  return result;
}
