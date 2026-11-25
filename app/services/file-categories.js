// The `categories:` line of an uploaded file.
// A value that names a category in the tree by its path (`math/calculus`, the
// slugs joined with slashes, case ignored) is honoured. Anything else becomes a
// proposal for the admin to accept, rename or reject: a file never creates a
// category on its own. Numbers are ignored, since an id from another wiki would
// point at the wrong category here.

import { MAX_DEPTH, NAME_MAX, findByPath } from './categories.js';
import { MAX_DOC_CATEGORIES } from './doc-categories.js';
import { cleanLine } from './text.js';

const SOURCE_VALUE_MAX = 200;

// "quantum-mechanics" -> "Quantum Mechanics"
const titleCase = (segment) =>
  segment
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');

// values: the front matter list. Resolves to
// { ids: [category id], proposals: [{ name, parentId, sourceValue }] }.
// A proposal sits under the matched part of the path when there is one, else at the top level.
export function resolveFileCategories(tree, values) {
  const ids = [];
  const proposals = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue;
    const segments = value.split('/').map((segment) => segment.trim().toLowerCase()).filter(Boolean);
    if (segments.length === 0) continue;

    const found = findByPath(tree, segments);
    if (found) {
      if (!ids.includes(found.id) && ids.length < MAX_DOC_CATEGORIES) ids.push(found.id);
      continue;
    }

    const name = titleCase(segments[segments.length - 1]).slice(0, NAME_MAX);
    const parent = segments.length > 1 ? findByPath(tree, segments.slice(0, -1)) : null;
    const sourceValue = cleanLine(value).slice(0, SOURCE_VALUE_MAX);
    if (name === '' || proposals.some((p) => p.sourceValue.toLowerCase() === sourceValue.toLowerCase())) continue;
    proposals.push({ name, parentId: parent && parent.depth < MAX_DEPTH ? parent.id : null, sourceValue });
  }
  return { ids, proposals };
}
