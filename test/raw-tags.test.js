// Every raw-output tag in the templates is an include or a reviewed use of
// sanitized document HTML. A new `<%-` fails this test until
// it is reviewed and added to scripts/lib/raw-tags.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRawTags } from '../scripts/lib/raw-tags.js';

const viewsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'views');

test('no raw-output tag outside the allowlist', () => {
  const violations = findRawTags(viewsDir).filter((t) => !t.allowed);
  assert.deepEqual(violations, [], 'unreviewed <%- tags: use <%= %>, or review and allow them in scripts/lib/raw-tags.js');
});

test('the only raw non-include outputs are sanitized document HTML', () => {
  const raw = findRawTags(viewsDir).filter((t) => !t.expression.startsWith('include('));
  assert.ok(raw.length > 0, 'expected the document views to be found');
  for (const t of raw) assert.match(t.expression, /^(doc|staged)\.html$/, `${t.file}:${t.line}`);
});
