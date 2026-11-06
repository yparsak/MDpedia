import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSlug, resolveTitle, validateUploadFile } from '../app/services/upload.js';

const check = (buffer, originalName = 'doc.md', maxBytes = 1000) => validateUploadFile({ buffer, originalName, maxBytes });

test('a plain Markdown file passes', () => {
  const result = check(Buffer.from('# Hi\n'));
  assert.equal(result.ok, true);
  assert.equal(result.text, '# Hi\n');
});

test('each rejection names its own reason', () => {
  assert.match(check(Buffer.from('x'), 'doc.txt').errors[0], /\.md extension/);
  assert.match(check(Buffer.alloc(1001, 97)).errors[0], /over the 1000 byte limit/);
  assert.match(check(Buffer.from([0x61, 0x00, 0x62])).errors[0], /null byte/);
  assert.match(check(Buffer.from([0x61, 0xc3, 0x28])).errors[0], /not valid UTF-8/);
  assert.match(check(Buffer.from('  \n')).errors[0], /empty/);
  assert.match(check(undefined).errors[0], /Choose a Markdown/);
});

test('the size check is a 413 and the rest are 400', () => {
  assert.equal(check(Buffer.alloc(1001, 97)).status, 413);
  assert.equal(check(Buffer.from([0x00])).status, 400);
});

test('the title comes from the form, then front matter, then the heading, then the file name', () => {
  const base = { formTitle: '', frontMatterTitle: '', heading: '', originalName: 'my-notes.md' };
  assert.equal(resolveTitle(base), 'my-notes');
  assert.equal(resolveTitle({ ...base, heading: 'From heading' }), 'From heading');
  assert.equal(resolveTitle({ ...base, heading: 'From heading', frontMatterTitle: 'From front matter' }), 'From front matter');
  assert.equal(resolveTitle({ ...base, frontMatterTitle: 'From front matter', formTitle: '  Typed   title ' }), 'Typed title');
});

test('the slug comes from the form, then front matter, then the title', () => {
  const base = { formSlug: '', frontMatterSlug: '', title: 'Some Title' };
  assert.deepEqual(resolveSlug(base), { slug: 'some-title' });
  assert.deepEqual(resolveSlug({ ...base, frontMatterSlug: 'From-FM' }), { slug: 'from-fm' });
  assert.deepEqual(resolveSlug({ ...base, frontMatterSlug: 'from-fm', formSlug: 'Typed Slug' }), { slug: 'typed-slug' });
});

test('a slug that is empty or too long is an error, not a silent change', () => {
  assert.match(resolveSlug({ formSlug: '!!!', frontMatterSlug: '', title: 'T' }).error, /no letters or digits/);
  assert.match(resolveSlug({ formSlug: 'a'.repeat(81), frontMatterSlug: '', title: 'T' }).error, /longer than 80/);
  assert.match(resolveSlug({ formSlug: '', frontMatterSlug: '', title: '日本語' }).error, /could not be made/);
});
