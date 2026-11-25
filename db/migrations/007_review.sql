-- Phase 7: review and bulk import.
--
-- docs.approved_at          when the admin approved the doc on the review screen
--                           (or through bulk approve). NULL until then.
-- docs.size_bytes           the size of the uploaded file, so the review exceptions
--                           can flag a doc that is over the upload cap (the cap may
--                           have been lowered since).
-- category_proposals.source_value
--                           for a proposal that came from a file's `categories:`
--                           line, the value as written (for example
--                           physics/quantum-mechanics), shown on the review screen.
-- ai_state.extra_calls      the one-time allowance above AI_DAILY_CAP that a bulk
--                           import grants. Each call past the cap spends one.
-- import_batches            one row per bulk import.
-- import_batch_items        one row per file in it: the slug it got, or why it was
--                           skipped. Together they are the import report.

ALTER TABLE docs
  ADD COLUMN IF NOT EXISTS approved_at DATETIME     NULL,
  ADD COLUMN IF NOT EXISTS size_bytes  INT UNSIGNED NULL;

ALTER TABLE category_proposals
  ADD COLUMN IF NOT EXISTS source_value VARCHAR(200) NULL;

ALTER TABLE ai_state
  ADD COLUMN IF NOT EXISTS extra_calls INT UNSIGNED NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS import_batches (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor      VARCHAR(64)  NOT NULL,
  file_count INT UNSIGNED NOT NULL DEFAULT 0,
  imported   INT UNSIGNED NOT NULL DEFAULT 0,
  skipped    INT UNSIGNED NOT NULL DEFAULT 0,
  -- AI calls the import expects to use, and the allowance above the cap it granted.
  ai_calls   INT UNSIGNED NOT NULL DEFAULT 0,
  extra_calls INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS import_batch_items (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id  INT UNSIGNED NOT NULL,
  position  INT UNSIGNED NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  doc_id    INT UNSIGNED NULL,
  slug      VARCHAR(80)  NULL,
  -- The slug before a "-2" style suffix was added, when one was.
  base_slug VARCHAR(80)  NULL,
  status    ENUM('imported', 'skipped') NOT NULL,
  message   VARCHAR(500) NULL,
  PRIMARY KEY (id),
  KEY idx_batch_items_batch (batch_id, position),
  CONSTRAINT fk_batch_items_batch FOREIGN KEY (batch_id) REFERENCES import_batches (id) ON DELETE CASCADE,
  CONSTRAINT fk_batch_items_doc FOREIGN KEY (doc_id) REFERENCES docs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('007_review');
