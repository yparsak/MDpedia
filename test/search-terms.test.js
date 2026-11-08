import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter, serializeFrontMatter } from '../app/services/frontmatter.js';
import {
  emptyTerms,
  formatTermForm,
  parseTermForm,
  termsFromFrontMatter,
  termsToFrontMatter,
} from '../app/services/search-terms.js';

const form = (over = {}) => ({ keywords: '', phrases: '', synonyms: '', questions: '', ...over });

test('keywords take an optional weight after a bar, and default to 1', () => {
  const result = parseTermForm(form({ keywords: 'derivative | 3\nslope\n  rate of change |2  \n\n' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.terms.keywords, [
    { term: 'derivative', weight: 3 },
    { term: 'slope', weight: 1 },
    { term: 'rate of change', weight: 2 },
  ]);
});

test('a weight outside 1 to 3, or not a number, is refused by name', () => {
  for (const bad of ['x | 0', 'x | 4', 'x | 10', 'x | high', 'x |']) {
    const result = parseTermForm(form({ keywords: bad }));
    assert.equal(result.ok, false, bad);
    assert.match(result.errors[0], /weight of the keyword "x" must be 1, 2 or 3/);
  }
});

test('blank lines and repeats are dropped, ignoring case and accents', () => {
  const result = parseTermForm(form({ keywords: 'Resume\n\nrésumé\nRESUME | 3', synonyms: 'FTC\nftc' }));
  assert.deepEqual(result.terms.keywords, [{ term: 'Resume', weight: 1 }]);
  assert.deepEqual(result.terms.synonyms, ['FTC']);
});

test('only keywords have a weight: a bar in another list is part of the text', () => {
  const result = parseTermForm(form({ phrases: 'a | b' }));
  assert.deepEqual(result.terms.phrases, ['a | b']);
});

test('control characters become spaces and the text stays plain', () => {
  const result = parseTermForm(form({ questions: 'What\tis <b>this</b>?\u0000' }));
  assert.deepEqual(result.terms.questions, ['What is <b>this</b>?']);
});

test('an entry over its length cap is refused, and nothing is saved', () => {
  const result = parseTermForm(form({ keywords: 'k'.repeat(61), phrases: 'p'.repeat(101), questions: 'q'.repeat(201) }));
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /keyword .* is longer than 60/);
});

test('more entries than the cap are refused', () => {
  const result = parseTermForm(form({ keywords: Array.from({ length: 21 }, (_, i) => `k${i}`).join('\n') }));
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /At most 20 keywords/);
});

test('an empty form is valid and holds nothing', () => {
  assert.deepEqual(parseTermForm(form()), { ok: true, terms: emptyTerms() });
  assert.deepEqual(parseTermForm({}), { ok: true, terms: emptyTerms() });
});

test('the textareas show what was saved, and read back the same', () => {
  const terms = {
    keywords: [{ term: 'derivative', weight: 3 }, { term: 'slope', weight: 1 }],
    phrases: ['mean value theorem'],
    synonyms: ['d/dx'],
    questions: ['What is a derivative?'],
  };
  const text = formatTermForm(terms);
  assert.equal(text.keywords, 'derivative | 3\nslope | 1');
  assert.deepEqual(parseTermForm(text), { ok: true, terms });
});

test('front matter is read leniently: strings or objects, bad weights fixed, junk dropped', () => {
  const terms = termsFromFrontMatter({
    keywords: ['a1', { term: 'b2', weight: 3 }, { term: 'c3', weight: 9 }, { term: 'a1', weight: 2 }, '   '],
    key_phrases: ['one two', 'x'.repeat(101)],
    synonyms: 'not a list',
  });
  assert.deepEqual(terms.keywords, [
    { term: 'a1', weight: 1 },
    { term: 'b2', weight: 3 },
    { term: 'c3', weight: 1 },
  ]);
  assert.deepEqual(terms.phrases, ['one two']);
  assert.deepEqual(terms.synonyms, []);
  assert.deepEqual(terms.questions, []);
});

test('empty lists leave their front matter key out', () => {
  const fm = termsToFrontMatter({ ...emptyTerms(), synonyms: ['ftc'], keywords: [{ term: 'k', weight: 2 }] });
  assert.deepEqual(fm.keywords, [{ term: 'k', weight: 2 }]);
  assert.deepEqual(fm.synonyms, ['ftc']);
  assert.equal(fm.key_phrases, undefined);
  assert.equal(fm.questions, undefined);
});

test('the lists survive a trip through a front matter file', () => {
  const terms = { keywords: [{ term: 'derivative', weight: 3 }], phrases: ['mean value theorem'], synonyms: ['d/dx'], questions: ['Why: really?'] };
  const text = serializeFrontMatter({ id: 1, slug: 's', title: 'T', ...termsToFrontMatter(terms) }, 'body\n');
  const parsed = parseFrontMatter(text);
  assert.equal(parsed.ok, true);
  assert.deepEqual(termsFromFrontMatter(parsed.data), terms);
  assert.ok(text.indexOf('keywords:') > text.indexOf('title:'));
});
