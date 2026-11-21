-- Full current schema for a fresh install (after Phase 7).
-- Regenerate with `make schema-dump` after every phase. The first dump will
-- reformat this file into mariadb-dump's style; that is expected. Commit that
-- version as the baseline, and later runs should then leave it unchanged.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(100) NOT NULL,
  applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_users (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username            VARCHAR(64)  NOT NULL,
  password_hash       VARCHAR(255) NOT NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  password_changed_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at       DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- id is the SHA-256 of the cookie value, so a leaked database does not hand out
-- working sessions. csrf_token is the per-session form token.
CREATE TABLE IF NOT EXISTS sessions (
  id           CHAR(64)     NOT NULL,
  admin_id     INT UNSIGNED NOT NULL,
  csrf_token   CHAR(64)     NOT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_sessions_admin (admin_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_admin FOREIGN KEY (admin_id) REFERENCES admin_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only: the app only ever inserts and reads. Pruning by age is Phase 10.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor       VARCHAR(64)     NOT NULL,
  action      VARCHAR(64)     NOT NULL,
  target_type VARCHAR(32)     NULL,
  target_id   VARCHAR(64)     NULL,
  summary     VARCHAR(500)    NOT NULL DEFAULT '',
  ip          VARCHAR(45)     NULL,
  PRIMARY KEY (id),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS docs (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug           VARCHAR(80)  NOT NULL,
  title          VARCHAR(200) NOT NULL,
  -- uploaded, processing, ready (ready for review), failed, published, unpublished.
  status         VARCHAR(20)  NOT NULL DEFAULT 'ready',
  published      TINYINT(1)   NOT NULL DEFAULT 0,
  summary        TEXT         NULL,
  summary_edited TINYINT(1)   NOT NULL DEFAULT 0,
  has_raw_html   TINYINT(1)   NOT NULL DEFAULT 0,
  -- SHA-256 of the body, front matter excluded.
  body_hash      CHAR(64)     NOT NULL,
  -- Sanitized, pre-rendered HTML, and the plain text (math removed) behind the index.
  html           MEDIUMTEXT   NOT NULL,
  plain_text     MEDIUMTEXT   NOT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  published_at   DATETIME     NULL,
  -- Provenance of the AI output (Phase 6).
  ai_provider       VARCHAR(50)  NULL,
  ai_model          VARCHAR(200) NULL,
  ai_prompt_version VARCHAR(20)  NULL,
  ai_at             DATETIME     NULL,
  approved_at       DATETIME     NULL,
  size_bytes        INT UNSIGNED NULL,
  -- Reconciliation and replacement (Phase 8).
  file_size         INT UNSIGNED    NULL,
  file_mtime_ms     BIGINT UNSIGNED NULL,
  attention         VARCHAR(20)     NULL,
  attention_reason  VARCHAR(300)    NULL,
  attention_at      DATETIME        NULL,
  staged_at         DATETIME        NULL,
  staged_status     VARCHAR(20)     NULL,
  staged_hash       CHAR(64)        NULL,
  staged_size       INT UNSIGNED    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_docs_slug (slug),
  KEY idx_docs_attention (attention),
  KEY idx_docs_staged (staged_at),
  KEY idx_docs_status (status),
  KEY idx_docs_published_title (published, title),
  FULLTEXT KEY ft_docs_plain_text (plain_text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Category tree: an adjacency list, at most three levels deep (enforced by the app).
CREATE TABLE IF NOT EXISTS categories (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id  INT UNSIGNED NULL,
  name       VARCHAR(100) NOT NULL,
  slug       VARCHAR(80)  NOT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_parent_slug (parent_id, slug),
  KEY idx_categories_parent_sort (parent_id, sort_order),
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- position 1 is the primary category. At most 3 rows per doc (enforced by the app).
CREATE TABLE IF NOT EXISTS doc_categories (
  doc_id      INT UNSIGNED     NOT NULL,
  category_id INT UNSIGNED     NOT NULL,
  position    TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (doc_id, category_id),
  UNIQUE KEY uq_doc_categories_position (doc_id, position),
  KEY idx_doc_categories_category (category_id),
  CONSTRAINT fk_doc_categories_doc FOREIGN KEY (doc_id) REFERENCES docs (id) ON DELETE CASCADE,
  CONSTRAINT fk_doc_categories_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Search metadata, the search log and its per-day counts (Phase 4).
CREATE TABLE IF NOT EXISTS doc_terms (
  doc_id INT UNSIGNED NOT NULL,
  kind   ENUM('keyword', 'phrase', 'synonym', 'question') NOT NULL,
  term   VARCHAR(200) NOT NULL,
  -- 1 to 3 for a keyword; always 1 for the other kinds.
  weight TINYINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (doc_id, kind, term),
  KEY idx_doc_terms_term (term),
  CONSTRAINT fk_doc_terms_doc FOREIGN KEY (doc_id) REFERENCES docs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- clicked_doc_id has no foreign key: the log must outlive whatever happens to a doc.
CREATE TABLE IF NOT EXISTS search_log (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  query_text     VARCHAR(200)    NOT NULL,
  result_count   INT UNSIGNED    NOT NULL,
  -- 1 when the page was labelled "partial matches".
  partial        TINYINT(1)      NOT NULL DEFAULT 0,
  clicked_doc_id INT UNSIGNED    NULL,
  clicked_at     DATETIME        NULL,
  PRIMARY KEY (id),
  KEY idx_search_log_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- clicked counts searches that ended in a click (the first click only), on the
-- day of the search. A search with no click is searches - clicked.
CREATE TABLE IF NOT EXISTS search_daily (
  day          DATE         NOT NULL,
  searches     INT UNSIGNED NOT NULL DEFAULT 0,
  zero_results INT UNSIGNED NOT NULL DEFAULT 0,
  clicked      INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The [[slug]] targets of each doc (Phase 5). Slugs are unique and permanent, so
-- there is no target id: docs.slug is the join.
CREATE TABLE IF NOT EXISTS doc_links (
  source_doc_id INT UNSIGNED NOT NULL,
  target_slug   VARCHAR(200) NOT NULL,
  PRIMARY KEY (source_doc_id, target_slug),
  KEY idx_doc_links_target (target_slug),
  CONSTRAINT fk_doc_links_source FOREIGN KEY (source_doc_id) REFERENCES docs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- AI extraction (Phase 6): the job queue, the daily call count, the circuit breaker,
-- the AI's category suggestions and its proposals for new categories.
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
  -- One-time allowance above the daily cap, granted by a bulk import (Phase 7).
  extra_calls          INT UNSIGNED     NOT NULL DEFAULT 0,
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
  -- For a file's `categories:` value, as written (Phase 7).
  source_value VARCHAR(200) NULL,
  status     ENUM('pending', 'accepted', 'rejected') NOT NULL DEFAULT 'pending',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_proposals_doc (doc_id),
  KEY idx_proposals_status (status),
  CONSTRAINT fk_proposals_doc FOREIGN KEY (doc_id) REFERENCES docs (id) ON DELETE CASCADE,
  CONSTRAINT fk_proposals_parent FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

-- Bulk AI edit (Phase 9).
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
  ai_calls      INT UNSIGNED NOT NULL DEFAULT 0,
  message       VARCHAR(500) NULL,
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

-- Files the reconciliation scan refused (Phase 8).
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

-- Backup status, one row (Phase 10).
CREATE TABLE IF NOT EXISTS backup_status (
  id              TINYINT UNSIGNED NOT NULL,
  last_success_at DATETIME         NULL,
  last_attempt_at DATETIME         NULL,
  last_result     ENUM('ok', 'failed') NULL,
  last_message    VARCHAR(300)     NULL,
  last_target     VARCHAR(255)     NULL,
  docs_count      INT UNSIGNED     NULL,
  dump_bytes      BIGINT UNSIGNED  NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO backup_status (id) VALUES (1);

-- One row per task per maintenance run (Phase 10).
CREATE TABLE IF NOT EXISTS maintenance_runs (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  task           VARCHAR(40)  NOT NULL,
  started_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duration_ms    INT UNSIGNED NOT NULL DEFAULT 0,
  trigger_source ENUM('schedule', 'manual') NOT NULL,
  status         ENUM('ok', 'failed') NOT NULL,
  rows_pruned    INT UNSIGNED NOT NULL DEFAULT 0,
  message        VARCHAR(300) NULL,
  PRIMARY KEY (id),
  KEY idx_maintenance_task (task, id),
  KEY idx_maintenance_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('000_schema_migrations'), ('001_admin'), ('002_documents'), ('003_categories'), ('004_search'), ('005_links'), ('006_ai'), ('007_review'), ('008_replace'), ('009_bulk_edit'), ('010_operations');
