// Lists every `<%-` raw-output tag in app/views and fails if one is not on the
// allowlist (scripts/lib/raw-tags.js). Run with `make check-raw-tags`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRawTags } from './lib/raw-tags.js';

const viewsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'views');
const tags = findRawTags(viewsDir);

const includes = tags.filter((t) => t.allowed && t.expression.startsWith('include('));
const documentHtml = tags.filter((t) => t.allowed && !t.expression.startsWith('include('));
const violations = tags.filter((t) => !t.allowed);

console.log(`${includes.length} include tag(s): allowed.`);
console.log(`${documentHtml.length} sanitized document HTML output(s): allowed.`);
for (const t of documentHtml) console.log(`  ok   ${t.file}:${t.line}  <%- ${t.expression} %>`);

if (violations.length > 0) {
  console.error(`\n${violations.length} raw-output tag(s) NOT on the allowlist:`);
  for (const t of violations) console.error(`  FAIL ${t.file}:${t.line}  <%- ${t.expression} %>`);
  console.error('\nUse <%= %> (escaped). If the value really is sanitized HTML, add it to ALLOWED_RAW in scripts/lib/raw-tags.js after review.');
  process.exit(1);
}
console.log('\nEvery raw-output tag is on the allowlist.');
