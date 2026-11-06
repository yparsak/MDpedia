// Slug rules (brainstorm 5.16), shared by the server and the upload form so the
// live preview and the saved slug can never disagree. No imports: it must run
// unchanged in the browser and in Node.

export const SLUG_MAX = 80;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Letters that do not decompose into a base letter plus a combining mark.
const TRANSLITERATE = {
  ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', þ: 'th', ł: 'l', ı: 'i',
};

// Lowercase letters, digits and hyphens only; accented letters become their
// base letter. Pass { max: Infinity } to get the full result without truncation.
export function slugify(text, { max = SLUG_MAX } = {}) {
  const slug = String(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[ßæœøđðþłı]/g, (c) => TRANSLITERATE[c])
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/, '');
}
