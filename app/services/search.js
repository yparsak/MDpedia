// Keyword search over published docs (brainstorm 5.15). search-query.js builds
// one query that returns a row for every (doc, term, source) match; this module
// scores those rows with the source weights from .env, requires every term
// first (AND), falls back to any term (OR) when that gives too few, and orders
// the result. Unpublished docs are excluded in the SQL, so they cannot appear.
//
// A term's score in a doc is the sum, over the sources it matched, of that
// source's weight. A keyword counts its own 1 to 3 weight times the keyword
// weight, and where several rows of one kind match (two synonyms, say) only the
// best counts. A doc's score is the sum over its terms.

import { buildMatchQuery } from './search-query.js';

// Rows from buildMatchQuery into Map(doc id -> { id, updatedAt, score, matched }),
// where matched is the number of distinct terms the doc matched.
export function scoreMatches(rows, weights) {
  const sourceWeight = (row) => {
    const base = weights[row.source];
    return row.source === 'keyword' ? base * Number(row.weight) : base;
  };

  // doc id -> term index -> source -> best score
  const best = new Map();
  const updated = new Map();
  for (const row of rows) {
    const docId = Number(row.doc_id);
    const terms = best.get(docId) ?? new Map();
    const sources = terms.get(Number(row.term_index)) ?? new Map();
    sources.set(row.source, Math.max(sources.get(row.source) ?? 0, sourceWeight(row)));
    terms.set(Number(row.term_index), sources);
    best.set(docId, terms);
    updated.set(docId, String(row.updated_at));
  }

  const docs = new Map();
  for (const [id, terms] of best) {
    let score = 0;
    for (const sources of terms.values()) for (const value of sources.values()) score += value;
    docs.set(id, { id, updatedAt: updated.get(id), score, matched: terms.size });
  }
  return docs;
}

// Highest score first, then the most recently updated, then the newest id.
const byScore = (a, b) => b.score - a.score || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) || b.id - a.id;

// Picks the matches to show. With one term, or when at least `partialThreshold`
// docs match every term, only those are shown. Otherwise any doc matching some
// term is shown, ones matching more terms first, and `partial` is true.
// Resolves to { ids, partial } with at most `resultLimit` ids.
export function rankMatches(docs, termCount, { partialThreshold, resultLimit }) {
  const all = [...docs.values()];
  const full = all.filter((d) => d.matched === termCount);
  if (termCount === 1 || full.length >= partialThreshold || all.length === full.length) {
    return { ids: full.sort(byScore).slice(0, resultLimit).map((d) => d.id), partial: false };
  }
  all.sort((a, b) => b.matched - a.matched || byScore(a, b));
  return { ids: all.slice(0, resultLimit).map((d) => d.id), partial: true };
}

// parsed is the result of parseQuery. Resolves to { ids, partial } with the
// ids of the published docs in display order, at most config.search.resultLimit.
export async function searchPublished(pool, config, parsed) {
  const { weights, partialThreshold, resultLimit } = config.search;
  const query = parsed.terms.length === 0 ? null : buildMatchQuery(parsed.terms, weights);
  if (!query) return { ids: [], partial: false };
  const [rows] = await pool.query(query.sql, query.params);
  return rankMatches(scoreMatches(rows, weights), parsed.terms.length, { partialThreshold, resultLimit });
}

// The docs for one page of ids, in the order of ids.
export async function getPublishedByIds(pool, ids) {
  if (ids.length === 0) return [];
  const [rows] = await pool.query('SELECT id, slug, title, summary FROM docs WHERE id IN (?) AND published = 1', [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}
