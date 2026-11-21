// Visibility (brainstorm 5.18, 5.10): a document that is unpublished, awaiting
// review, still processing, uploaded or failed must not appear anywhere readers
// can look (search, category pages, counts, the home list, backlinks, /doc?id=,
// the doc page itself), and must get the very same 404 as an id or slug that
// does not exist.
//
// These tests use a real database, so they run only against a database whose name
// ends in _test, taken from TEST_DB_NAME (scripts/lib/test-db.js). `make test`
// rebuilds MDpedia_test and sets it. Without TEST_DB_NAME they are skipped; with
// the real database name the run is refused before any connection is made.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app/app.js';
import { loadTree, publishedSubtreeCounts } from '../app/services/categories.js';
import { openTestDatabase } from '../scripts/lib/test-db.js';

const db = openTestDatabase();

// Words that exist only in these fixtures. "Visquartz" is in every document; the
// hidden ones add a marker of their own, so a leak can be told from the rest.
const SHARED = 'Visquartz';
const PUBLISHED = { slug: 'vis-published', title: `${SHARED} Published Page`, status: 'published', published: 1 };
const HIDDEN = [
  { slug: 'vis-unpublished', title: `${SHARED} Hidden Unpublished`, status: 'unpublished', published: 0 },
  { slug: 'vis-ready', title: `${SHARED} Hidden Ready`, status: 'ready', published: 0 },
  { slug: 'vis-processing', title: `${SHARED} Hidden Processing`, status: 'processing', published: 0 },
  { slug: 'vis-uploaded', title: `${SHARED} Hidden Uploaded`, status: 'uploaded', published: 0 },
  { slug: 'vis-failed', title: `${SHARED} Hidden Failed`, status: 'failed', published: 0 },
];
const HIDDEN_ONLY_WORD = 'visonlyhiddenword';

describe('visibility against the test database', { skip: db ? false : 'TEST_DB_NAME is not set (run `make test`)' }, () => {
  let server;
  let base;
  const ids = new Map();

  const cleanup = async () => {
    await db.pool.query("DELETE FROM docs WHERE slug LIKE 'vis-%'");
    await db.pool.query("DELETE FROM categories WHERE slug IN ('vis-child', 'vis-hidden', 'vis-root') ORDER BY id DESC");
    await db.pool.query("DELETE FROM search_log WHERE query_text LIKE 'vis%'");
  };

  async function addDoc({ slug, title, status, published }, { hiddenOnlyWord = false } = {}) {
    const plain = `${SHARED} body text ${hiddenOnlyWord ? HIDDEN_ONLY_WORD : ''}`;
    const [result] = await db.pool.query(
      `INSERT INTO docs (slug, title, status, published, summary, body_hash, html, plain_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [slug, title, status, published, `Summary for ${title}`, 'a'.repeat(64), `<p>Body of ${title}</p>`, plain],
    );
    ids.set(slug, result.insertId);
    await db.pool.query("INSERT INTO doc_terms (doc_id, kind, term, weight) VALUES (?, 'keyword', ?, 2)", [result.insertId, 'visquartz']);
    return result.insertId;
  }

  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };

  before(async () => {
    await cleanup();

    const [root] = await db.pool.query("INSERT INTO categories (parent_id, name, slug, sort_order) VALUES (NULL, 'Vis Root', 'vis-root', 1)");
    const [hiddenCategory] = await db.pool.query("INSERT INTO categories (parent_id, name, slug, sort_order) VALUES (NULL, 'Vis Hidden Only', 'vis-hidden', 2)");
    const [child] = await db.pool.query("INSERT INTO categories (parent_id, name, slug, sort_order) VALUES (?, 'Vis Child', 'vis-child', 1)", [root.insertId]);

    const publishedId = await addDoc(PUBLISHED);
    await db.pool.query('INSERT INTO doc_categories (doc_id, category_id, position) VALUES (?, ?, 1)', [publishedId, root.insertId]);

    for (const [index, doc] of HIDDEN.entries()) {
      const id = await addDoc(doc, { hiddenOnlyWord: true });
      // Every hidden doc is filed in the hidden-only category, and one also in the child of a
      // category that has a published doc, so a count or a list could leak it.
      await db.pool.query('INSERT INTO doc_categories (doc_id, category_id, position) VALUES (?, ?, 1)', [id, hiddenCategory.insertId]);
      if (index === 0) await db.pool.query('INSERT INTO doc_categories (doc_id, category_id, position) VALUES (?, ?, 2)', [id, child.insertId]);
      // Each hidden doc links to the published one, so "What links here" could leak it.
      await db.pool.query('INSERT INTO doc_links (source_doc_id, target_slug) VALUES (?, ?)', [id, PUBLISHED.slug]);
    }

    const app = createApp({ config: db.config, pool: db.pool });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await cleanup();
    await db.pool.end();
  });

  const hiddenTitles = HIDDEN.map((d) => d.title);
  const assertNoHiddenTitles = (text, where) => {
    for (const title of hiddenTitles) assert.ok(!text.includes(title), `${where} leaks "${title}"`);
    assert.ok(!text.includes('Hidden Unpublished'), `${where} leaks a hidden doc`);
  };

  test('the published doc is served, through its category path', async () => {
    const res = await get(`/wiki/vis-root/${PUBLISHED.slug}`);
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(PUBLISHED.title));
  });

  test('a hidden doc gets the same 404 as a slug that does not exist', async () => {
    const missing = await get('/wiki/vis-no-such-doc');
    assert.equal(missing.status, 404);
    for (const doc of HIDDEN) {
      for (const path of [`/wiki/${doc.slug}`, `/wiki/vis-root/${doc.slug}`, `/wiki/vis-hidden/${doc.slug}`]) {
        const res = await get(path);
        assert.equal(res.status, 404, path);
        assert.equal(res.text, missing.text, `${path} must look exactly like a missing page`);
      }
    }
  });

  test('/doc?id= gives hidden docs the same 404 as an id that does not exist', async () => {
    const missing = await get('/doc?id=2147483000');
    assert.equal(missing.status, 404);
    for (const doc of HIDDEN) {
      const res = await get(`/doc?id=${ids.get(doc.slug)}`);
      assert.equal(res.status, 404, doc.slug);
      assert.equal(res.text, missing.text, `${doc.slug} must look exactly like a missing id`);
    }
    const published = await get(`/doc?id=${ids.get(PUBLISHED.slug)}`);
    assert.equal(published.status, 302);
    assert.equal(published.location, `/wiki/vis-root/${PUBLISHED.slug}`);
  });

  test('search finds the published doc and none of the hidden ones', async () => {
    const res = await get('/search?q=visquartz');
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(PUBLISHED.title));
    assertNoHiddenTitles(res.text, 'search results');
  });

  test('search for a word only hidden docs contain finds nothing', async () => {
    const res = await get(`/search?q=${HIDDEN_ONLY_WORD}`);
    assert.equal(res.status, 200);
    assertNoHiddenTitles(res.text, 'search results');
    assert.ok(!res.text.includes(PUBLISHED.title));
  });

  test('the home page lists only published docs and categories with a published doc', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.text.includes(PUBLISHED.title));
    assertNoHiddenTitles(res.text, 'the home page');
    assert.ok(res.text.includes('Vis Root'));
    assert.ok(!res.text.includes('Vis Hidden Only'), 'a category holding only hidden docs must not be listed');
  });

  test('category pages show only published docs, and a category with none is a 404', async () => {
    const root = await get('/category/vis-root');
    assert.equal(root.status, 200);
    assert.ok(root.text.includes(PUBLISHED.title));
    assertNoHiddenTitles(root.text, 'the category page');
    assert.ok(!root.text.includes('Vis Child'), 'a subcategory holding only hidden docs must not be listed');

    const missing = await get('/category/vis-no-such-category');
    assert.equal(missing.status, 404);
    for (const path of ['/category/vis-hidden', '/category/vis-root/vis-child']) {
      const res = await get(path);
      assert.equal(res.status, 404, path);
      assert.equal(res.text, missing.text, `${path} must look exactly like a missing category`);
    }
  });

  test('the published doc page does not list hidden docs as backlinks', async () => {
    const res = await get(`/wiki/vis-root/${PUBLISHED.slug}`);
    assert.equal(res.status, 200);
    assertNoHiddenTitles(res.text, 'the backlinks');
  });

  test('reader counts include only published docs', async () => {
    const tree = await loadTree(db.pool);
    const counts = await publishedSubtreeCounts(db.pool, tree);
    const byPath = (path) => tree.nodes.find((n) => n.path === path);
    assert.equal(counts.get(byPath('vis-root').id), 1);
    assert.equal(counts.get(byPath('vis-root/vis-child').id), 0);
    assert.equal(counts.get(byPath('vis-hidden').id), 0);
  });

  test('unpublishing hides a doc at once, and publishing shows it again', async () => {
    const id = ids.get(PUBLISHED.slug);
    await db.pool.query('UPDATE docs SET published = 0, status = ? WHERE id = ?', ['unpublished', id]);
    try {
      const missing = await get('/wiki/vis-no-such-doc');
      const hidden = await get(`/wiki/vis-root/${PUBLISHED.slug}`);
      assert.equal(hidden.status, 404);
      assert.equal(hidden.text, missing.text);
      assert.ok(!(await get('/search?q=visquartz')).text.includes(PUBLISHED.title));
    } finally {
      await db.pool.query('UPDATE docs SET published = 1, status = ? WHERE id = ?', ['published', id]);
    }
    assert.equal((await get(`/wiki/vis-root/${PUBLISHED.slug}`)).status, 200);
  });
});
