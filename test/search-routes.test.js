// The reader search routes against a stub pool that holds no documents. Search
// is read-only apart from its own log, so the stub answers every SELECT with no
// rows and every write with an insert id, and records what ran.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../app/config.js';
import { createApp } from '../app/app.js';

const env = {
  DB_HOST: '127.0.0.1',
  DB_NAME: 'MDpedia',
  DB_USER: 'MDpedia_app',
  DB_PASSWORD: 'db-secret-value',
  DOCS_DIR: '/srv/MDpedia-data/docs',
  STAGING_DIR: '/srv/MDpedia-data/staging',
  DATA_DIR: '/srv/MDpedia-data',
  SESSION_SECRET: 'x'.repeat(32),
};

const servers = [];

async function start(extraEnv = {}) {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return /^\s*SELECT/i.test(sql) ? [[]] : [{ insertId: 7, affectedRows: 1 }];
    },
  };
  const { config } = loadConfig({ ...env, ...extraEnv });
  const server = await new Promise((resolve) => {
    const s = createApp({ config, pool }).listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, queries };
}

after(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))));

test('the search page without a query shows the form and uses no database', async () => {
  const { base, queries } = await start();
  const res = await fetch(`${base}/search`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(await res.text(), /action="\/search" method="get"/);
  assert.equal(queries.length, 0);
});

test('a query of only operators is told to type a word, and costs nothing', async () => {
  const { base, queries } = await start();
  const res = await fetch(`${base}/search?q=${encodeURIComponent('+ - ( ) ~ *')}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Type at least one word/);
  assert.equal(queries.length, 0);
});

test('no results shows the message and a link to browse the categories, and logs the search', async () => {
  const { base, queries } = await start();
  const res = await fetch(`${base}/search?q=nothing-here`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /No documents match/);
  assert.match(html, /<a href="\/">Browse the categories<\/a>/);
  const insert = queries.find((q) => /INSERT INTO search_log/.test(q.sql));
  assert.deepEqual(insert.params, ['nothing-here', 0, 0]);
  assert.ok(queries.some((q) => /INSERT INTO search_daily/.test(q.sql)));
});

test('the query is escaped on the page', async () => {
  const { base } = await start();
  const html = await (await fetch(`${base}/search?q=${encodeURIComponent('<script>alert(1)</script>')}`)).text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('no IP address or session is ever written with a search', async () => {
  const { base, queries } = await start();
  await fetch(`${base}/search?q=calculus`);
  for (const q of queries.filter((x) => /search_log|search_daily/.test(x.sql))) {
    assert.doesNotMatch(q.sql, /\bip\b|session/i);
    assert.doesNotMatch(JSON.stringify(q.params), /127\.0\.0\.1|::1/);
  }
});

test('over the rate limit a search is refused with a clear message', async () => {
  const { base, queries } = await start({ RATE_SEARCH_PER_MIN: '3' });
  for (let i = 0; i < 3; i += 1) assert.equal((await fetch(`${base}/search?q=calculus`)).status, 200);
  const before = queries.length;
  const res = await fetch(`${base}/search?q=calculus`);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
  assert.match(await res.text(), /Too many searches/);
  assert.equal(queries.length, before);
});

test('a click on a doc that is not published is the generic 404 and records nothing', async () => {
  const { base, queries } = await start();
  for (const url of ['/search/click?d=5&l=1', '/search/click?d=abc&l=1', '/search/click']) {
    const res = await fetch(`${base}${url}`, { redirect: 'manual' });
    assert.equal(res.status, 404, url);
  }
  assert.equal(queries.some((q) => /^\s*UPDATE/i.test(q.sql)), false);
});
