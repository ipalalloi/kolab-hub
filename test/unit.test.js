import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/wa/parser.js';
import { makeCrypto, verifyMetaSignature, hmacHex } from '../src/lib/crypto.js';
import { replay } from '../src/domain/reducer.js';
import { normalizePhone } from '../src/lib/util.js';
import { renderMigration } from '../src/db/migrate.js';

test('parser: perintah kartu inti', () => {
  assert.deepEqual(parseMessage('#DIS-0142 mulai'), { kind: 'card', code: 'DIS-0142', action: 'mulai', args: {} });
  assert.deepEqual(parseMessage('#dis-142 Mulai'), { kind: 'card', code: 'DIS-0142', action: 'mulai', args: {} });
  assert.deepEqual(parseMessage('#DIS-0142 50% sudah survei 3 lokasi'), { kind: 'card', code: 'DIS-0142', action: 'progres', args: { percent: 50, note: 'sudah survei 3 lokasi' } });
  assert.deepEqual(parseMessage('#DIS-0142 progres 70 hampir'), { kind: 'card', code: 'DIS-0142', action: 'progres', args: { percent: 70, note: 'hampir' } });
  assert.deepEqual(parseMessage('#DIS-0142 selesai laporan terlampir'), { kind: 'card', code: 'DIS-0142', action: 'selesai', args: { note: 'laporan terlampir' } });
  assert.deepEqual(parseMessage('#DIS-0142 tahan menunggu izin'), { kind: 'card', code: 'DIS-0142', action: 'tahan', args: { reason: 'menunggu izin' } });
  assert.deepEqual(parseMessage('#DIS-0142 tahan'), { kind: 'card', code: 'DIS-0142', action: 'tahan', args: { reason: '' } });
  assert.deepEqual(parseMessage('#DIS-0142 2 lokasi tersisa'), { kind: 'card', code: 'DIS-0142', action: 'komentar', args: { text: '2 lokasi tersisa' } });
  assert.deepEqual(parseMessage('#DIS0142'), { kind: 'card', code: 'DIS-0142', action: null, args: {} });
});

test('parser: perintah umum dan konteks', () => {
  assert.equal(parseMessage('#tugasku').kind, 'mytasks');
  assert.equal(parseMessage('#bantuan').kind, 'help');
  assert.deepEqual(parseMessage('#baru DIS Rapat pembimbing'), { kind: 'new', prefixCandidate: 'DIS', titleIfPrefix: 'Rapat pembimbing', title: 'DIS Rapat pembimbing' });
  assert.deepEqual(parseMessage('selesai'), { kind: 'contextual', action: 'selesai', args: { note: '' } });
  assert.deepEqual(parseMessage('60%'), { kind: 'contextual', action: 'progres', args: { percent: 60, note: '' } });
  assert.equal(parseMessage('halo pak, besok saya ke lokasi').kind, 'unknown');
  assert.equal(parseMessage('   ').kind, 'empty');
});

test('kripto: enkripsi kolom, blind index, tanda tangan Meta', () => {
  const c = makeCrypto({ encryption: Buffer.alloc(32, 1).toString('base64'), blindIndex: Buffer.alloc(32, 2).toString('base64') });
  const enc = c.encrypt('6281234');
  assert.notEqual(enc, '6281234');
  assert.notEqual(c.encrypt('6281234'), enc, 'IV acak');
  assert.equal(c.decrypt(enc), '6281234');
  assert.equal(c.blindIndex('6281234'), c.blindIndex('6281234'));
  const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A') + '=';
  assert.throws(() => c.decrypt(tampered));
  const body = Buffer.from('{"a":1}');
  assert.equal(verifyMetaSignature('rahasia', body, `sha256=${hmacHex('rahasia', body)}`), true);
  assert.equal(verifyMetaSignature('rahasia', body, `sha256=${hmacHex('lain', body)}`), false);
  assert.equal(verifyMetaSignature('rahasia', body, undefined), false);
});

test('normalisasi nomor', () => {
  assert.equal(normalizePhone('0812-3456-789'), '628123456789');
  assert.equal(normalizePhone('+62 812 3456 789'), '628123456789');
  assert.equal(normalizePhone('abc'), null);
});

test('reducer: putar ulang event dan pembatalan', () => {
  const evs = [
    { seq: 1, type: 'card.created', payload: { title: 'A' } },
    { seq: 2, type: 'card.started', payload: {} },
    { seq: 3, type: 'card.progress', payload: { percent: 40 } },
    { seq: 4, type: 'card.held', payload: { reason: 'hujan' } },
  ];
  let s = replay(evs);
  assert.equal(s.column_key, 'tertahan');
  assert.equal(s.hold_reason, 'hujan');
  assert.equal(s.progress, 40);
  s = replay([...evs, { seq: 5, type: 'card.resumed', payload: {} }]);
  assert.equal(s.column_key, 'dikerjakan');
  s = replay([...evs, { seq: 5, type: 'event.reverted', payload: { target_seq: 4 } }]);
  assert.equal(s.column_key, 'dikerjakan', 'tahan dibatalkan');
  assert.equal(s.hold_reason, null);
  s = replay([...evs.slice(0, 3), { seq: 4, type: 'card.done', payload: {} }, { seq: 5, type: 'card.approved', payload: {} }]);
  assert.equal(s.column_key, 'selesai');
  assert.equal(s.progress, 100);
});

test('migrasi dirender per dialek', () => {
  const sql = '-- @all\nCREATE TABLE x (seq {{SERIAL}});\n-- @sqlite\nSQLITE;\n-- @pg\nPG;';
  assert.match(renderMigration(sql, 'pg'), /BIGSERIAL PRIMARY KEY[\s\S]*PG;/);
  assert.doesNotMatch(renderMigration(sql, 'pg'), /SQLITE/);
  assert.match(renderMigration(sql, 'sqlite'), /AUTOINCREMENT[\s\S]*SQLITE;/);
});
