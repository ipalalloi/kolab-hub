// OTP lewat WhatsApp (template autentikasi) dan sesi berbasis cookie HttpOnly.
import { hmacHex, randomDigits, randomToken, sha256Hex, safeEqual } from '../lib/crypto.js';
import { HttpError, newId, nowIso, normalizePhone } from '../lib/util.js';

const OTP_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 30 * 86_400_000;
export const SESSION_COOKIE = 'kh_sess';

export function makeAuth(ctx) {
  const { db, crypto, cfg, outbound } = ctx;

  async function requestOtp(rawPhone, purpose) {
    const phone = normalizePhone(rawPhone);
    if (!phone) throw new HttpError(400, 'Nomor WhatsApp tidak valid');
    const phoneHash = crypto.blindIndex(phone);
    const since = new Date(Date.now() - 15 * 60_000).toISOString();
    const recent = await db.get('SELECT COUNT(*) AS n FROM otp_codes WHERE phone_hash = ? AND created_at > ?', [phoneHash, since]);
    if (Number(recent.n) >= 3) throw new HttpError(429, 'Terlalu banyak permintaan kode. Coba lagi 15 menit lagi.');
    if (purpose === 'login') {
      const person = await db.get('SELECT id FROM people WHERE phone_hash = ? AND verified_at IS NOT NULL AND erased_at IS NULL', [phoneHash]);
      // Jawaban sama untuk nomor terdaftar/tidak, agar tidak membocorkan keanggotaan.
      if (!person) return { phone, sent: true };
    }
    const code = randomDigits(6);
    const id = newId();
    await db.tx(async (t) => {
      await t.run(
        'INSERT INTO otp_codes (id, phone_hash, code_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [id, phoneHash, hmacHex(cfg.keys.session, `${id}:${code}`), purpose, new Date(Date.now() + OTP_TTL_MS).toISOString(), nowIso()],
      );
      await outbound.template(t, {
        phone, kind: 'template',
        text: `Kode verifikasi Kolab-Hub: ${code}. Berlaku 10 menit. Jangan bagikan kode ini.`,
        template: {
          name: cfg.wa.otpTemplate,
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      });
    });
    return { phone, sent: true };
  }

  async function verifyOtp(rawPhone, code, purpose) {
    const phone = normalizePhone(rawPhone);
    if (!phone || !/^\d{6}$/.test(String(code || ''))) throw new HttpError(400, 'Kode tidak valid');
    const phoneHash = crypto.blindIndex(phone);
    const row = await db.get(
      'SELECT * FROM otp_codes WHERE phone_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
      [phoneHash, purpose, nowIso()],
    );
    if (!row || Number(row.attempts) >= 5) throw new HttpError(400, 'Kode salah atau kedaluwarsa');
    if (!safeEqual(row.code_hash, hmacHex(cfg.keys.session, `${row.id}:${code}`))) {
      await db.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
      throw new HttpError(400, 'Kode salah atau kedaluwarsa');
    }
    await db.run('UPDATE otp_codes SET used_at = ? WHERE id = ?', [nowIso(), row.id]);
    return { phone, phoneHash };
  }

  async function createSession(personId) {
    const token = randomToken(32);
    await db.run('INSERT INTO sessions (id_hash, person_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [sha256Hex(token), personId, nowIso(), new Date(Date.now() + SESSION_TTL_MS).toISOString()]);
    return token;
  }

  async function sessionPerson(token) {
    if (!token) return null;
    return db.get(
      `SELECT p.* FROM sessions s JOIN people p ON p.id = s.person_id
       WHERE s.id_hash = ? AND s.expires_at > ? AND p.erased_at IS NULL`,
      [sha256Hex(token), nowIso()],
    );
  }

  async function destroySession(token) {
    if (token) await db.run('DELETE FROM sessions WHERE id_hash = ?', [sha256Hex(token)]);
  }

  function cookieHeader(token, maxAgeMs = SESSION_TTL_MS) {
    const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (cfg.secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  return { requestOtp, verifyOtp, createSession, sessionPerson, destroySession, cookieHeader };
}
