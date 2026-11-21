-- Phase 10: operations (roadmap Phase 10, brainstorm sections 6, 7 and 5.5).
--
-- backup_status      one row (id 1): what scripts/backup.sh last did. last_success_at
--                    is set only after a verified copy; a failed attempt changes
--                    last_attempt_at, last_result and last_message and leaves
--                    last_success_at alone, so the dashboard keeps the old age.
--                    The script also writes DATA_DIR/last-backup.txt on the Pi,
--                    which the app reads when the table cannot be updated.
-- maintenance_runs   one row per task per run of the maintenance job (pruning of
--                    the search log, audit log and finished jobs). The page shows
--                    the latest row of each task; rows older than a year are
--                    removed by the job itself.

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

CREATE TABLE IF NOT EXISTS maintenance_runs (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  task           VARCHAR(40)  NOT NULL,
  started_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  duration_ms    INT UNSIGNED NOT NULL DEFAULT 0,
  trigger_source ENUM('schedule', 'manual') NOT NULL,
  status         ENUM('ok', 'failed') NOT NULL,
  rows_pruned    INT UNSIGNED NOT NULL DEFAULT 0,
  -- A short sentence; never row contents.
  message        VARCHAR(300) NULL,
  PRIMARY KEY (id),
  KEY idx_maintenance_task (task, id),
  KEY idx_maintenance_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('010_operations');
