// The search metadata of one doc (brainstorm 5.2, 5.12): keywords with a weight
// of 1 to 3, key phrases, synonyms and questions. In Phase 4 the admin types
// them; the AI fills the same lists in Phase 6. They are plain text, never
// markup, and are written to the front matter first and then to `doc_terms`, the
// same order every other doc change uses (the file is canonical).
//
// In memory the four lists are
//   { keywords: [{ term, weight }], phrases: [string], synonyms: [string], questions: [string] }

import { updateDocFile } from './docfiles.js';
import { cleanLine } from './text.js';

export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 3;
export const DEFAULT_WEIGHT = 1;

// The list key, the doc_terms kind, the front matter key, a label for messages,
// and the caps: the number of entries and the length of each one.
export const TERM_LISTS = [
  { list: 'keywords', kind: 'keyword', frontMatter: 'keywords', label: 'keyword', max: 20, length: 60 },
  { list: 'phrases', kind: 'phrase', frontMatter: 'key_phrases', label: 'key phrase', max: 20, length: 100 },
  { list: 'synonyms', kind: 'synonym', frontMatter: 'synonyms', label: 'synonym', max: 30, length: 60 },
  { list: 'questions', kind: 'question', frontMatter: 'questions', label: 'question', max: 10, length: 200 },
];

export const emptyTerms = () => ({ keywords: [], phrases: [], synonyms: [], questions: [] });

// Entries that differ only in case or accents count as the same term, as the
// column collation does.
const dedupeKey = (term) => term.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const clip = (text) => (text.length > 40 ? `${text.slice(0, 40)}...` : text);

// Cleans one list: trims, drops blanks and repeats, enforces the caps. Returns
// { entries, errors }. Entries are { term, weight }; the weight is 1 for every
// list but keywords.
function cleanList(spec, entries) {
  const errors = [];
  const seen = new Set();
  const kept = [];
  for (const { term: raw, weight } of entries) {
    const term = cleanLine(raw);
    if (term === '' || seen.has(dedupeKey(term))) continue;
    if (term.length > spec.length) {
      errors.push(`The ${spec.label} "${clip(term)}" is longer than ${spec.length} characters.`);
      continue;
    }
    if (kept.length >= spec.max) {
      errors.push(`At most ${spec.max} ${spec.label}s are allowed; "${clip(term)}" and any after it were left out.`);
      break;
    }
    seen.add(dedupeKey(term));
    kept.push({ term, weight: spec.kind === 'keyword' ? weight : 1 });
  }
  return { entries: kept, errors };
}

function toTerms(cleaned) {
  const terms = emptyTerms();
  for (const spec of TERM_LISTS) {
    const { entries } = cleaned[spec.list];
    terms[spec.list] = spec.kind === 'keyword' ? entries : entries.map((e) => e.term);
  }
  return terms;
}

// -------------------------------------------------------------- admin form

// One keyword per line, "term" or "term | 2". The weight is the text after the
// last bar. Returns { entries, errors }.
function keywordEntries(text) {
  const entries = [];
  const errors = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const bar = line.lastIndexOf('|');
    if (bar === -1) {
      entries.push({ term: line, weight: DEFAULT_WEIGHT });
      continue;
    }
    const term = line.slice(0, bar);
    const weightText = line.slice(bar + 1).trim();
    if (!/^\d$/.test(weightText) || Number(weightText) < WEIGHT_MIN || Number(weightText) > WEIGHT_MAX) {
      errors.push(`The weight of the keyword "${clip(cleanLine(term))}" must be ${WEIGHT_MIN}, 2 or ${WEIGHT_MAX}.`);
      continue;
    }
    entries.push({ term, weight: Number(weightText) });
  }
  return { entries, errors };
}

const plainEntries = (text) => String(text ?? '').split(/\r?\n/).map((line) => ({ term: line, weight: 1 }));

// The four textareas of the doc page: { keywords, phrases, synonyms, questions }
// as raw text. Resolves to { ok: true, terms } or { ok: false, errors }; nothing
// is saved when any line is refused.
export function parseTermForm(form) {
  const errors = [];
  const cleaned = {};
  for (const spec of TERM_LISTS) {
    const parsed = spec.kind === 'keyword' ? keywordEntries(form[spec.list]) : { entries: plainEntries(form[spec.list]), errors: [] };
    const list = cleanList(spec, parsed.entries);
    cleaned[spec.list] = list;
    errors.push(...parsed.errors, ...list.errors);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, terms: toTerms(cleaned) };
}

// The textarea contents for the current terms.
export function formatTermForm(terms) {
  return {
    keywords: terms.keywords.map((k) => `${k.term} | ${k.weight}`).join('\n'),
    phrases: terms.phrases.join('\n'),
    synonyms: terms.synonyms.join('\n'),
    questions: terms.questions.join('\n'),
  };
}

// ------------------------------------------------------------ front matter

// Reads the four lists from parsed front matter, which a person may have edited
// by hand. Lenient: anything that is too long, repeated or over the cap is
// dropped, and a bad weight becomes the default, so a file never fails on this.
export function termsFromFrontMatter(data) {
  const cleaned = {};
  for (const spec of TERM_LISTS) {
    const raw = Array.isArray(data[spec.frontMatter]) ? data[spec.frontMatter] : [];
    const entries = raw.map((item) => {
      if (typeof item === 'string') return { term: item, weight: DEFAULT_WEIGHT };
      const weight = Number.isInteger(item.weight) && item.weight >= WEIGHT_MIN && item.weight <= WEIGHT_MAX ? item.weight : DEFAULT_WEIGHT;
      return { term: item.term, weight };
    });
    cleaned[spec.list] = cleanList(spec, entries);
  }
  return toTerms(cleaned);
}

// The front matter keys for these terms; an empty list is undefined, so the key is left out.
export function termsToFrontMatter(terms) {
  const out = {};
  for (const spec of TERM_LISTS) {
    const list = terms[spec.list];
    out[spec.frontMatter] = list.length === 0 ? undefined : spec.kind === 'keyword' ? list.map((k) => ({ term: k.term, weight: k.weight })) : list;
  }
  return out;
}

// ---------------------------------------------------------------- database

const termRows = (docId, terms) =>
  TERM_LISTS.flatMap((spec) =>
    spec.kind === 'keyword'
      ? terms.keywords.map((k) => [docId, spec.kind, k.term, k.weight])
      : terms[spec.list].map((term) => [docId, spec.kind, term, 1]),
  );

// Inserts a doc's terms on a connection (a transaction of the caller's).
// INSERT IGNORE: two terms the collation treats as equal collapse into one.
export async function insertTerms(conn, docId, terms) {
  const rows = termRows(docId, terms);
  if (rows.length === 0) return;
  await conn.query('INSERT IGNORE INTO doc_terms (doc_id, kind, term, weight) VALUES ?', [rows]);
}

export async function getDocTerms(pool, docId) {
  const [rows] = await pool.query(
    'SELECT kind, term, weight FROM doc_terms WHERE doc_id = ? ORDER BY weight DESC, term',
    [docId],
  );
  const terms = emptyTerms();
  for (const { kind, term, weight } of rows) {
    if (kind === 'keyword') terms.keywords.push({ term, weight });
    else terms[TERM_LISTS.find((spec) => spec.kind === kind).list].push(term);
  }
  return terms;
}

// Replaces all of a doc's terms (already checked by parseTermForm). Throws like
// updateDocFile if the file is missing or cannot be parsed.
export async function setDocTerms(pool, config, doc, terms) {
  await updateDocFile(config, doc.slug, (data) => ({ ...data, ...termsToFrontMatter(terms) }));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM doc_terms WHERE doc_id = ?', [doc.id]);
    await insertTerms(conn, doc.id, terms);
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}
