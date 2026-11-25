// Pure helpers for vector search: the text that is embedded for a
// document, the hash that says whether it changed, the prefix rule and the
// literal MariaDB reads a vector from. No imports from the app, so they can be
// tested without a database.

import crypto from 'node:crypto';

// bge-small-en-v1.5 reads at most 512 tokens. About 4 characters a token, so the
// text is cut well inside the window; the tokenizer would truncate anyway.
export const EMBED_TEXT_MAX_CHARS = 2000;

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// One short text per document, from data the app already has: title, summary,
// keywords and questions (no body, so no chunking). keywords and questions are
// arrays of strings. Questions come last, so a cut loses the least useful part.
export function buildEmbedText({ title, summary, keywords = [], questions = [] }) {
  const parts = [oneLine(title), oneLine(summary)];
  if (keywords.length > 0) parts.push(`Keywords: ${keywords.map(oneLine).join(', ')}`);
  if (questions.length > 0) parts.push(`Questions: ${questions.map(oneLine).join(' ')}`);
  return parts.filter((part) => part !== '').join('\n').slice(0, EMBED_TEXT_MAX_CHARS);
}

// The prefix and the text are joined by one space; an empty prefix adds nothing.
export const applyPrefix = (prefix, text) => (prefix ? `${prefix} ${text}` : text);

// Changes whenever the text or anything that shapes the vector changes, so a
// changed model, dtype, pooling or prefix makes every stored vector stale.
export function embedInputHash(text, embed) {
  const settings = [embed.model, embed.dtype, embed.pooling, embed.docPrefix, text];
  return crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex');
}

// "[0.1,0.2,...]", the text VEC_FromText() reads. Throws on a wrong length or a
// non-finite number, so a bad vector never reaches the database.
export function vectorLiteral(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new Error(`Expected a vector of ${dimensions} numbers, got ${Array.isArray(vector) ? vector.length : typeof vector}.`);
  }
  if (!vector.every((n) => Number.isFinite(n))) throw new Error('The vector holds a number that is not finite.');
  return `[${vector.join(',')}]`;
}
