-- Phase 2: documents. One row per Markdown file in DOCS_DIR. The file is
-- canonical and this table is a derived index (brainstorm 5.3).
--
-- The FULLTEXT index needs innodb_ft_min_token_size = 2 to be in effect when it
-- is created (brainstorm 5.2). Run `make db-check` first and fix the server
-- setting if it warns, or the index has to be dropped and rebuilt later.
-- Search itself arrives in Phase 4.

CREATE TABLE IF NOT EXISTS docs (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug           VARCHAR(80)  NOT NULL,
  title          VARCHAR(200) NOT NULL,
  -- ready (ready for review), published, unpublished. Later phases add more.
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
  PRIMARY KEY (id),
  UNIQUE KEY uq_docs_slug (slug),
  KEY idx_docs_status (status),
  KEY idx_docs_published_title (published, title),
  FULLTEXT KEY ft_docs_plain_text (plain_text)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('002_documents');
