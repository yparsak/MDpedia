import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUERY_MAX_CHARS,
  QUERY_MAX_TERMS,
  bodyQuery,
  buildMatchQuery,
  isShortTerm,
  likePatterns,
  parseQuery,
} from '../app/services/search-query.js';

const texts = (query) => parseQuery(query).terms.map((t) => t.text);
const weights = { title: 5, keyword: 3, phrase: 3, synonym: 2, question: 2, summary: 2, body: 1 };
const placeholders = (sql) => (sql.match(/\?/g) ?? []).length;

test('words are split, lowercased and kept in order', () => {
  assert.deepEqual(texts('Mean  Value theorem'), ['mean', 'value', 'theorem']);
  assert.deepEqual(parseQuery('mean value').terms.map((t) => t.phrase), [false, false]);
  assert.deepEqual(texts(''), []);
  assert.deepEqual(texts(undefined), []);
});

test('a quoted phrase stays together; one quoted word is an ordinary term', () => {
  assert.deepEqual(parseQuery('"mean value theorem"').terms, [{ text: 'mean value theorem', phrase: true }]);
  assert.deepEqual(parseQuery('"limit"').terms, [{ text: 'limit', phrase: false }]);
  assert.deepEqual(texts('"" limit'), ['limit']);
});

test('an unbalanced quote does not swallow the rest or raise an error', () => {
  assert.deepEqual(texts('"mean value'), ['mean', 'value']);
});

test('operator characters are stripped, inside and outside quotes', () => {
  assert.deepEqual(texts('+foo -bar* (baz) ~qux @x <y> >z'), ['foo', 'bar', 'baz', 'qux', 'x', 'y', 'z']);
  assert.deepEqual(parseQuery('"+mean -value*"').terms, [{ text: 'mean value', phrase: true }]);
  assert.deepEqual(texts('++ -- ()'), []);
});

test('letters and digits from any script survive', () => {
  assert.deepEqual(texts('Café ln2 日本語'), ['café', 'ln2', '日本語']);
});

test('repeated terms count once', () => {
  assert.deepEqual(texts('limit Limit LIMIT'), ['limit']);
});

test('the term cap and the character cap are applied and reported', () => {
  const many = parseQuery('a1 b2 c3 d4 e5 f6 g7 h8 i9 j10 k11 l12');
  assert.equal(many.terms.length, QUERY_MAX_TERMS);
  assert.equal(many.trimmed, true);

  const long = parseQuery(`${'x'.repeat(QUERY_MAX_CHARS)} extra`);
  assert.deepEqual(long.terms.map((t) => t.text), ['x'.repeat(QUERY_MAX_CHARS)]);
  assert.equal(long.trimmed, true);

  assert.equal(parseQuery('short query').trimmed, false);
});

test('only a one-character term is short', () => {
  assert.equal(isShortTerm({ text: 'x', phrase: false }), true);
  assert.equal(isShortTerm({ text: 'ln', phrase: false }), false);
});

test('LIKE patterns match the start of a word and escape wildcards', () => {
  assert.deepEqual(likePatterns('deriv'), ['deriv%', '% deriv%', '%-deriv%']);
  assert.deepEqual(likePatterns('50%_'), ['50\\%\\_%', '% 50\\%\\_%', '%-50\\%\\_%']);
});

test('the body query is a prefix for a word and a quoted phrase for a phrase', () => {
  assert.equal(bodyQuery({ text: 'deriv', phrase: false }), 'deriv*');
  assert.equal(bodyQuery({ text: 'mean value', phrase: true }), '"mean value"');
});

test('one word searches title, summary, the term table and the body', () => {
  const { sql, params } = buildMatchQuery([{ text: 'deriv', phrase: false }], weights);
  assert.equal(sql.split('UNION ALL').length, 4);
  assert.equal(placeholders(sql), params.length);
  assert.equal(params.at(-1), 'deriv*');
  assert.match(sql, /MATCH\(d\.plain_text\) AGAINST \(\? IN BOOLEAN MODE\)/);
});

test('every branch of the query is limited to published docs', () => {
  const { sql } = buildMatchQuery(
    [{ text: 'a1', phrase: false }, { text: 'x', phrase: false }, { text: 'mean value', phrase: true }],
    weights,
  );
  const branches = sql.split('UNION ALL');
  assert.ok(branches.length > 3);
  for (const branch of branches) assert.match(branch, /d\.published = 1/);
});

test('a one-character term is searched only as an exact keyword', () => {
  const { sql, params } = buildMatchQuery([{ text: 'x', phrase: false }], weights);
  assert.equal(sql.split('UNION ALL').length, 1);
  assert.match(sql, /t\.term = \?/);
  assert.doesNotMatch(sql, /MATCH|LIKE/);
  assert.deepEqual(params, ['x']);
});

test('the term index is in every row, so each term is told apart', () => {
  const { sql } = buildMatchQuery([{ text: 'ab', phrase: false }, { text: 'cd', phrase: false }], weights);
  assert.match(sql, /0 AS term_index/);
  assert.match(sql, /1 AS term_index/);
});

test('a weight of 0 switches that source off', () => {
  const noTitle = buildMatchQuery([{ text: 'ab', phrase: false }], { ...weights, title: 0 });
  assert.doesNotMatch(noTitle.sql, /d\.title/);
  assert.equal(placeholders(noTitle.sql), noTitle.params.length);

  const noSynonym = buildMatchQuery([{ text: 'ab', phrase: false }], { ...weights, synonym: 0 });
  assert.ok(!noSynonym.params.includes('synonym'));
  assert.ok(noSynonym.params.includes('keyword'));

  const noKeyword = buildMatchQuery([{ text: 'x', phrase: false }], { ...weights, keyword: 0 });
  assert.equal(noKeyword, null);

  const onlyBody = buildMatchQuery([{ text: 'ab', phrase: false }], { title: 0, keyword: 0, phrase: 0, synonym: 0, question: 0, summary: 0, body: 1 });
  assert.equal(onlyBody.sql.split('UNION ALL').length, 1);
});
