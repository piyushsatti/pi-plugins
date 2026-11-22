-- 0001_init.sql — agent-coop initial schema.
-- Source: db-design.md §1 (event log), §2 (projections), §3.2 (document_updates).
-- Attachment tables ship here (schema is A1-A12-ready per db-design G4) and v1
-- writes them: the `attachment_add` and `transcript_*` events project into
-- `attachment` (CQ1). What v1 lacks is a UI that produces those events.

-- No PRAGMAs here. `foreign_keys` is per-connection state, so a migration (run
-- once per database) is the one place it must NOT be set; src/engine/db.ts sets
-- it on every open.

-- §1 event log: the only table ever written directly.
CREATE TABLE event (
  event_id       TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  type           TEXT NOT NULL,
  payload        TEXT NOT NULL,
  client_edit_id TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE(session_id, seq)
);
CREATE INDEX idx_event_session_seq ON event(session_id, seq);
CREATE UNIQUE INDEX idx_event_client_edit_id ON event(client_edit_id) WHERE client_edit_id IS NOT NULL;

-- §2 session / document: CRUD-shaped, still written only by the reducer.
CREATE TABLE session (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE document (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  source_path TEXT,
  export_path TEXT,
  created_at  TEXT NOT NULL
);

-- §2 session_state projection (COV-F1).
CREATE TABLE session_state (
  session_id          TEXT PRIMARY KEY,
  state               TEXT NOT NULL,
  turn_started_at_seq INTEGER,
  updated_at_seq      INTEGER NOT NULL,
  created_at          TEXT NOT NULL
);

-- §2 revision: a label on a log position, never a copy.
CREATE TABLE revision (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  event_id     TEXT NOT NULL REFERENCES event(event_id),
  turn_summary TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(document_id, seq)
);
CREATE INDEX idx_revision_document_seq ON revision(document_id, seq);

-- §2 comment projection. Column names are contract-design's field names.
CREATE TABLE comment (
  comment_id        TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  doc_id            TEXT REFERENCES document(id) ON DELETE CASCADE,
  block_id          TEXT,
  relative_position TEXT,
  quoted_text       TEXT,
  text              TEXT NOT NULL,
  delivery          TEXT NOT NULL DEFAULT 'queued',
  parent_id         TEXT REFERENCES comment(comment_id),
  status            TEXT NOT NULL DEFAULT 'open',
  resolved_by       TEXT,
  anchor_state      TEXT NOT NULL DEFAULT 'attached',
  created_at_seq    INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_comment_session ON comment(session_id, status);
CREATE INDEX idx_comment_block ON comment(block_id);

-- §2 attachment projection (A10). Written by the attachment_add and transcript_*
-- projections in src/engine/projections.ts.
CREATE TABLE attachment (
  attachment_id     TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  doc_id            TEXT REFERENCES document(id) ON DELETE CASCADE,
  comment_id        TEXT REFERENCES comment(comment_id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  source            TEXT NOT NULL,
  storage_path      TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  transcript_status TEXT NOT NULL DEFAULT 'n/a',
  transcript_text   TEXT,
  created_at_seq    INTEGER NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_attachment_comment ON attachment(comment_id);
CREATE INDEX idx_attachment_session ON attachment(session_id);

-- §2 SE-F8: operational bookkeeping for post-commit file deletion.
CREATE TABLE attachment_pending_gc (
  storage_path TEXT PRIMARY KEY,
  queued_at    TEXT NOT NULL
);

-- §3.2 Yjs persistence: update stream plus periodic merged snapshots.
CREATE TABLE document_updates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'update',
  "update"    BLOB NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_doc_updates_doc_seq ON document_updates(document_id, seq);

-- §2 migration + replay bookkeeping.
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE checkpoint (
  session_id       TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  last_applied_seq INTEGER NOT NULL,
  checkpointed_at  TEXT NOT NULL
);
