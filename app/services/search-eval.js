// The evaluation page's engine (roadmap Phase 4, brainstorm 5.1, 5.18): read a
// test set of queries with the doc each should find, run them through the same
// search the readers use, and report the zero-result rate and whether the
// expected doc is in the top 3. Nothing is logged or stored: this measures the
// index and the SEARCH_WEIGHT_* values, not reader behaviour.
//
// Test set file (db/seed/search_test_set.example.json):
//   { "queries": [ { "query": "mean value theorem", "expected": "mean-value-theorem", "note": "optional" } ] }
// "expected" is a slug, or a list of slugs when several docs are right answers.

import { z } from 'zod';
import { QUERY_MAX_CHARS, parseQuery } from './search-query.js';
import { searchPublished } from './search.js';

export const EVAL_MAX_QUERIES = 200;
export const TOP_N = 3;

const slug = z.string().min(1).max(80);

const testSetSchema = z.object({
  queries: z
    .array(
      z.object({
        query: z.string().min(1).max(QUERY_MAX_CHARS),
        expected: z.union([slug, z.array(slug).min(1).max(10)]),
        note: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(EVAL_MAX_QUERIES),
});

// { ok: true, queries: [{ query, expected: [slug], note }] } or { ok: false, error }.
export function parseTestSet(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
  const checked = testSetSchema.safeParse(value);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const where = issue.path.length > 0 ? ` at "${issue.path.join('.')}"` : '';
    return { ok: false, error: `The test set is not in the expected shape${where}: ${issue.message}.` };
  }
  return {
    ok: true,
    queries: checked.data.queries.map((q) => ({
      query: q.query.trim(),
      expected: Array.isArray(q.expected) ? q.expected : [q.expected],
      note: q.note ?? '',
    })),
  };
}

// Runs every query. Resolves to { rows, summary }. A row has the query, how many
// results it returned, the 1-based rank of the best expected doc (null when it is
// not among the results) and whether that is within the top 3. An expected slug
// that is not a published doc is reported on its row, since no search could find it.
export async function runEvaluation(pool, config, queries) {
  const slugs = [...new Set(queries.flatMap((q) => q.expected))];
  const [found] = await pool.query('SELECT id, slug FROM docs WHERE slug IN (?) AND published = 1', [slugs]);
  const idBySlug = new Map(found.map((r) => [r.slug, r.id]));

  const rows = [];
  for (const q of queries) {
    const expectedIds = q.expected.map((s) => idBySlug.get(s)).filter((id) => id !== undefined);
    const { ids, partial } = await searchPublished(pool, config, parseQuery(q.query));
    const positions = expectedIds.map((id) => ids.indexOf(id)).filter((i) => i !== -1);
    const rank = positions.length > 0 ? Math.min(...positions) + 1 : null;
    rows.push({
      query: q.query,
      note: q.note,
      expected: q.expected,
      missing: q.expected.filter((s) => !idBySlug.has(s)),
      resultCount: ids.length,
      partial,
      rank,
      inTop: rank !== null && rank <= TOP_N,
    });
  }

  const total = rows.length;
  const zeroResults = rows.filter((r) => r.resultCount === 0).length;
  const inTop = rows.filter((r) => r.inTop).length;
  return {
    rows,
    summary: {
      total,
      zeroResults,
      zeroRate: total === 0 ? 0 : zeroResults / total,
      inTop,
      inTopRate: total === 0 ? 0 : inTop / total,
      unresolved: rows.filter((r) => r.missing.length > 0).length,
    },
  };
}
