// Worker antrean: memproses pesan masuk, mengirim pesan keluar (WA dan Web Push),
// dan menjadwalkan retensi serta ringkasan harian.
import { runRetention } from './retention.js';
import { parseJson } from '../lib/util.js';

export function makeWorker(ctx, { pollMs = 500, log = console } = {}) {
  const { queue, processor, outbound, db, push, notifier, digest } = ctx;
  const handlers = {
    'wa.process': (p) => processor.process(p.meta_id),
    'wa.send': (p) => outbound.send(p.outbox_id),
    'retention.run': () => runRetention(ctx),
    'push.send': (p) => push.send(p),
    'digest.run': (p) => digest.run(p),
    'digest.send': (p) => digest.send(p),
  };
  let timer = null;
  let running = false;

  async function maybeScheduleRetention() {
    const row = await db.get("SELECT value FROM kv WHERE key = 'retention.last_run'");
    const last = parseJson(row?.value, {})?.at;
    const day = new Date().toISOString().slice(0, 10);
    if (!last || last.slice(0, 10) < day) await queue.enqueue('retention.run', {}, { dedupeKey: `retention:${day}` });
  }

  async function scanNotifications() {
    try { return await notifier.scan(); } catch (e) { log.error?.(`[worker] notifikasi: ${e.message}`); return 0; }
  }

  /**
   * Jalankan tugas siap sampai antrean kosong (dipakai juga oleh uji).
   * Event baru dari tugas (mis. laporan WA) dipindai lagi di putaran yang sama, sehingga
   * notifikasi push terkirim tanpa menunggu tick berikutnya.
   */
  async function drain(max = 1000) {
    let n = 0;
    await scanNotifications();
    for (let round = 0; round < 5; round++) {
      for (; n < max; n++) {
        const job = await queue.claim();
        if (!job) break;
        try {
          const h = handlers[job.type];
          if (!h) throw new Error(`jenis tugas tidak dikenal: ${job.type}`);
          await h(job.payload);
          await queue.complete(job.id);
        } catch (e) {
          const dead = await queue.fail(job, e);
          log.error?.(`[worker] ${job.type} gagal (percobaan ${job.attempts})${dead ? ' — dihentikan' : ''}: ${e.message}`);
        }
      }
      if (!(await scanNotifications())) break;
    }
    return n;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      await queue.recoverStale();
      await maybeScheduleRetention();
      await digest.maybeSchedule();
      await drain();
    } catch (e) { log.error?.(`[worker] ${e.message}`); }
    finally { running = false; }
  }

  return {
    drain,
    start() { if (!timer) { timer = setInterval(tick, pollMs); timer.unref?.(); tick(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}
