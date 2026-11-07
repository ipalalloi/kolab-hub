// Titik masuk HTTP: API, webhook WhatsApp, aliran real-time (SSE), dan berkas PWA.
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDotEnv, loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { makeContext } from './app.js';
import { makeRouter, readBody, parseCookies, send, serveStatic, SECURITY_HEADERS } from './http/http.js';
import { registerRoutes } from './api/routes.js';
import { SESSION_COOKIE } from './auth/auth.js';
import { HttpError, parseJson } from './lib/util.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createHandler(ctx) {
  const router = makeRouter();
  registerRoutes(router, ctx);
  const allowedOrigin = new URL(ctx.cfg.baseUrl).origin;

  async function stream(req, res, person) {
    const ws = (await ctx.db.all('SELECT workspace_id FROM memberships WHERE person_id = ? AND removed_at IS NULL', [person.id])).map((r) => r.workspace_id);
    let cursor = Number(req.headers['last-event-id'] || 0);
    if (!cursor) cursor = Number((await ctx.db.get('SELECT MAX(seq) AS s FROM events'))?.s || 0);
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    let closed = false;
    const tick = async () => {
      if (closed || !ws.length) return;
      const marks = ws.map(() => '?').join(',');
      const rows = await ctx.db.all(`SELECT seq, workspace_id, card_id, type, source, payload, created_at FROM events WHERE seq > ? AND workspace_id IN (${marks}) ORDER BY seq LIMIT 200`, [cursor, ...ws]);
      for (const r of rows) {
        cursor = Number(r.seq);
        const card = r.card_id ? await ctx.db.get('SELECT code, board_id, column_key FROM cards WHERE id = ?', [r.card_id]) : null;
        res.write(`id: ${cursor}\nevent: kolab\ndata: ${JSON.stringify({ seq: cursor, type: r.type, source: r.source, workspace_id: r.workspace_id, card, payload: parseJson(r.payload, {}) })}\n\n`);
      }
    };
    const iv = setInterval(() => tick().catch(() => {}), 1500);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { closed = true; clearInterval(iv); clearInterval(ping); });
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    req.ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    try {
      if (path === '/healthz') return send(res, 200, { ok: true, wa_mode: ctx.cfg.wa.mode });
      if (path === '/webhook/whatsapp') {
        if (req.method === 'GET') { const r = await ctx.webhook.verifyGet(url.searchParams); return send(res, r.status, r.body); }
        if (req.method === 'POST') {
          const raw = await readBody(req, 2_000_000);
          const r = await ctx.webhook.receive(raw, req.headers['x-hub-signature-256']);
          return send(res, r.status, r.body);
        }
        return send(res, 405, 'method not allowed');
      }
      if (path.startsWith('/api/')) {
        const cookies = parseCookies(req.headers.cookie);
        req.sessionToken = cookies[SESSION_COOKIE];
        req.person = await ctx.auth.sessionPerson(req.sessionToken);
        if (req.method !== 'GET') {
          // CSRF: wajib header kustom + Origin sama (cookie juga SameSite=Strict).
          if (req.headers['x-kolab-csrf'] !== '1') throw new HttpError(403, 'Permintaan ditolak (CSRF)', 'csrf');
          const origin = req.headers.origin;
          if (origin && origin !== allowedOrigin) throw new HttpError(403, 'Origin tidak diizinkan', 'csrf');
        }
        if (path === '/api/stream' && req.method === 'GET') {
          if (!req.person) throw new HttpError(401, 'Silakan masuk dulu');
          return stream(req, res, req.person);
        }
        const m = router.match(req.method, path);
        if (!m) throw new HttpError(404, 'Tidak ditemukan');
        const out = await m.handler(req, m.params);
        if (out && typeof out === 'object' && 'status' in out && 'body' in out && Object.keys(out).every((k) => ['status', 'body', 'headers'].includes(k))) {
          return send(res, out.status, out.body, out.headers);
        }
        if (ctx.cfg.workerInline && req.method !== 'GET') ctx.worker.drain().catch((e) => ctx.log.error?.(e));
        return send(res, 200, out ?? { ok: true });
      }
      if ((path === '/sim.html' || path === '/sim.js') && ctx.cfg.wa.mode !== 'simulate') return send(res, 404, 'tidak ditemukan');
      if (req.method === 'GET' && (await serveStatic(res, PUBLIC_DIR, path))) return;
      if (req.method === 'GET' && path === '/sim' && ctx.cfg.wa.mode === 'simulate' && (await serveStatic(res, PUBLIC_DIR, '/sim.html'))) return;
      return send(res, 404, 'tidak ditemukan');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      ctx.log.error?.(e);
      return send(res, 500, { error: 'Terjadi kesalahan server' });
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadDotEnv();
  const cfg = loadConfig();
  const db = await openDb(cfg.db);
  await migrate(db, { log: console.log });
  const ctx = makeContext({ cfg, db });
  if (cfg.workerInline) ctx.worker.start();
  const server = createServer(createHandler(ctx));
  server.listen(cfg.port, () => console.log(`Kolab-Hub berjalan di ${cfg.baseUrl} (WA_MODE=${cfg.wa.mode}, DB=${db.dialect})`));
  const stop = async () => { ctx.worker.stop(); server.close(); await db.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
