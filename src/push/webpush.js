// Web Push tanpa dependensi: enkripsi isi (RFC 8291, aes128gcm / RFC 8188) dan
// identifikasi server VAPID (RFC 8292, JWT ES256). Hanya memakai node:crypto.
import { createECDH, createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, verify } from 'node:crypto';

export const b64u = {
  enc: (buf) => Buffer.from(buf).toString('base64url'),
  dec: (s) => Buffer.from(String(s), 'base64url'),
};

const RS = 4096;

// getPrivateKey() membuang nol di depan, jadi ±1/256 kunci P-256 hanya 31 byte (atau kurang).
// Kunci privat selalu dinormalkan ke 32 byte (RFC 8292 / JWK P-256 mewajibkan panjang tetap).
function pad32(buf) {
  if (buf.length > 32) throw new Error('VAPID_PRIVATE_KEY harus 32 byte (base64url)');
  return buf.length === 32 ? buf : Buffer.concat([Buffer.alloc(32 - buf.length), buf]);
}

/** Pasangan kunci VAPID baru (P-256). Publik: titik tak terkompresi 65 byte; privat: skalar 32 byte. */
export function generateVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u.enc(ecdh.getPublicKey()), privateKey: b64u.enc(pad32(ecdh.getPrivateKey())) };
}

function jwk(publicKeyB64u, privateKeyB64u) {
  const pub = b64u.dec(publicKeyB64u);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY harus titik P-256 tak terkompresi (65 byte, base64url)');
  const key = { kty: 'EC', crv: 'P-256', x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33, 65)) };
  if (privateKeyB64u) {
    const raw = b64u.dec(privateKeyB64u);
    if (!raw.length) throw new Error('VAPID_PRIVATE_KEY harus 32 byte (base64url)');
    // Kunci 31 byte dari versi lama `npm run gen-keys` tetap diterima.
    key.d = b64u.enc(pad32(raw));
  }
  return key;
}

/** Pastikan pasangan kunci VAPID cocok (dipakai saat start agar salah salin cepat ketahuan). */
export function checkVapidKeys({ publicKey, privateKey }) {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(b64u.dec(privateKey));
  if (b64u.enc(ecdh.getPublicKey()) !== b64u.enc(b64u.dec(publicKey))) throw new Error('VAPID_PUBLIC_KEY tidak cocok dengan VAPID_PRIVATE_KEY');
}

/**
 * Header Authorization VAPID untuk satu endpoint.
 * aud = origin layanan push; exp maksimal 24 jam (dipakai 12 jam).
 */
export function vapidAuthorization(endpoint, { publicKey, privateKey, subject }, { now = Date.now(), ttlSec = 12 * 3600 } = {}) {
  const header = b64u.enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u.enc(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + ttlSec, sub: subject }));
  const data = `${header}.${claims}`;
  const key = createPrivateKey({ key: jwk(publicKey, privateKey), format: 'jwk' });
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u.enc(sig)}, k=${b64u.enc(b64u.dec(publicKey))}`;
}

/** Periksa JWT VAPID (untuk uji). Mengembalikan klaim bila tanda tangan sah. */
export function verifyVapidAuthorization(value) {
  const m = String(value).match(/^vapid t=([^,]+), k=(.+)$/);
  if (!m) return null;
  const [h, c, s] = m[1].split('.');
  const key = createPublicKey({ key: jwk(m[2]), format: 'jwk' });
  const ok = verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, b64u.dec(s));
  return ok ? JSON.parse(b64u.dec(c).toString('utf8')) : null;
}

function deriveKeys({ uaPublic, asPublic, shared, authSecret, salt }) {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  return { cek, nonce };
}

/**
 * Enkripsi isi push untuk satu langganan (satu record, tanpa padding).
 * `_test` hanya untuk vektor uji RFC 8291: kunci server sementara dan salt tetap.
 */
export function encryptPayload(plaintext, { p256dh, auth }, _test = {}) {
  const uaPublic = b64u.dec(p256dh);
  const authSecret = b64u.dec(auth);
  if (uaPublic.length !== 65) throw new Error('kunci p256dh langganan tidak sah');
  if (authSecret.length !== 16) throw new Error('rahasia auth langganan tidak sah');
  const ecdh = createECDH('prime256v1');
  if (_test.asPrivateKey) ecdh.setPrivateKey(b64u.dec(_test.asPrivateKey)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = _test.salt ? b64u.dec(_test.salt) : randomBytes(16);
  const { cek, nonce } = deriveKeys({ uaPublic, asPublic, shared, authSecret, salt });
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // 0x02 = record terakhir
  if (data.length + 16 > RS) throw new Error('isi notifikasi terlalu panjang');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(RS);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Dekripsi di sisi penerima (meniru peramban; dipakai uji). */
export function decryptPayload(buf, { uaPrivateKey, auth }) {
  const salt = buf.subarray(0, 16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const ct = buf.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(b64u.dec(uaPrivateKey));
  const uaPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(asPublic);
  const { cek, nonce } = deriveKeys({ uaPublic, asPublic, shared, authSecret: b64u.dec(auth), salt });
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = out.length - 1;
  while (end >= 0 && out[end] === 0) end--;
  if (out[end] !== 2) throw new Error('pembatas record tidak sah');
  return out.subarray(0, end);
}
