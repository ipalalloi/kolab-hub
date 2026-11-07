// Enkripsi per kolom (AES-256-GCM), blind index untuk pencarian nomor, dan verifikasi tanda tangan Meta.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export function makeCrypto(keys) {
  const encKey = Buffer.from(keys.encryption, 'base64');
  const idxKey = Buffer.from(keys.blindIndex, 'base64');
  if (encKey.length !== 32) throw new Error('ENCRYPTION_KEY harus 32 byte (base64)');
  return {
    encrypt(plain) {
      if (plain === null || plain === undefined) return null;
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', encKey, iv);
      const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${body.toString('base64')}`;
    },
    decrypt(token) {
      if (!token) return null;
      const [v, iv, tag, body] = token.split('.');
      if (v !== 'v1') throw new Error('format sandi tidak dikenal');
      const d = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
    },
    blindIndex(value) {
      return createHmac('sha256', idxKey).update(String(value)).digest('hex');
    },
  };
}

export function hmacHex(secret, data) {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Verifikasi header X-Hub-Signature-256 terhadap body mentah. */
export function verifyMetaSignature(appSecret, rawBody, header) {
  if (!header || !header.startsWith('sha256=')) return false;
  return safeEqual(header.slice(7), hmacHex(appSecret, rawBody));
}

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

export function randomDigits(n = 6) {
  const buf = randomBytes(n);
  return Array.from(buf, (b) => String(b % 10)).join('');
}
