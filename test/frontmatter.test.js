import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyHash, parseFrontMatter, serializeFrontMatter, splitFrontMatter } from '../app/services/frontmatter.js';

test('a file without front matter is all body', () => {
  assert.deepEqual(splitFrontMatter('# Title\n\ntext\n'), { raw: null, body: '# Title\n\ntext\n' });
  const parsed = parseFrontMatter('# Title\n');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data, {});
});

test('front matter is split from the body, which is kept byte for byte', () => {
  const body = '\n# Title\r\n\r\ntext with --- inside\n---\nmore\n';
  const parsed = parseFrontMatter(`---\nslug: my-doc\ntitle: My doc\n---\n${body}`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.slug, 'my-doc');
  assert.equal(parsed.body, body);
});

test('writing front matter does not change the body hash', () => {
  const body = '# Hello\n\n$x^2$ and \\$5\n';
  const text = serializeFrontMatter({ id: 7, slug: 'hello', title: 'Hello: a "test"', published: false }, body);
  const parsed = parseFrontMatter(text);
  assert.equal(parsed.ok, true);
  assert.equal(bodyHash(parsed.body), bodyHash(body));
  assert.deepEqual(
    { id: parsed.data.id, slug: parsed.data.slug, title: parsed.data.title, published: parsed.data.published },
    { id: 7, slug: 'hello', title: 'Hello: a "test"', published: false },
  );
});

test('known keys are written first and unknown keys survive', () => {
  const text = serializeFrontMatter({ tags: ['a'], title: 'T', id: 1, slug: 's', published: true }, 'x');
  assert.match(text, /^---\nid: 1\nslug: s\ntitle: T\npublished: true\ntags:\n {2}- a\n---\nx$/);
});

test('broken YAML and wrong types are refused with a sentence', () => {
  const bad = parseFrontMatter('---\ntitle: "unterminated\n---\nbody');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not valid YAML/);

  const wrongType = parseFrontMatter('---\ntitle: 2024\n---\nbody');
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.error, /"title"/);

  assert.equal(parseFrontMatter('---\n- a\n- b\n---\nbody').ok, false);
});

test('YAML alias bombs are refused', () => {
  const bomb = ['---', 'a: &a [x, x, x, x, x, x, x, x, x, x, x, x]'];
  for (let i = 0; i < 15; i += 1) bomb.push(`k${i}: *a`);
  bomb.push('---', 'body');
  assert.equal(parseFrontMatter(bomb.join('\n')).ok, false);
});
