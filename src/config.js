// Konfigurasi dari variabel lingkungan. Nilai rahasia hanya dibaca dari .env di VPS.
import { readFileSync, existsSync } from 'node:fs';

export function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function req(env, key, fallbackForDev) {
  const v = env[key];
  if (v) return v;
  if (env.NODE_ENV !== 'production' && fallbackForDev !== undefined) return fallbackForDev;
  throw new Error(`Variabel lingkungan ${key} wajib diisi`);
}

// Kunci pengembangan: HANYA untuk mode non-produksi dan uji. Produksi menolak berjalan tanpa kunci asli.
const DEV_KEY = Buffer.alloc(32, 7).toString('base64');

export function loadConfig(env = process.env) {
  const waMode = env.WA_MODE || 'simulate'; // simulate | cloud
  const cfg = {
    env: env.NODE_ENV || 'development',
    port: Number(env.PORT || 3000),
    baseUrl: env.BASE_URL || `http://localhost:${env.PORT || 3000}`,
    db: {
      driver: env.DB_DRIVER || (env.DATABASE_URL ? 'pg' : 'sqlite'),
      url: env.DATABASE_URL || '',
      sqlitePath: env.SQLITE_PATH || 'data/kolab.sqlite',
    },
    keys: {
      encryption: req(env, 'ENCRYPTION_KEY', DEV_KEY),
      blindIndex: req(env, 'BLIND_INDEX_KEY', DEV_KEY),
      session: req(env, 'SESSION_SECRET', DEV_KEY),
    },
    wa: {
      mode: waMode,
      appSecret: waMode === 'cloud' ? req(env, 'WA_APP_SECRET') : (env.WA_APP_SECRET || 'sim-app-secret'),
      verifyToken: waMode === 'cloud' ? req(env, 'WA_VERIFY_TOKEN') : (env.WA_VERIFY_TOKEN || 'sim-verify-token'),
      apiBase: env.WA_API_BASE || 'https://graph.facebook.com/v21.0',
      phoneNumberId: env.WA_PHONE_NUMBER_ID || '',
      accessToken: env.WA_ACCESS_TOKEN || '',
      otpTemplate: env.WA_OTP_TEMPLATE || 'kolab_otp',
      assignTemplate: env.WA_ASSIGN_TEMPLATE || 'kolab_tugas_baru',
      templateLang: env.WA_TEMPLATE_LANG || 'id',
      rateLimitPerMinute: Number(env.WA_RATE_LIMIT_PER_MINUTE || 20),
    },
    retention: {
      defaultDays: Number(env.RETENTION_DEFAULT_DAYS || 90),
      minDays: 30,
      maxDays: 365,
      backupDays: 30,
      logDays: 30,
    },
    workerInline: (env.WORKER_INLINE || 'true') === 'true',
    defaultWipLimit: Number(env.DEFAULT_WIP_LIMIT || 3),
    filesDir: env.FILES_DIR || 'data/files',
    // Web Push (VAPID). Kosong = push nonaktif; notifikasi kembali ke WA seperti MVP.
    push: {
      publicKey: env.VAPID_PUBLIC_KEY || '',
      privateKey: env.VAPID_PRIVATE_KEY || '',
      subject: env.VAPID_SUBJECT || '',
      ttlSec: Number(env.PUSH_TTL_SECONDS || 86_400),
    },
    // Ringkasan harian: satu pesan per orang per hari pada jam lokal DIGEST_TIME di zona DIGEST_TZ.
    digest: {
      enabled: (env.DIGEST_ENABLED || 'true') === 'true',
      time: /^\d{2}:\d{2}$/.test(env.DIGEST_TIME || '') ? env.DIGEST_TIME : '07:00',
      tz: env.DIGEST_TZ || 'Asia/Makassar',
      template: env.WA_DIGEST_TEMPLATE || 'kolab_ringkasan_harian',
    },
    secureCookies: (env.SECURE_COOKIES || (env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
  };
  if (cfg.push.publicKey || cfg.push.privateKey) {
    if (!cfg.push.publicKey || !cfg.push.privateKey) throw new Error('VAPID_PUBLIC_KEY dan VAPID_PRIVATE_KEY harus diisi berpasangan');
    if (!/^(mailto:|https:)/.test(cfg.push.subject)) throw new Error('VAPID_SUBJECT wajib diisi, mis. mailto:admin@domain-anda');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: cfg.digest.tz }); } catch { throw new Error(`DIGEST_TZ tidak dikenal: ${cfg.digest.tz}`); }
  if (cfg.env === 'production' && cfg.keys.encryption === DEV_KEY) throw new Error('ENCRYPTION_KEY pengembangan dilarang di produksi');
  if (cfg.env === 'production' && waMode === 'simulate' && env.ALLOW_SIMULATE_IN_PRODUCTION !== 'true') {
    throw new Error('WA_MODE=simulate tidak boleh di produksi (set ALLOW_SIMULATE_IN_PRODUCTION=true untuk uji coba)');
  }
  return cfg;
}
