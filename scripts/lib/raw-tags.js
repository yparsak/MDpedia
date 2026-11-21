// The raw-output tags (`<%-`) in the templates (brainstorm 5.7). EJS escapes
// `<%=` and does not escape `<%-`, so every raw tag is a place where markup can
// reach the page unescaped. Only two uses are allowed:
//
//   - includes of other templates:           <%- include('...') %>
//   - the sanitized, pre-rendered document HTML, at the exact places in ALLOWED_RAW
//
// Anything else is reported. `make check-raw-tags` prints the list and fails on a
// violation; test/raw-tags.test.js does the same inside `npm test`.

import fs from 'node:fs';
import path from 'node:path';

// file (relative to app/views) -> the exact expressions allowed raw there.
// Add to this list only after checking that the value is sanitized HTML.
export const ALLOWED_RAW = {
  'doc.ejs': ['doc.html'],
  'admin/doc-detail.ejs': ['doc.html'],
  'admin/doc-review.ejs': ['doc.html'],
  'admin/doc-replace.ejs': ['staged.html'],
};

const RAW_TAG = /<%-\s*([\s\S]*?)\s*-?%>/g;
const INCLUDE_ONLY = /^include\(\s*'[A-Za-z0-9_./-]+'\s*(,\s*\{[^}]*\}\s*)?\)$/;

function templateFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return templateFiles(full);
    return entry.name.endsWith('.ejs') ? [full] : [];
  });
}

// Every raw tag under viewsDir as { file, line, expression, allowed }.
export function findRawTags(viewsDir) {
  const found = [];
  for (const full of templateFiles(viewsDir)) {
    const file = path.relative(viewsDir, full).split(path.sep).join('/');
    const text = fs.readFileSync(full, 'utf8');
    for (const match of text.matchAll(RAW_TAG)) {
      const expression = match[1].trim();
      const line = text.slice(0, match.index).split('\n').length;
      const allowed = INCLUDE_ONLY.test(expression) || (ALLOWED_RAW[file] ?? []).includes(expression);
      found.push({ file, line, expression, allowed });
    }
  }
  return found;
}
