// [[wiki links]]: how they render, and how the docs that link to a doc are
// rendered again. The pool is a stub; the doc files live in a temp directory.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { renderMarkdown } from '../app/services/markdown.js';
import { MAX_DEPENDENTS, rerenderDependents } from '../app/services/wiki-links.js';

const docs = {
  'links-b': { id: 7, title: 'Second <Doc>', published: true },
  'links-c': { id: 8, title: 'Secret Title', published: false },
};

// Resolves like linkResolver(pool) would, and remembers what it was asked.
function resolver() {
  const asked = [];
  const resolveLinks = async (slugs) => {
    asked.push(slugs);
    return new Map(slugs.filter((slug) => docs[slug]).map((slug) => [slug, docs[slug]]));
  };
  return { asked, resolveLinks };
}

const render = (body, { resolveLinks } = resolver()) => renderMarkdown(body, { title: 'Test', resolveLinks });

test('a link to a published doc is an anchor to its permanent id, with its title as text', async () => {
  const { html, linkTargets } = await render('See [[links-b]].');
  assert.match(html, /<a class="wikilink" href="\/doc\?id=7">Second &#x3C;Doc><\/a>/);
  assert.match(html, /class="wikilink"/);
  assert.doesNotMatch(html, /<Doc>/);
  assert.deepEqual(linkTargets, ['links-b']);
});

test('display text replaces the title', async () => {
  const { html } = await render('See [[links-b|the second document]].');
  assert.match(html, /href="\/doc\?id=7"/);
  assert.match(html, />the second document<\/a>/);
  assert.doesNotMatch(html, /Second/);
});

test('targets are trimmed and lowercased, and several spellings are one target', async () => {
  const { html, linkTargets } = await render('[[Links-B]] [[  links-b  ]] [[links-b]]');
  assert.equal(html.match(/href="\/doc\?id=7"/g).length, 3);
  assert.deepEqual(linkTargets, ['links-b']);
});

test('links inside code spans and fenced blocks are left as written', async () => {
  const { html, linkTargets } = await render('`[[links-b]]`\n\n```\n[[links-b]]\n```\n');
  assert.doesNotMatch(html, /wikilink/);
  assert.match(html, /\[\[links-b\]\]/);
  assert.deepEqual(linkTargets, []);
});

test('a link to an unknown slug is a dead, marked span, not an anchor', async () => {
  const { html, linkTargets } = await render('Typo [[links-bb]].');
  assert.match(html, /<span class="wikilink-broken"[^>]*>links-bb<\/span>/);
  assert.doesNotMatch(html, /<a /);
  assert.deepEqual(linkTargets, ['links-bb']);
});

test('a link to an unpublished doc is broken and does not reveal its title', async () => {
  const bare = await render('[[links-c]]');
  assert.match(bare.html, /wikilink-broken/);
  assert.doesNotMatch(bare.html, /Secret Title|\/doc\?id=8/);
  const named = await render('[[links-c|my words]]');
  assert.match(named.html, /wikilink-broken[^>]*>my words</);
  assert.doesNotMatch(named.html, /Secret Title/);
});

test('an empty target stays plain text and is not looked up', async () => {
  const lookup = resolver();
  const { html, linkTargets } = await render('Nothing [[]] and [[   ]] here.', lookup);
  assert.match(html, /\[\[\]\]/);
  assert.deepEqual(linkTargets, []);
  assert.equal(lookup.asked.length, 0);
});

test('all targets of a doc are looked up in one call', async () => {
  const lookup = resolver();
  await render('[[links-b]] [[links-c]] [[links-b]]\n\n- [[links-d]]', lookup);
  assert.deepEqual(lookup.asked, [['links-b', 'links-c', 'links-d']]);
});

test('a link already inside a Markdown link is not nested', async () => {
  const { html } = await render('[see [[links-b]]](https://example.com)');
  assert.doesNotMatch(html, /wikilink/);
});

test('without a resolver every link is broken', async () => {
  const { html } = await renderMarkdown('[[links-b]]', { title: 'Test' });
  assert.match(html, /wikilink-broken/);
});

test('link text is plain text in the search index source', async () => {
  const { plainText } = await render('Go to [[links-b|the second document]].');
  assert.match(plainText, /the second document/);
});

// ---------------------------------------------------------- re-rendering

const tempDirs = [];
after(() => Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function docsDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdpedia-links-'));
  tempDirs.push(dir);
  for (const [slug, text] of Object.entries(files)) await fs.writeFile(path.join(dir, `${slug}.md`), text);
  return { paths: { docs: dir } };
}

function stubPool({ dependents, fail = false }) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (fail) throw new Error('database is down');
      if (/FROM doc_links/.test(sql)) return [dependents];
      if (/FROM docs WHERE slug IN/.test(sql)) return [[{ id: 7, slug: 'links-b', title: 'Second', published: 1 }]];
      return [{ affectedRows: 1 }];
    },
  };
}

test('docs that link to a doc are rendered again from their files, without touching updated_at', async () => {
  const config = await docsDir({ 'links-a': '---\nslug: links-a\n---\nBack to [[links-b]].\n' });
  const pool = stubPool({ dependents: [{ id: 1, slug: 'links-a', title: 'Links A' }] });
  await rerenderDependents(pool, config, { id: 7, slug: 'links-b' });

  const update = pool.queries.find((q) => /^UPDATE docs/.test(q.sql));
  assert.match(update.sql, /updated_at = updated_at/);
  assert.match(update.params[0], /href="\/doc\?id=7"/);
  assert.equal(update.params[1], 1);
  assert.deepEqual(pool.queries[0].params, ['links-b', MAX_DEPENDENTS + 1]);
});

test('a dependent whose file is missing is skipped and the others still render', async () => {
  const config = await docsDir({ 'links-d': 'See [[links-b]].\n' });
  const pool = stubPool({
    dependents: [
      { id: 1, slug: 'links-a', title: 'Links A' },
      { id: 4, slug: 'links-d', title: 'Links D' },
    ],
  });
  await rerenderDependents(pool, config, { id: 7, slug: 'links-b' });
  const updates = pool.queries.filter((q) => /^UPDATE docs/.test(q.sql));
  assert.deepEqual(updates.map((q) => q.params[1]), [4]);
});

test('no more than the cap are rendered again', async () => {
  const slugs = Array.from({ length: MAX_DEPENDENTS + 1 }, (_, i) => `doc-${i}`);
  const config = await docsDir(Object.fromEntries(slugs.map((slug) => [slug, 'Plain text.\n'])));
  const dependents = slugs.map((slug, i) => ({ id: i + 1, slug, title: slug }));
  const pool = stubPool({ dependents });
  await rerenderDependents(pool, config, { id: 7, slug: 'links-b' });
  assert.equal(pool.queries.filter((q) => /^UPDATE docs/.test(q.sql)).length, MAX_DEPENDENTS);
});

test('a database failure is swallowed: the change that called it is already saved', async () => {
  const config = await docsDir({});
  await assert.doesNotReject(rerenderDependents(stubPool({ dependents: [], fail: true }), config, { id: 7, slug: 'links-b' }));
});
