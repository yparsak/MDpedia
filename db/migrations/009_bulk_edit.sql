-- Phase 9: bulk AI edit.
--
-- edit_batches       one row per bulk edit: the instruction, the scope it was run
--                    over (JSON text, for the record), the prompt version, and the
--                    AI calls the confirmation expected and the allowance above the
--                    daily cap it granted. status is running or stopped; "finished"
--                    is worked out from the docs (nothing queued or running).
-- edit_batch_docs    one row per document in a batch: its job, its status and the
--                    check result. Each result is a staged version (Phase 8, the
--                    docs.staged_* columns); proposal_hash is the body hash of the
--                    staged file this row refers to, so a staged version that was
--                    replaced or discarded elsewhere is noticed.
--                    status: queued, running, ready (a proposal is staged), attention
--                    (rejected by the add-only check or the self-check after the
--                    retries), failed (the job errored), approved, rejected, cancelled.
--
-- jobs.type gains the value `edit`; the column is free text, so nothing changes there.

CREATE TABLE IF NOT EXISTS edit_batches (
  id             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  actor          VARCHAR(64)   NOT NULL,
  instruction    VARCHAR(2000) NOT NULL,
  scope          VARCHAR(2000) NOT NULL,
  status         ENUM('running', 'stopped') NOT NULL DEFAULT 'running',
  prompt_version VARCHAR(20)   NOT NULL,
  max_retries    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ai_calls       INT UNSIGNED  NOT NULL DEFAULT 0,
  extra_calls    INT UNSIGNED  NOT NULL DEFAULT 0,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  stopped_at     DATETIME      NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS edit_batch_docs (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id      INT UNSIGNED NOT NULL,
  doc_id        INT UNSIGNED NOT NULL,
  job_id        INT UNSIGNED NULL,
  position      INT UNSIGNED NOT NULL,
  status        ENUM('queued', 'running', 'ready', 'attention', 'failed', 'approved', 'rejected', 'cancelled') NOT NULL DEFAULT 'queued',
  proposal_hash CHAR(64)     NULL,
  added_lines   INT UNSIGNED NULL,
  -- AI calls this doc used (edits and self-checks), and how many edit tries it took.
  ai_calls      INT UNSIGNED NOT NULL DEFAULT 0,
  -- Why the doc needs attention or failed, or a note. Never document text.
  message       VARCHAR(500) NULL,
  -- The self-check's verdict and its reason, in one short sentence.
  check_result  VARCHAR(500) NULL,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_edit_batch_doc (batch_id, doc_id),
  KEY idx_edit_batch_docs_job (job_id),
  KEY idx_edit_batch_docs_doc (doc_id, status),
  CONSTRAINT fk_edit_docs_batch FOREIGN KEY (batch_id) REFERENCES edit_batches (id) ON DELETE CASCADE,
  CONSTRAINT fk_edit_docs_doc FOREIGN KEY (doc_id) REFERENCES docs (id) ON DELETE CASCADE,
  CONSTRAINT fk_edit_docs_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('009_bulk_edit');
