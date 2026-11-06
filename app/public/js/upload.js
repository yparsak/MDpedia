// The upload form: fills in the title and slug when a file is chosen and keeps
// the slug preview live. It only suggests values; the server applies the same
// rules (services/upload.js), so the form also works with this script off.

import { slugify } from './slug.js';

// Larger files are not read in the browser; the server will reject them anyway.
const READ_LIMIT_BYTES = 1024 * 1024;

const fileInput = document.getElementById('file');
const titleInput = document.getElementById('title');
const slugInput = document.getElementById('slug');
const slugPreview = document.getElementById('slug-preview');

// Once the admin types in a field, a new file no longer overwrites it.
const touched = { title: titleInput.value !== '', slug: slugInput.value !== '' };

// Front matter lines are read as plain "key: value", unquoted. Anything fancier
// is left for the server's real YAML parser.
function frontMatterValue(text, key) {
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!block) return '';
  const line = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(block[1]);
  return line ? line[1].replace(/^(["'])(.*)\1$/, '$2') : '';
}

function firstHeading(text) {
  const body = text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (heading) return heading[1];
  }
  return '';
}

function showSlugPreview() {
  const typed = slugInput.value.trim();
  slugPreview.textContent = typed ? slugify(typed, { max: Infinity }) : slugify(titleInput.value);
}

// Same precedence as the server: front matter slug, otherwise made from the title.
function suggestSlug(frontMatterSlug) {
  if (touched.slug) return;
  slugInput.value = frontMatterSlug ? slugify(frontMatterSlug, { max: Infinity }) : slugify(titleInput.value);
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file || file.size > READ_LIMIT_BYTES) return;
  const text = await file.text();

  if (!touched.title) {
    const fileName = file.name.replace(/\.md$/i, '');
    titleInput.value = frontMatterValue(text, 'title') || firstHeading(text) || fileName;
  }
  suggestSlug(frontMatterValue(text, 'slug'));
  showSlugPreview();
});

titleInput.addEventListener('input', () => {
  touched.title = true;
  suggestSlug('');
  showSlugPreview();
});

slugInput.addEventListener('input', () => {
  touched.slug = slugInput.value !== '';
  showSlugPreview();
});

showSlugPreview();
