// Menyusun semua komponen dari konfigurasi dan koneksi DB.
import { makeCrypto } from './lib/crypto.js';
import { makeQueue } from './jobs/queue.js';
import { makeOutbound } from './wa/outbound.js';
import { makeProcessor } from './wa/processor.js';
import { makeWebhook } from './wa/webhook.js';
import { makeWorker } from './jobs/worker.js';
import { makeAuth } from './auth/auth.js';

export function makeContext({ cfg, db, log = console }) {
  const ctx = { cfg, db, log, crypto: makeCrypto(cfg.keys) };
  ctx.queue = makeQueue(db);
  ctx.outbound = makeOutbound(ctx);
  ctx.processor = makeProcessor(ctx);
  ctx.webhook = makeWebhook(ctx);
  ctx.auth = makeAuth(ctx);
  ctx.worker = makeWorker(ctx, { log });
  return ctx;
}
