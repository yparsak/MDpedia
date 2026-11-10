-- Phase 5: wiki links (brainstorm 5.9). One table.
--
-- doc_links     which `[[slug]]` targets each doc contains. target_slug is the
--               normalised text the author typed (trimmed, lowercase), so a
--               forward reference to a doc that does not exist yet is stored
--               too. There is no target id: slugs are unique and permanent, so
--               joining on docs.slug gives the target, and a link starts to
--               resolve the moment a doc with that slug exists. It is the
--               source of "what links here" and of the unresolved-links report.

CREATE TABLE IF NOT EXISTS doc_links (
  source_doc_id INT UNSIGNED NOT NULL,
  target_slug   VARCHAR(200) NOT NULL,
  PRIMARY KEY (source_doc_id, target_slug),
  KEY idx_doc_links_target (target_slug),
  CONSTRAINT fk_doc_links_source FOREIGN KEY (source_doc_id) REFERENCES docs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('005_links');
