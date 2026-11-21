-- Phase 11b: the vector index. DISTANCE=cosine is declared explicitly: a query that uses another
-- distance function silently ignores the index. The index is used only when the query sorts by the
-- bare VEC_DISTANCE_COSINE(...) with a LIMIT; an expression around it, or a filter on the same table,
-- makes MariaDB scan every row instead (see app/services/vectors.js, which shows both queries).
-- One vector index per table, and the table must be InnoDB with a primary key (it is).

ALTER TABLE doc_vectors ADD VECTOR INDEX idx_doc_vectors_embedding (embedding) M=8 DISTANCE=cosine;

INSERT IGNORE INTO schema_migrations (version) VALUES ('012_vector_index');
