-- Phase 0: the table that records which migrations have been applied.
-- The app compares this table with the migrations it expects and shows a
-- "database is behind" page if one is missing. It never changes the schema itself.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(100) NOT NULL,
  applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('000_schema_migrations');
