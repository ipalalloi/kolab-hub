-- Kolab-Hub skema awal (MVP).
-- Bagian ditandai `-- @all`, `-- @sqlite`, atau `-- @pg`. Token {{SERIAL}} diganti per dialek.
-- Waktu disimpan sebagai teks ISO-8601 UTC agar portabel.

-- @all
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 30 AND 365),
  created_at TEXT NOT NULL
);

-- Orang = identitas lintas workspace (satu nomor WA bisnis untuk semua proyek).
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone_enc TEXT,
  phone_hash TEXT UNIQUE,
  verified_at TEXT,
  consent_at TEXT,
  consent_version TEXT,
  erased_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  role TEXT NOT NULL CHECK (role IN ('owner','coordinator','collaborator','viewer')),
  availability TEXT NOT NULL DEFAULT 'tersedia' CHECK (availability IN ('tersedia','sibuk','cuti')),
  skills TEXT NOT NULL DEFAULT '',
  wip_limit INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (workspace_id, person_id)
);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  columns TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  created_at TEXT NOT NULL
);

-- Proyeksi kartu (read model). Sumber kebenaran tetap tabel events.
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  board_id TEXT NOT NULL REFERENCES boards(id),
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee_id TEXT,
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  column_key TEXT NOT NULL DEFAULT 'masuk',
  progress INTEGER NOT NULL DEFAULT 0,
  hold_reason TEXT,
  needs_review INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX cards_board_idx ON cards(board_id, column_key);
CREATE INDEX cards_assignee_idx ON cards(assignee_id, column_key);

CREATE TABLE events (
  seq {{SERIAL}},
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  card_id TEXT,
  type TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web','wa','pwa','system')),
  actor_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  wa_message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX events_card_idx ON events(card_id, seq);
CREATE INDEX events_ws_idx ON events(workspace_id, seq);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  title TEXT NOT NULL,
  wa_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'baru' CHECK (status IN ('baru','diterima','ditolak')),
  card_id TEXT,
  decided_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE wa_messages (
  meta_id TEXT PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  person_id TEXT,
  workspace_id TEXT,
  card_id TEXT,
  msg_type TEXT NOT NULL,
  body_enc TEXT,
  media TEXT,
  context_id TEXT,
  parsed TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  content_purged_at TEXT
);
CREATE INDEX wa_messages_phone_idx ON wa_messages(phone_hash, received_at);
CREATE INDEX wa_messages_status_idx ON wa_messages(status);

CREATE TABLE wa_outbox (
  id TEXT PRIMARY KEY,
  person_id TEXT,
  phone_hash TEXT NOT NULL,
  to_enc TEXT,
  workspace_id TEXT,
  card_id TEXT,
  kind TEXT NOT NULL,
  body_enc TEXT,
  template TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  content_purged_at TEXT
);
CREATE INDEX wa_outbox_provider_idx ON wa_outbox(provider_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX jobs_ready_idx ON jobs(status, run_at);

CREATE TABLE audit_log (
  seq {{SERIAL}},
  workspace_id TEXT,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE otp_codes (
  id TEXT PRIMARY KEY,
  phone_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX otp_phone_idx ON otp_codes(phone_hash, purpose);

-- Register transfer data lintas negara (UU PDP Pasal 56, PP 33/2026).
CREATE TABLE data_transfers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  country TEXT NOT NULL,
  recipient TEXT NOT NULL,
  data_categories TEXT NOT NULL,
  instrument TEXT NOT NULL,
  next_review TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Event log dan audit log append-only: UPDATE/DELETE ditolak di tingkat basis data.
-- @sqlite
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events append-only'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit append-only'); END;

-- @pg
CREATE OR REPLACE FUNCTION kolab_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% append-only', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION kolab_append_only();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION kolab_append_only();
