-- Phase 3: the category tree and the doc-to-category junction (brainstorm 5.4).
-- An adjacency list, at most three levels deep (the app enforces the depth).
-- Slugs are unique among siblings. The unique key below covers every level but
-- the top, since NULL parent_ids never collide in MariaDB; the app checks the
-- top level itself. The URL path is derived from the slugs, never stored.

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

-- position 1 is the primary category (breadcrumb and canonical URL). At most 3
-- rows per doc (the app enforces it). A category cannot be deleted while any
-- doc, in any state, points at it, hence RESTRICT.
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

INSERT IGNORE INTO schema_migrations (version) VALUES ('003_categories');
