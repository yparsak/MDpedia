import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLUG_MAX, SLUG_PATTERN, slugify } from '../app/public/js/slug.js';

test('a title becomes lowercase words joined by hyphens', () => {
  assert.equal(slugify('Introduction to Limits'), 'introduction-to-limits');
  assert.equal(slugify('  Limits & Continuity!  '), 'limits-continuity');
});

test('accented letters are transliterated', () => {
  assert.equal(slugify('Café Müller'), 'cafe-muller');
  assert.equal(slugify('Işık ve Çözüm'), 'isik-ve-cozum');
  assert.equal(slugify('Straße'), 'strasse');
});

test('the result is cut at the maximum without a trailing hyphen', () => {
  const slug = slugify(`${'a'.repeat(79)} b`);
  assert.equal(slug.length, 79);
  assert.match(slug, SLUG_PATTERN);
  assert.equal(slugify('a'.repeat(200)).length, SLUG_MAX);
  assert.equal(slugify('a'.repeat(200), { max: Infinity }).length, 200);
});

test('text with nothing usable gives an empty slug', () => {
  assert.equal(slugify('---'), '');
  assert.equal(slugify('日本語'), '');
});
