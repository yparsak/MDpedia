import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankMatches, scoreMatches } from '../app/services/search.js';

const weights = { title: 5, keyword: 3, phrase: 3, synonym: 2, question: 2, summary: 2, body: 1 };
const row = (doc_id, term_index, source, weight = 1, updated_at = '2026-01-01 00:00:00') => ({ doc_id, term_index, source, weight, updated_at });

test('each source adds its weight, and a keyword is multiplied by its own weight', () => {
  const docs = scoreMatches([row(1, 0, 'title'), row(1, 0, 'keyword', 2), row(2, 0, 'body')], weights);
  assert.equal(docs.get(1).score, 5 + 3 * 2);
  assert.equal(docs.get(1).matched, 1);
  assert.equal(docs.get(2).score, 1);
});

test('a keyword match outranks a body-only match', () => {
  const docs = scoreMatches([row(1, 0, 'keyword', 1), row(2, 0, 'body')], weights);
  assert.ok(docs.get(1).score > docs.get(2).score);
});

test('several rows of one kind count once, the best one', () => {
  const docs = scoreMatches([row(1, 0, 'synonym'), row(1, 0, 'synonym'), row(1, 0, 'keyword', 1), row(1, 0, 'keyword', 3)], weights);
  assert.equal(docs.get(1).score, 2 + 3 * 3);
});

test('terms are counted separately and matched counts distinct terms', () => {
  const docs = scoreMatches([row(1, 0, 'title'), row(1, 1, 'body'), row(1, 1, 'summary')], weights);
  assert.equal(docs.get(1).matched, 2);
  assert.equal(docs.get(1).score, 5 + 1 + 2);
});

test('a weight of 0 for a source gives it no points', () => {
  const docs = scoreMatches([row(1, 0, 'title')], { ...weights, title: 0 });
  assert.equal(docs.get(1).score, 0);
});

test('ids come back as numbers whatever the driver returns', () => {
  const docs = scoreMatches([row('7', '0', 'title', '1')], weights);
  assert.deepEqual([...docs.keys()], [7]);
});

const doc = (id, matched, score, updatedAt = '2026-01-01 00:00:00') => [id, { id, matched, score, updatedAt }];
const options = { partialThreshold: 3, resultLimit: 100 };

test('every term is required first, ordered by score then most recent', () => {
  const docs = new Map([
    doc(1, 2, 4, '2026-01-01 00:00:00'),
    doc(2, 2, 9),
    doc(3, 2, 4, '2026-03-01 00:00:00'),
    doc(4, 2, 1),
    doc(5, 1, 50),
  ]);
  assert.deepEqual(rankMatches(docs, 2, options), { ids: [2, 3, 1, 4], partial: false });
});

test('too few full matches falls back to any term, closest first, and says so', () => {
  const docs = new Map([doc(1, 1, 9), doc(2, 2, 5), doc(3, 1, 3)]);
  assert.deepEqual(rankMatches(docs, 2, options), { ids: [2, 1, 3], partial: true });
});

test('the threshold can be met exactly, and then there is no fallback', () => {
  const docs = new Map([doc(1, 2, 1), doc(2, 2, 2), doc(3, 2, 3), doc(4, 1, 9)]);
  assert.deepEqual(rankMatches(docs, 2, options), { ids: [3, 2, 1], partial: false });
});

test('no partial label when the fallback would add nothing', () => {
  const docs = new Map([doc(1, 2, 1)]);
  assert.deepEqual(rankMatches(docs, 2, options), { ids: [1], partial: false });
});

test('one term is never partial, and nothing found is an empty list', () => {
  assert.deepEqual(rankMatches(new Map([doc(1, 1, 1)]), 1, options), { ids: [1], partial: false });
  assert.deepEqual(rankMatches(new Map(), 2, options), { ids: [], partial: false });
});

test('at most the result limit is returned', () => {
  const docs = new Map(Array.from({ length: 150 }, (_, i) => doc(i + 1, 1, 1, `2026-01-01 00:00:${String(i % 60).padStart(2, '0')}`)));
  assert.equal(rankMatches(docs, 1, options).ids.length, 100);
  assert.equal(rankMatches(docs, 1, { ...options, resultLimit: 7 }).ids.length, 7);
});
