-- Full current schema for a fresh install (after Phase 2).
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

INSERT IGNORE INTO schema_migrations (version) VALUES ('000_schema_migrations'), ('001_admin'), ('002_documents');
