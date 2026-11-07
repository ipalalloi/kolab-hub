// Worker terpisah (dipakai bila WORKER_INLINE=false, mis. beberapa instance API di belakang load balancer).
import { loadDotEnv, loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { makeContext } from '../app.js';

loadDotEnv();
const cfg = loadConfig();
const db = await openDb(cfg.db);
await migrate(db, { log: console.log });
const ctx = makeContext({ cfg, db });
ctx.worker.start();
console.log(`Worker Kolab-Hub berjalan (WA_MODE=${cfg.wa.mode}, DB=${db.dialect})`);
const stop = async () => { ctx.worker.stop(); await db.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1 << 30);
