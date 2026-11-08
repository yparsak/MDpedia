// Turning what a reader typed into search terms, and the SQL that finds them
// (brainstorm 5.15). Pure functions with no imports, so they can be tested
// without a database.
//
// Operator characters never reach SQL: a term is made only of letters and
// digits, whatever was typed. A "quoted phrase" stays together; everything else
// is split into single words.

export const QUERY_MAX_CHARS = 200;
export const QUERY_MAX_TERMS = 10;

const WORD = /[\p{L}\p{N}]+/gu;
const PIECE = /"([^"]*)"|([^"\s]+)/g;

// { terms: [{ text, phrase }], trimmed }. text is lowercase words joined by a
// space. trimmed is true when the input was cut at the character cap or the term cap.
export function parseQuery(raw) {
  const typed = String(raw ?? '');
  let trimmed = typed.length > QUERY_MAX_CHARS;
  const terms = [];
  const seen = new Set();

  const add = (text, phrase) => {
    if (seen.has(text)) return;
    if (terms.length >= QUERY_MAX_TERMS) {
      trimmed = true;
      return;
    }
    seen.add(text);
    terms.push({ text, phrase });
  };

  for (const [, quoted, bare] of typed.slice(0, QUERY_MAX_CHARS).matchAll(PIECE)) {
    const words = (quoted ?? bare).toLowerCase().match(WORD) ?? [];
    if (quoted !== undefined && words.length > 1) add(words.join(' '), true);
    else words.forEach((word) => add(word, false));
  }
  return { terms, trimmed };
}

// A one-character term (x, e) is searched only as an exact keyword: the body
// index does not hold such words (innodb_ft_min_token_size is 2).
export const isShortTerm = (term) => term.text.length < 2;

// LIKE patterns for a word or phrase that starts a word in some text: at the
// start, after a space, or after a hyphen.
export function likePatterns(text) {
  const escaped = text.replace(/[\\%_]/g, '\\$&');
  return [`${escaped}%`, `% ${escaped}%`, `%-${escaped}%`];
}

// The InnoDB boolean-mode query for the body: a phrase in quotes, a word as a prefix.
export const bodyQuery = (term) => (term.phrase ? `"${term.text}"` : `${term.text}*`);

// Weights from config.search.weights. 0 switches a source off entirely.
const KINDS = [
  ['keyword', 'keyword'],
  ['phrase', 'phrase'],
  ['synonym', 'synonym'],
  ['question', 'question'],
];

// The five columns every branch of the union returns, in this order. index is a
// loop counter and source a fixed word or column, never user input.
const columns = (index, source, weight) =>
  `${index} AS term_index, ${source} AS source, ${weight} AS weight, d.id AS doc_id, d.updated_at AS updated_at`;

const likeAny = (column) => `(${column} LIKE ? OR ${column} LIKE ? OR ${column} LIKE ?)`;

// One UNION ALL query for every term: each row says "this published doc matched
// term N through this source". Columns: term_index, source, weight, doc_id,
// updated_at. Returns null when nothing can be searched.
export function buildMatchQuery(terms, weights) {
  const kinds = KINDS.filter(([, key]) => weights[key] > 0).map(([kind]) => kind);
  const parts = [];
  const params = [];

  terms.forEach((term, index) => {
    if (isShortTerm(term)) {
      if (!kinds.includes('keyword')) return;
      parts.push(
        `SELECT ${columns(index, "'keyword'", 't.weight')}
           FROM doc_terms t JOIN docs d ON d.id = t.doc_id
          WHERE d.published = 1 AND t.kind = 'keyword' AND t.term = ?`,
      );
      params.push(term.text);
      return;
    }

    const patterns = likePatterns(term.text);
    for (const [source, column] of [['title', 'd.title'], ['summary', 'd.summary']]) {
      if (!(weights[source] > 0)) continue;
      parts.push(
        `SELECT ${columns(index, `'${source}'`, 1)} FROM docs d WHERE d.published = 1 AND ${likeAny(column)}`,
      );
      params.push(...patterns);
    }
    if (kinds.length > 0) {
      parts.push(
        `SELECT ${columns(index, 't.kind', 't.weight')}
           FROM doc_terms t JOIN docs d ON d.id = t.doc_id
          WHERE d.published = 1 AND t.kind IN (${kinds.map(() => '?').join(', ')}) AND ${likeAny('t.term')}`,
      );
      params.push(...kinds, ...patterns);
    }
    if (weights.body > 0) {
      parts.push(
        `SELECT ${columns(index, "'body'", 1)} FROM docs d
          WHERE d.published = 1 AND MATCH(d.plain_text) AGAINST (? IN BOOLEAN MODE)`,
      );
      params.push(bodyQuery(term));
    }
  });

  return parts.length === 0 ? null : { sql: parts.join('\nUNION ALL\n'), params };
}
