-- Fase 2: Web Push, antrean luring, ringkasan harian.

-- @all
-- Langganan Web Push per perangkat. Endpoint dan kunci dienkripsi; endpoint_hash untuk unik/cari.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(id),
  endpoint_hash TEXT NOT NULL UNIQUE,
  endpoint_enc TEXT NOT NULL,
  p256dh_enc TEXT NOT NULL,
  auth_enc TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT
);
CREATE INDEX push_subscriptions_person_idx ON push_subscriptions(person_id);

-- Tindakan yang dikirim ulang dari antrean luring: op_id dari perangkat menjamin tidak tercatat dua kali.
CREATE TABLE client_ops (
  op_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  card_code TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Kanal ringkasan harian per orang: auto = push bila berlangganan, selain itu WA.
ALTER TABLE people ADD COLUMN digest_channel TEXT NOT NULL DEFAULT 'auto' CHECK (digest_channel IN ('auto','push','wa','off'));
