-- Phase 11a: vector search lab (roadmap 5a). Needs MariaDB 11.7 or later (the native VECTOR type);
-- MariaDB 11.8 LTS is the target.
--
-- doc_vectors   one row per document (no chunking): the embedding of a short text built from the
--               title, summary, keywords and questions. The column is VECTOR(384), fixed by the
--               model (bge-small-en-v1.5): a model with another size needs a new migration and a
--               full re-embed. model and pooling are stored per row; the lab only compares a query
--               with rows made by the same model and pooling. input_hash is the SHA-256 of the
--               embedded text plus the model settings, so a job can tell that nothing changed.
--               The row goes when its document does. No index yet: 011 searches by exact scan
--               (012_vector_index adds the index).

CREATE TABLE IF NOT EXISTS doc_vectors (
  doc_id     INT UNSIGNED NOT NULL,
  embedding  VECTOR(384)  NOT NULL,
  model      VARCHAR(200) NOT NULL,
  pooling    VARCHAR(10)  NOT NULL,
  input_hash CHAR(64)     NOT NULL,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (doc_id),
  CONSTRAINT fk_doc_vectors_doc FOREIGN KEY (doc_id) REFERENCES docs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES ('011_vectors');
