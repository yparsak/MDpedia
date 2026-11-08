// Front matter (brainstorm 5.3, section 7). The file is canonical, so this is
// parsed with a safe YAML loader (core schema: no custom types, no objects built
// from tags) and a low alias limit, since the file can also be edited by hand.
//
// A document is `---\n<yaml>---\n<body>`. The body is everything after the
// closing line, byte for byte: the body hash covers only that part, so writing
// front matter never changes it.

import crypto from 'node:crypto';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

const MAX_ALIASES = 10;
const OPENING = /^---[ \t]*\r?\n/;
const CLOSING = /^---[ \t]*(?:\r?\n|$)/m;

// Keys the app understands. Anything else is kept untouched on rewrite.
const schema = z
  .object({
    id: z.number().int().positive().optional(),
    slug: z.string().max(200).optional(),
    title: z.string().max(500).optional(),
    published: z.boolean().optional(),
    // Category ids, the first is primary. Strings are tolerated (a bulk import
    // file may name categories by path, Phase 7) but only ids are ever written.
    categories: z.array(z.union([z.number().int().positive(), z.string().max(200)])).max(3).optional(),
    summary: z.string().max(5000).optional(),
    summary_edited: z.boolean().optional(),
    // Search metadata (Phase 4). Keywords are plain strings or { term, weight };
    // search-terms.js cleans, caps and de-duplicates all four lists.
    keywords: z.array(z.union([z.string().max(500), z.object({ term: z.string().max(500), weight: z.number().optional() })])).max(500).optional(),
    key_phrases: z.array(z.string().max(500)).max(500).optional(),
    synonyms: z.array(z.string().max(500)).max(500).optional(),
    questions: z.array(z.string().max(500)).max(500).optional(),
  })
  .passthrough();

// Written first, in this order, so the files read the same every time.
const KEY_ORDER = [
  'id', 'slug', 'title', 'published', 'categories', 'summary', 'summary_edited',
  'keywords', 'key_phrases', 'synonyms', 'questions',
];

export const bodyHash = (body) => crypto.createHash('sha256').update(body, 'utf8').digest('hex');

// { raw: string | null, body: string }. raw is null when the file has no front matter.
export function splitFrontMatter(text) {
  const open = OPENING.exec(text);
  if (!open) return { raw: null, body: text };
  const rest = text.slice(open[0].length);
  const close = CLOSING.exec(rest);
  if (!close) return { raw: null, body: text };
  return { raw: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}

// { ok: true, data, body } or { ok: false, error }. The error is a sentence for the admin.
export function parseFrontMatter(text) {
  const { raw, body } = splitFrontMatter(text);
  if (raw === null) return { ok: true, data: {}, body };

  let value;
  try {
    value = parse(raw, { maxAliasCount: MAX_ALIASES, schema: 'core', prettyErrors: false });
  } catch (err) {
    return { ok: false, error: `The front matter is not valid YAML: ${firstLine(err.message)}` };
  }
  if (value === null || value === undefined) return { ok: true, data: {}, body };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'The front matter must be a set of "key: value" lines.' };
  }

  const checked = schema.safeParse(value);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    return { ok: false, error: `The front matter field "${issue.path.join('.')}" is invalid: ${issue.message}.` };
  }
  return { ok: true, data: checked.data, body };
}

// Known keys first, then the rest in their original order. Undefined values are dropped.
export function serializeFrontMatter(data, body) {
  const ordered = {};
  for (const key of KEY_ORDER) if (data[key] !== undefined) ordered[key] = data[key];
  for (const [key, value] of Object.entries(data)) if (!(key in ordered) && value !== undefined) ordered[key] = value;
  return `---\n${stringify(ordered, { lineWidth: 0 })}---\n${body}`;
}

const firstLine = (message) => String(message).split('\n')[0].slice(0, 200);
