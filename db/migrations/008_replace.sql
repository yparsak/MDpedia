-- Phase 8: replace and reconcile.
--
-- docs.file_size, file_mtime_ms
--                      the size and modified time of the file as the reconciliation
--                      scan last saw it. A scan reads a file only when these differ.
-- docs.attention       NULL for a healthy doc, otherwise why it needs the admin:
--                      invalid (front matter or id/slug changed by hand) or missing
--                      (the file is gone). The row keeps its last good state and
--                      readers keep seeing it. attention_reason is the sentence shown.
-- docs.staged_*        the one staged replacement a doc may have. The file is
--                      STAGING_DIR/replace-<id>.md. staged_status is processing
--                      (the AI is refreshing its keywords), ready, or failed.
--                      staged_hash is the body hash of the staged file.
-- file_issues          files in the docs directory the scan refused: a second file
--                      claiming a doc's id, a stray file, an unreadable new file.
--                      Rewritten by every scan; one row per file name.
-- reconcile_state      one row: when the last scan ran and what it did.

ALTER TABLE docs
  ADD COLUMN IF NOT EXISTS file_size        INT UNSIGNED    NULL,
  ADD COLUMN IF NOT EXISTS file_mtime_ms    BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS attention        VARCHAR(20)     NULL,
  ADD COLUMN IF NOT EXISTS attention_reason VARCHAR(300)    NULL,
  ADD COLUMN IF NOT EXISTS attention_at     DATETIME        NULL,
  ADD COLUMN IF NOT EXISTS staged_at        DATETIME        NULL,
  ADD COLUMN IF NOT EXISTS staged_status    VARCHAR(20)     NULL,
  ADD COLUMN IF NOT EXISTS staged_hash      CHAR(64)        NULL,
  ADD COLUMN IF NOT EXISTS staged_size      INT UNSIGNED    NULL,
  ADD INDEX IF NOT EXISTS idx_docs_attention (attention),
  ADD INDEX IF NOT EXISTS idx_docs_staged (staged_at);

CREATE TABLE IF NOT EXISTS file_issues (
  file_name   VARCHAR(255) NOT NULL,
  -- duplicate-id, duplicate-slug, untracked, unreadable, bad-name
  kind        VARCHAR(20)  NOT NULL,
  doc_id      INT UNSIGNED NULL,
  reason      VARCHAR(300) NOT NULL,
  detected_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (file_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reconcile_state (
  id           TINYINT UNSIGNED NOT NULL,
  last_run_at  DATETIME         NULL,
  last_trigger VARCHAR(20)      NULL,
  files_seen   INT UNSIGNED     NOT NULL DEFAULT 0,
  files_read   INT UNSIGNED     NOT NULL DEFAULT 0,
  docs_updated INT UNSIGNED     NOT NULL DEFAULT 0,
  duration_ms  INT UNSIGNED     NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO reconcile_state (id) VALUES (1);

INSERT IGNORE INTO schema_migrations (version) VALUES ('008_replace');
