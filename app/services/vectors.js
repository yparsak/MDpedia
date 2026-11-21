// Vector search over published docs (roadmap Phase 11): what is embedded, how a
// document's vector is stored, how much of the wiki has a current vector, and the
// nearest-neighbour search the lab and compare pages run.
//
// Two ways to run the search, so the lab can compare them (11a and 11b):
//   scan   the distance is wrapped in "+ 0". An expression around the distance
//          defeats the vector index, so MariaDB computes it for every row: an exact
//          scan, identical with or without the index.
//   index  the bare ORDER BY VEC_DISTANCE_COSINE(...) LIMIT n that the index serves.
//          The index cannot be combined with a filter on another table, so it runs
//          in a subquery that over-fetches, and the published and model filters
//          apply to its rows afterwards. If more than the extra rows are unpublished
//          or from another model, the page can come back short; the lab says so.
// Unpublished docs are excluded in the same statement in both, so neither leaks them.

import { EmbedError } from './embed-provider.js';
import { buildEmbedText, embedInputHash, vectorLiteral } from './embed-text.js';

export const INDEX_NAME = 'idx_doc_vectors_embedding';
export const LAB_LIMIT = 10;
const OVERFETCH = 40;

// ------------------------------------------------------------------ inputs

// The published docs with the data the embedded text is built from, as
// Map(doc id -> { id, title, summary, keywords, questions }). docId limits it to one.
export async function loadEmbedInputs(pool, { docId = null } = {}) {
  const docFilter = docId === null ? '' : ' AND id = ?';
  const termFilter = docId === null ? '' : ' AND doc_id = ?';
  const params = docId === null ? [] : [docId];
  const [docs] = await pool.query(`SELECT id, title, summary FROM docs WHERE published = 1${docFilter}`, params);
  const [terms] = await pool.query(
    `SELECT doc_id, kind, term FROM doc_terms WHERE kind IN ('keyword', 'question')${termFilter} ORDER BY doc_id, kind, weight DESC, term`,
    params,
  );
  const inputs = new Map(docs.map((d) => [d.id, { id: d.id, title: d.title, summary: d.summary ?? '', keywords: [], questions: [] }]));
  for (const { doc_id: id, kind, term } of terms) {
    const input = inputs.get(id);
    if (input) input[kind === 'keyword' ? 'keywords' : 'questions'].push(term);
  }
  return inputs;
}

// ---------------------------------------------------------------- embedding

// Embeds one doc and stores the vector. Resolves to 'embedded', 'unchanged' (the
// stored vector already matches the text and settings) or 'skipped' (the doc is
// gone or not published). Throws EmbedError when the model fails.
export async function embedDocument(pool, config, embedder, docId) {
  const input = (await loadEmbedInputs(pool, { docId })).get(docId);
  if (!input) return 'skipped';

  const text = buildEmbedText(input);
  const hash = embedInputHash(text, config.embed);
  const [existing] = await pool.query('SELECT input_hash, model, pooling FROM doc_vectors WHERE doc_id = ?', [docId]);
  const row = existing[0];
  if (row && row.input_hash === hash && row.model === config.embed.model && row.pooling === config.embed.pooling) return 'unchanged';

  const { vectors } = await embedder.embed([text], 'document');
  let literal;
  try {
    literal = vectorLiteral(vectors[0], config.embed.dimensions);
  } catch (err) {
    throw new EmbedError(err.message);
  }
  await pool.query(
    `INSERT INTO doc_vectors (doc_id, embedding, model, pooling, input_hash) VALUES (?, VEC_FromText(?), ?, ?, ?)
     ON DUPLICATE KEY UPDATE embedding = VALUES(embedding), model = VALUES(model), pooling = VALUES(pooling), input_hash = VALUES(input_hash)`,
    [docId, literal, config.embed.model, config.embed.pooling, hash],
  );
  return 'embedded';
}

// ------------------------------------------------------------------- status

// How many published docs have a current vector: { published, current, stale,
// missing, orphans }. stale is a vector made from older text or other settings;
// orphans are vectors of docs that are no longer published (kept, never searched).
export async function vectorCoverage(pool, config) {
  const inputs = await loadEmbedInputs(pool);
  const [rows] = await pool.query('SELECT doc_id, model, pooling, input_hash FROM doc_vectors');
  const stored = new Map(rows.map((r) => [r.doc_id, r]));
  let current = 0;
  let stale = 0;
  for (const input of inputs.values()) {
    const row = stored.get(input.id);
    if (!row) continue;
    const hash = embedInputHash(buildEmbedText(input), config.embed);
    if (row.input_hash === hash && row.model === config.embed.model && row.pooling === config.embed.pooling) current += 1;
    else stale += 1;
  }
  return {
    published: inputs.size,
    current,
    stale,
    missing: inputs.size - current - stale,
    orphans: rows.filter((r) => !inputs.has(r.doc_id)).length,
  };
}

// { queued, running, done, failed } for the embed jobs only.
export async function embedJobCounts(pool) {
  const [rows] = await pool.query("SELECT status, COUNT(*) AS n FROM jobs WHERE type = 'embed' GROUP BY status");
  const counts = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const { status, n } of rows) counts[status] = Number(n);
  return counts;
}

export async function hasVectorIndex(pool) {
  const [[{ n }]] = await pool.query(
    'SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
    ['doc_vectors', INDEX_NAME],
  );
  return Number(n) > 0;
}

// ------------------------------------------------------------------- search

const SCAN_SQL = `SELECT d.id, d.slug, d.title, d.summary,
       VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(?)) AS distance
  FROM doc_vectors v JOIN docs d ON d.id = v.doc_id
 WHERE d.published = 1 AND v.model = ? AND v.pooling = ?
 ORDER BY VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(?)) + 0
 LIMIT ?`;

const INDEX_SQL = `SELECT d.id, d.slug, d.title, d.summary, c.distance
  FROM (SELECT v.doc_id, v.model, v.pooling, VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(?)) AS distance
          FROM doc_vectors v
         ORDER BY VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(?))
         LIMIT ?) c
  JOIN docs d ON d.id = c.doc_id
 WHERE d.published = 1 AND c.model = ? AND c.pooling = ?
 ORDER BY c.distance
 LIMIT ?`;

// The statement as the page shows it: values in place, vectors abbreviated.
function showSql(sql, params) {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const value = params[i++];
    if (typeof value === 'number') return String(value);
    return /^\[[-\d.e,]{40,}/.test(value) ? "'[0.0123, ...]'" : `'${String(value).replace(/'/g, "''")}'`;
  });
}

// queryVector: the query's embedding (an array of numbers). mode: 'scan' or 'index'.
// Resolves to { mode, rows: [{ id, slug, title, summary, distance }], sql, plan, ms }.
// distance is cosine distance, 0 for the same direction (smaller is nearer).
export async function searchVectors(pool, config, queryVector, { limit = LAB_LIMIT, mode = 'scan' } = {}) {
  const literal = vectorLiteral(queryVector, config.embed.dimensions);
  const { model, pooling } = config.embed;
  const sql = mode === 'index' ? INDEX_SQL : SCAN_SQL;
  const params =
    mode === 'index'
      ? [literal, literal, limit + OVERFETCH, model, pooling, limit]
      : [literal, model, pooling, literal, limit];

  const started = performance.now();
  const [rows] = await pool.query(sql, params);
  const ms = Math.round((performance.now() - started) * 10) / 10;

  const [plan] = await pool.query(`EXPLAIN ${sql}`, params);
  return {
    mode,
    rows: rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title, summary: r.summary ?? '', distance: Number(r.distance) })),
    sql: showSql(sql, params),
    plan: plan.map((p) => ({
      table: p.table ?? '',
      type: p.type ?? '',
      key: p.key ?? '',
      rows: p.rows ?? '',
      extra: p.Extra ?? '',
    })),
    ms,
  };
}
