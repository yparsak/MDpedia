// Validates the AI's reply (brainstorm 5.12). The reply is untrusted: it is
// parsed as JSON, checked against a zod schema, cleaned to plain text, capped,
// and then checked against the live category tree. Fields the schema does not
// name (a slug, a published flag, anything) are dropped, so the AI can only ever
// supply the fields below.
//
// The four term lists go through search-terms.js, the same cleaning and caps the
// admin form and a hand-edited file get.

import { z } from 'zod';
import { MAX_DEPTH, NAME_MAX } from './categories.js';
import { MAX_DOC_CATEGORIES } from './doc-categories.js';
import { termsFromFrontMatter } from './search-terms.js';
import { plainText } from './text.js';
import { SUMMARY_MAX } from './upload.js';

const MAX_PROPOSALS = 5;

const text = z.string().max(500);

const replySchema = z.object({
  summary: z
    .string()
    .max(SUMMARY_MAX)
    .transform(plainText)
    .refine((s) => s !== '', 'must not be empty'),
  keywords: z.array(z.union([text, z.object({ term: text, weight: z.number().optional() })])).max(200).default([]),
  key_phrases: z.array(text).max(200).default([]),
  synonyms: z.array(text).max(200).default([]),
  questions: z.array(text).max(200).default([]),
  categories: z.array(z.number().int().positive()).max(MAX_DOC_CATEGORIES).default([]),
  proposed_categories: z
    .array(z.object({ parent_id: z.number().int().positive().nullish(), name: z.string().min(1).max(300) }))
    .max(MAX_PROPOSALS)
    .default([]),
});

// Models wrap JSON in code fences or add a sentence around it, and reasoning
// models emit a <think> block first. Take the outermost { ... }.
export function extractJson(content) {
  const stripped = String(content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Checks ids and parents against the tree. Returns the errors, or the cleaned lists.
function checkAgainstTree(parsed, tree) {
  const errors = [];
  const categories = [...new Set(parsed.categories)];
  for (const id of categories) {
    if (!tree.byId.has(id)) errors.push(`categories: ${id} is not a category id from the list`);
  }

  const seen = new Set();
  const proposals = [];
  for (const { parent_id: parentId = null, name: rawName } of parsed.proposed_categories) {
    const name = plainText(rawName).slice(0, NAME_MAX);
    const parent = parentId === null ? null : tree.byId.get(parentId);
    if (parentId !== null && !parent) {
      errors.push(`proposed_categories: parent_id ${parentId} is not a category id from the list`);
      continue;
    }
    if ((parent?.depth ?? 0) >= MAX_DEPTH) {
      errors.push(`proposed_categories: "${name}" would be deeper than ${MAX_DEPTH} levels`);
      continue;
    }
    const siblings = parent ? parent.children : tree.roots;
    const key = `${parentId}|${name.toLowerCase()}`;
    // A proposal that repeats an existing category or an earlier proposal adds nothing.
    if (name === '' || seen.has(key) || siblings.some((n) => n.name.toLowerCase() === name.toLowerCase())) continue;
    seen.add(key);
    proposals.push({ parentId, name });
  }
  return { errors, categories, proposals };
}

// content: the model's reply text. Resolves to { ok: true, data } or
// { ok: false, errors } where the errors are safe to show and to send back for
// the repair retry. data is
//   { summary, terms, categories: [id], proposals: [{ parentId, name }] }
export function parseReply(content, tree) {
  const json = extractJson(content);
  if (json === null) return { ok: false, errors: ['the reply was not a single JSON object'] };

  const checked = replySchema.safeParse(json);
  if (!checked.success) {
    const errors = checked.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'reply'}: ${i.message}`);
    return { ok: false, errors };
  }
  const reply = checked.data;

  const resolved = checkAgainstTree(reply, tree);
  if (resolved.errors.length > 0) return { ok: false, errors: resolved.errors };

  const terms = termsFromFrontMatter({
    keywords: reply.keywords,
    key_phrases: reply.key_phrases,
    synonyms: reply.synonyms,
    questions: reply.questions,
  });
  return { ok: true, data: { summary: reply.summary, terms, categories: resolved.categories, proposals: resolved.proposals } };
}
