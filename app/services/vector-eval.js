// The compare page's engine (roadmap 11c): the Phase 4 test set scored two ways,
// keyword search (the same search readers use) and vector search, with the same
// "expected doc in the top 3" measure as the evaluation page. Nothing is logged
// or stored. Vector search here is the exact scan, so the score does not depend
// on whether the index exists. The test set file and its checks are search-eval.js's.

import { TOP_N, bestRank } from './search-eval.js';
import { parseQuery } from './search-query.js';
import { searchPublished } from './search.js';
import { searchVectors } from './vectors.js';

const BATCH = 16;

// queries: the result of parseTestSet. Resolves to { rows, summary }. A row holds the
// 1-based rank of the expected doc for each method (null = not among the results).
export async function runVectorEvaluation(pool, config, embedder, queries) {
  const slugs = [...new Set(queries.flatMap((q) => q.expected))];
  const [found] = await pool.query('SELECT id, slug FROM docs WHERE slug IN (?) AND published = 1', [slugs]);
  const idBySlug = new Map(found.map((r) => [r.slug, r.id]));

  const vectors = [];
  for (let i = 0; i < queries.length; i += BATCH) {
    const batch = queries.slice(i, i + BATCH).map((q) => q.query);
    vectors.push(...(await embedder.embed(batch, 'query')).vectors);
  }

  const rows = [];
  for (const [index, q] of queries.entries()) {
    const expectedIds = q.expected.map((s) => idBySlug.get(s)).filter((id) => id !== undefined);
    const keyword = await searchPublished(pool, config, parseQuery(q.query));
    const vector = await searchVectors(pool, config, vectors[index], { limit: config.search.resultLimit, mode: 'scan' });
    const keywordRank = bestRank(expectedIds, keyword.ids);
    const vectorRank = bestRank(expectedIds, vector.rows.map((r) => r.id));
    rows.push({
      query: q.query,
      note: q.note,
      expected: q.expected,
      missing: q.expected.filter((s) => !idBySlug.has(s)),
      keywordRank,
      vectorRank,
      keywordTop: keywordRank !== null && keywordRank <= TOP_N,
      vectorTop: vectorRank !== null && vectorRank <= TOP_N,
    });
  }

  const total = rows.length;
  const count = (test) => rows.filter(test).length;
  const rate = (n) => (total === 0 ? 0 : n / total);
  const keywordTop = count((r) => r.keywordTop);
  const vectorTop = count((r) => r.vectorTop);
  return {
    rows,
    summary: {
      total,
      keywordTop,
      keywordTopRate: rate(keywordTop),
      vectorTop,
      vectorTopRate: rate(vectorTop),
      onlyKeyword: count((r) => r.keywordTop && !r.vectorTop),
      onlyVector: count((r) => !r.keywordTop && r.vectorTop),
      both: count((r) => r.keywordTop && r.vectorTop),
      neither: count((r) => !r.keywordTop && !r.vectorTop),
      unresolved: count((r) => r.missing.length > 0),
    },
  };
}
