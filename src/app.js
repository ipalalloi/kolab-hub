// Menyusun semua komponen dari konfigurasi dan koneksi DB.
import { makeCrypto } from './lib/crypto.js';
import { makeQueue } from './jobs/queue.js';
import { makeOutbound } from './wa/outbound.js';
import { makeProcessor } from './wa/processor.js';
import { makeWebhook } from './wa/webhook.js';
import { makeWorker } from './jobs/worker.js';
import { makeAuth } from './auth/auth.js';
import { makePush } from './push/push.js';
import { makeNotifier } from './notify/notifier.js';
import { makeDigest } from './notify/digest.js';

export function makeContext({ cfg, db, log = console, fetchImpl }) {
  const ctx = { cfg, db, log, crypto: makeCrypto(cfg.keys) };
  ctx.queue = makeQueue(db);
  ctx.outbound = makeOutbound(ctx);
  ctx.push = makePush(ctx, { fetchImpl });
  ctx.notifier = makeNotifier(ctx);
  ctx.digest = makeDigest(ctx);
  ctx.processor = makeProcessor(ctx);
  ctx.webhook = makeWebhook(ctx);
  ctx.auth = makeAuth(ctx);
  ctx.worker = makeWorker(ctx, { log });
  return ctx;
}
