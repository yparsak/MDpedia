import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVAL_MAX_QUERIES, parseTestSet } from '../app/services/search-eval.js';

const set = (queries) => JSON.stringify({ queries });

test('a test set gives each query a list of expected slugs', () => {
  const result = parseTestSet(set([{ query: ' mean value ', expected: 'mvt', note: 'n' }, { query: 'x', expected: ['a', 'b'] }]));
  assert.deepEqual(result, {
    ok: true,
    queries: [
      { query: 'mean value', expected: ['mvt'], note: 'n' },
      { query: 'x', expected: ['a', 'b'], note: '' },
    ],
  });
});

test('the example file in db/seed is a valid test set', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('../db/seed/search_test_set.example.json', import.meta.url), 'utf8');
  assert.equal(parseTestSet(text).ok, true);
});

test('bad input is refused with a sentence', () => {
  assert.match(parseTestSet('{nope').error, /not valid JSON/);
  assert.match(parseTestSet('[]').error, /expected shape/);
  assert.match(parseTestSet(set([])).error, /expected shape/);
  assert.match(parseTestSet(set([{ query: '', expected: 'a' }])).error, /queries\.0\.query/);
  assert.match(parseTestSet(set([{ query: 'q' }])).error, /queries\.0\.expected/);
  assert.match(parseTestSet(set([{ query: 'q', expected: [] }])).error, /expected shape/);
  assert.match(parseTestSet(set(Array.from({ length: EVAL_MAX_QUERIES + 1 }, () => ({ query: 'q', expected: 'a' })))).error, /expected shape/);
});
