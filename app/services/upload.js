// The single-upload path. Every check runs before
// anything is written, and each failure names its real reason so the admin can
// fix it: wrong extension, size, null byte, encoding, front matter, title, slug.
//
// A new upload always starts unpublished. An `id`, `published` or `ai` in the
// uploaded front matter is ignored: the database assigns the id and nothing in an
// upload may publish itself. `categories:` is honoured when a value names a
// category in the tree by its path; an unmatched value becomes a proposal and is
// never created (file-categories.js). The admin confirms categories on the review screen.
// Search keywords, key phrases, synonyms and questions are kept (cleaned and
// capped), since they are plain text that harms nothing; AI extraction replaces them.

import path from 'node:path';
import { SLUG_MAX, SLUG_PATTERN, slugify } from '../public/js/slug.js';
import { parseFrontMatter } from './frontmatter.js';
import { cleanLine } from './text.js';
import { aiConfigured } from '../config.js';
import { loadTree, pathLabel } from './categories.js';
import { createDoc, slugTaken } from './docs.js';
import { resolveFileCategories } from './file-categories.js';
import { termsFromFrontMatter } from './search-terms.js';
import { firstHeading } from './markdown.js';
import { renderWithLinks } from './wiki-links.js';

// Moved to text.js so search-terms.js can use it without a cycle; kept exported here for the existing imports.
export { cleanLine };
export const TITLE_MAX = 200;
export const SUMMARY_MAX = 600;

const KNOWN_KEYS = [
  'id', 'slug', 'title', 'published', 'categories', 'summary', 'summary_edited',
  'keywords', 'key_phrases', 'synonyms', 'questions', 'ai',
];

const fail = (status, ...errors) => ({ ok: false, status, errors });

// { ok: true, text } or { ok: false, status, errors }.
export function validateUploadFile({ buffer, originalName, maxBytes }) {
  if (!buffer || buffer.length === 0) {
    return fail(400, buffer ? 'The file is empty.' : 'Choose a Markdown (.md) file to upload.');
  }
  if (path.extname(String(originalName ?? '')).toLowerCase() !== '.md') {
    return fail(400, 'Only Markdown files with a .md extension are accepted.');
  }
  if (buffer.length > maxBytes) {
    return fail(413, `The file is ${buffer.length} bytes, over the ${maxBytes} byte limit.`);
  }
  if (buffer.includes(0)) {
    return fail(400, 'The file contains a null byte, so it is not a text file.');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return fail(400, 'The file is not valid UTF-8. Save it as UTF-8 text and try again.');
  }
  if (text.trim() === '') return fail(400, 'The file is empty.');
  return { ok: true, text };
}

// Precedence: the form, then front matter, then the first H1, then the file name.
export function resolveTitle({ formTitle, frontMatterTitle, heading, originalName }) {
  const fileName = path.basename(String(originalName ?? '')).replace(/\.md$/i, '');
  return (
    [formTitle, frontMatterTitle, heading, fileName].map(cleanLine).find((candidate) => candidate !== '') ?? ''
  );
}

// A slug the admin or the author chose is normalised and checked; one that is
// too long is refused rather than silently cut. { slug } or { error }.
function explicitSlug(value, source) {
  const slug = slugify(value, { max: Infinity });
  if (slug === '') return { error: `The ${source} slug has no letters or digits to use.` };
  if (slug.length > SLUG_MAX) return { error: `The ${source} slug is longer than ${SLUG_MAX} characters.` };
  return { slug };
}

// The form wins over front matter, which wins over the title.
export function resolveSlug({ formSlug, frontMatterSlug, title }) {
  if (cleanLine(formSlug) !== '') return explicitSlug(formSlug, 'form');
  if (cleanLine(frontMatterSlug) !== '') return explicitSlug(frontMatterSlug, 'front matter');
  const slug = slugify(title);
  return slug === '' ? { error: 'A slug could not be made from the title. Type one in the slug field.' } : { slug };
}

const slugTakenResult = (slug) => fail(409, `The slug "${slug}" is already taken. Slugs are permanent and unique, so choose another.`);

// The first free "base-2", "base-3", ... (bulk import). The base is
// shortened if the suffix would push the slug over SLUG_MAX. `tried` holds slugs
// that looked free but were refused when written.
async function freeSlug(pool, base, tried) {
  for (let n = 2; n < 1000; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!tried.has(candidate) && !(await slugTaken(pool, candidate))) return candidate;
  }
  return null;
}

// Resolves to { ok: true, id, slug, baseSlug, queued, categoryLabels, proposed } or
// { ok: false, status, errors }. suffixCollisions: a taken slug gets a numeric
// suffix instead of being refused (bulk import). baseSlug is the slug before any suffix;
// proposed lists the `categories:` values that matched nothing.
export async function ingestUpload(pool, config, { file, formTitle, formSlug, suffixCollisions = false }) {
  const checked = validateUploadFile({
    buffer: file?.buffer,
    originalName: file?.originalname,
    maxBytes: config.uploads.maxBytes,
  });
  if (!checked.ok) return checked;

  const parsed = parseFrontMatter(checked.text);
  if (!parsed.ok) return fail(400, parsed.error);
  const { data, body } = parsed;

  const title = resolveTitle({
    formTitle,
    frontMatterTitle: data.title,
    heading: firstHeading(body),
    originalName: file.originalname,
  });
  if (title === '') return fail(400, 'A title is required.');
  if (title.length > TITLE_MAX) return fail(400, `The title is longer than ${TITLE_MAX} characters.`);

  const resolved = resolveSlug({ formSlug, frontMatterSlug: data.slug, title });
  if (resolved.error) return fail(400, resolved.error);
  const baseSlug = resolved.slug;
  if (!SLUG_PATTERN.test(baseSlug)) return fail(400, 'The slug may only use lowercase letters, digits and hyphens.');
  let slug = baseSlug;
  const tried = new Set();
  if (await slugTaken(pool, slug)) {
    if (!suffixCollisions) return slugTakenResult(slug);
    slug = await freeSlug(pool, baseSlug, tried);
    if (slug === null) return slugTakenResult(baseSlug);
  }

  const summary = cleanLine(data.summary).slice(0, SUMMARY_MAX) || null;
  const extraFrontMatter = Object.fromEntries(Object.entries(data).filter(([key]) => !KNOWN_KEYS.includes(key)));
  const rendered = await renderWithLinks(pool, body, title);
  const terms = termsFromFrontMatter(data);
  const tree = await loadTree(pool);
  const fileCategories = resolveFileCategories(tree, data.categories);

  // With the AI configured the doc waits for extraction; without it, it is ready for review at once.
  const queued = aiConfigured(config);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const id = await createDoc(pool, config, {
        slug,
        title,
        summary,
        extraFrontMatter,
        terms,
        body,
        rendered,
        queue: queued,
        categoryIds: fileCategories.ids,
        proposals: fileCategories.proposals,
        sizeBytes: file.buffer.length,
      });
      return {
        ok: true,
        id,
        slug,
        baseSlug,
        queued,
        categoryLabels: fileCategories.ids.map((categoryId) => pathLabel(tree.byId.get(categoryId))),
        proposed: fileCategories.proposals.map((p) => p.sourceValue),
      };
    } catch (err) {
      // Lost a race for the slug, or a stray file already holds the name.
      if (err.code !== 'ER_DUP_ENTRY' && err.code !== 'EEXIST') throw err;
      if (!suffixCollisions || attempt >= 3) return slugTakenResult(slug);
      tried.add(slug);
      slug = await freeSlug(pool, baseSlug, tried);
      if (slug === null) return slugTakenResult(baseSlug);
    }
  }
}
