// Mencetak kunci acak untuk .env. Jalankan di VPS, salin hasilnya langsung ke .env — jangan ke chat atau repo.
import { randomBytes } from 'node:crypto';
const k = () => randomBytes(32).toString('base64');
console.log(`ENCRYPTION_KEY=${k()}`);
console.log(`BLIND_INDEX_KEY=${k()}`);
console.log(`SESSION_SECRET=${k()}`);
console.log(`WA_VERIFY_TOKEN=${randomBytes(18).toString('base64url')}`);
console.log(`POSTGRES_PASSWORD=${randomBytes(18).toString('base64url')}`);
