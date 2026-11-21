// The pure helpers of vector search: the embedded text, its hash, the prefix rule and the vector literal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMBED_TEXT_MAX_CHARS, applyPrefix, buildEmbedText, embedInputHash, vectorLiteral } from '../app/services/embed-text.js';

const embed = { model: 'm', dtype: 'fp32', pooling: 'cls', docPrefix: '' };

test('the text is title, summary, keywords and questions, one per line', () => {
  const text = buildEmbedText({
    title: 'Limits',
    summary: 'What a limit is.',
    keywords: ['limit', 'epsilon'],
    questions: ['What is a limit?', 'Why epsilon?'],
  });
  assert.equal(text, 'Limits\nWhat a limit is.\nKeywords: limit, epsilon\nQuestions: What is a limit? Why epsilon?');
});

test('empty parts are left out and whitespace is collapsed', () => {
  assert.equal(buildEmbedText({ title: '  A   B ', summary: '', keywords: [], questions: [] }), 'A B');
});

test('a long text is cut to the cap', () => {
  const text = buildEmbedText({ title: 'T', summary: 'x'.repeat(5000) });
  assert.equal(text.length, EMBED_TEXT_MAX_CHARS);
});

test('the prefix is joined with one space, and an empty prefix adds nothing', () => {
  assert.equal(applyPrefix('Represent this:', 'cats'), 'Represent this: cats');
  assert.equal(applyPrefix('', 'cats'), 'cats');
});

test('the hash changes with the text and with every setting that shapes the vector', () => {
  const base = embedInputHash('text', embed);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(embedInputHash('text', { ...embed }), base);
  assert.notEqual(embedInputHash('other', embed), base);
  for (const change of [{ model: 'n' }, { dtype: 'q8' }, { pooling: 'mean' }, { docPrefix: 'p' }]) {
    assert.notEqual(embedInputHash('text', { ...embed, ...change }), base, JSON.stringify(change));
  }
});

test('a vector literal is a bracketed list, and a wrong length or NaN is refused', () => {
  assert.equal(vectorLiteral([0.5, -1, 2e-7], 3), '[0.5,-1,2e-7]');
  assert.throws(() => vectorLiteral([1, 2], 3), /Expected a vector of 3/);
  assert.throws(() => vectorLiteral([1, NaN, 3], 3), /not finite/);
  assert.throws(() => vectorLiteral('nope', 3), /Expected a vector of 3/);
});
