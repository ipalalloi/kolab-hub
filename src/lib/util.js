import { randomBytes } from 'node:crypto';

/** Id urut-waktu (mirip ULID): 10 hex waktu + 12 hex acak. */
export function newId() {
  return Date.now().toString(16).padStart(12, '0') + randomBytes(6).toString('hex');
}

export const nowIso = () => new Date().toISOString();

/** Normalisasi nomor ke format wa_id Meta (tanpa +), dengan asumsi awalan 0 = Indonesia. */
export function normalizePhone(input) {
  let p = String(input || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = '62' + p.slice(1);
  if (!/^\d{8,15}$/.test(p)) return null;
  return p;
}

export function maskPhone(p) {
  if (!p) return '';
  return p.length <= 6 ? '***' : `${p.slice(0, 4)}****${p.slice(-3)}`;
}

export function parseJson(s, fallback = null) {
  if (s === null || s === undefined || s === '') return fallback;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
