import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DEPTH,
  buildTree,
  checkName,
  checkSlug,
  docPath,
  findByPath,
  heightOf,
  pathLabel,
  subtreeOf,
} from '../app/services/categories.js';
import { checkCategoryIds } from '../app/services/doc-categories.js';

const row = (id, parent_id, name, slug, sort_order) => ({ id, parent_id, name, slug, sort_order });

const tree = buildTree([
  row(3, 1, 'Analysis', 'analysis', 2),
  row(2, 1, 'Calculus', 'calculus', 1),
  row(1, null, 'Math', 'math', 1),
  row(4, null, 'Physics', 'physics', 2),
  row(5, 2, 'Limits', 'limits', 1),
]);

test('the tree is ordered, with depth and path worked out from the slugs', () => {
  assert.deepEqual(tree.nodes.map((n) => n.id), [1, 2, 5, 3, 4]);
  assert.equal(tree.byId.get(5).depth, 3);
  assert.equal(tree.byId.get(5).path, 'math/calculus/limits');
  assert.equal(pathLabel(tree.byId.get(5)), 'Math > Calculus > Limits');
  assert.equal(MAX_DEPTH, 3);
});

test('subtree and height', () => {
  assert.deepEqual(subtreeOf(tree.byId.get(1)).map((n) => n.id), [1, 2, 5, 3]);
  assert.equal(heightOf(tree.byId.get(1)), 3);
  assert.equal(heightOf(tree.byId.get(4)), 1);
});

test('a category is found by its path, ignoring case via lowercase segments', () => {
  assert.equal(findByPath(tree, ['math', 'calculus'])?.id, 2);
  assert.equal(findByPath(tree, ['math', 'physics']), null);
  assert.equal(findByPath(tree, ['nope']), null);
});

test('the doc path is built from the primary category, or is just the slug', () => {
  assert.equal(docPath(tree.byId.get(2), 'limits-intro'), 'math/calculus/limits-intro');
  assert.equal(docPath(null, 'limits-intro'), 'limits-intro');
});

test('names and slugs are cleaned and checked', () => {
  assert.deepEqual(checkName('  Linear   Algebra '), { ok: true, name: 'Linear Algebra' });
  assert.equal(checkName('   ').ok, false);
  assert.equal(checkName('x'.repeat(101)).ok, false);
  assert.deepEqual(checkSlug('', 'Linear Algebra'), { ok: true, slug: 'linear-algebra' });
  assert.deepEqual(checkSlug('Calc 1!', 'Anything'), { ok: true, slug: 'calc-1' });
  assert.equal(checkSlug('', '!!!').ok, false);
  assert.equal(checkSlug('a'.repeat(81), 'x').ok, false);
});

test('a doc may have at most three distinct, existing categories', () => {
  assert.equal(checkCategoryIds([2, 3, 4], tree).ok, true);
  assert.equal(checkCategoryIds([1, 2, 3, 4], tree).ok, false);
  assert.equal(checkCategoryIds([2, 2], tree).ok, false);
  assert.equal(checkCategoryIds([99], tree).ok, false);
});
