-- Undoes 012. The vectors stay; only the index goes.

ALTER TABLE doc_vectors DROP INDEX idx_doc_vectors_embedding;

DELETE FROM schema_migrations WHERE version = '012_vector_index';
