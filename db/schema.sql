-- Full current schema for a fresh install (after Phase 0).
-- Regenerate with `make schema-dump` after every phase. The first dump will
-- reformat this file into mariadb-dump's style; that is expected. Commit that
-- version as the baseline, and later runs should then leave it unchanged.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(100) NOT NULL,
  applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('000_schema_migrations');
