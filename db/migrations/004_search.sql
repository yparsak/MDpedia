-- Phase 4: keyword search (brainstorm 5.1, 5.15). Three tables.
--
-- doc_terms     the hand-typed (later AI-written) search metadata of a doc:
--               keywords with a weight of 1 to 3, key phrases, synonyms and
--               questions. The body, title and summary are searched on docs itself.
-- search_log    one row per search a reader typed, and the doc they opened from
--               the results. No IP address and no session id, on purpose.
-- search_daily  the same searches counted per day, so the 30-day miss rate
--               (brainstorm 5.1) survives the log being pruned by age.

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

INSERT IGNORE INTO schema_migrations (version) VALUES ('004_search');
