-- Phase 6: AI extraction (brainstorm 5.5, 5.12). Five tables and the provenance columns.
--
-- jobs                      the queue. One row per AI job; attempts counts every
--                           claim, so a run interrupted by a crash counts too.
--                           last_error is short and never holds document text.
-- ai_usage_daily            AI calls made per day, against AI_DAILY_CAP.
-- ai_state                  one row: the circuit breaker (consecutive failures,
--                           and when the queue was paused and why).
-- doc_category_suggestions  the categories the AI suggests, in order. Stored, not
--                           applied: doc_categories changes only when the admin does it.
-- category_proposals        new categories the AI (or, from Phase 7, a file) wants.
--                           Never created automatically.
-- docs.ai_*                 provenance: which provider, model and prompt version
--                           produced the doc's AI output, and when.

CREATE TABLE IF NOT EXISTS jobs (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  doc_id      INT UNSIGNED  NOT NULL,
  -- ingest now; replace, re-keyword and re-suggest arrive in later phases.
  type        VARCHAR(30)   NOT NULL DEFAULT 'ingest',
  status      ENUM('queued', 'running', 'done', 'failed') NOT NULL DEFAULT 'queued',
  attempts    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_error  VARCHAR(300)  NULL,
  run_after   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at   DATETIME      NULL,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME      NULL,
  PRIMARY KEY (id),
  KEY idx_jobs_status_run (status, run_after),
  KEY idx_jobs_doc (doc_id),
  CONSTRAINT fk_jobs_doc FOREIGN KEY (doc_id) REFERENCES docs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day   DATE         NOT NULL,
  calls INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_state (
  id                   TINYINT UNSIGNED NOT NULL,
  consecutive_failures INT UNSIGNED     NOT NULL DEFAULT 0,
  paused_at            DATETIME         NULL,
  pause_reason         VARCHAR(300)     NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO ai_state (id) VALUES (1);

-- position 1 is the AI's first choice. At most 3 rows per doc (enforced by the app).
CREATE TABLE IF NOT EXISTS doc_category_suggestions (
  doc_id      INT UNSIGNED     NOT NULL,
  category_id INT UNSIGNED     NOT NULL,
  position    TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (doc_id, category_id),
  CONSTRAINT fk_suggestions_doc FOREIGN KEY (doc_id) REFERENCES docs (id) ON DELETE CASCADE,
  CONSTRAINT fk_suggestions_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- parent_id NULL proposes a new top-level category.
CREATE TABLE IF NOT EXISTS category_proposals (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_id     INT UNSIGNED NOT NULL,
  parent_id  INT UNSIGNED NULL,
  name       VARCHAR(100) NOT NULL,
  source     ENUM('ai', 'file') NOT NULL DEFAULT 'ai',
  status     ENUM('pending', 'accepted', 'rejected') NOT NULL DEFAULT 'pending',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_proposals_doc (doc_id),
  KEY idx_proposals_status (status),
  CONSTRAINT fk_proposals_doc FOREIGN KEY (doc_id) REFERENCES docs (id) ON DELETE CASCADE,
  CONSTRAINT fk_proposals_parent FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE docs
  ADD COLUMN IF NOT EXISTS ai_provider       VARCHAR(50)  NULL,
  ADD COLUMN IF NOT EXISTS ai_model          VARCHAR(200) NULL,
  ADD COLUMN IF NOT EXISTS ai_prompt_version VARCHAR(20)  NULL,
  ADD COLUMN IF NOT EXISTS ai_at             DATETIME     NULL;

INSERT IGNORE INTO schema_migrations (version) VALUES ('006_ai');
