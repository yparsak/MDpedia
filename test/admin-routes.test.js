// Routes that never need the database: no cookie means no session lookup, and a
// bad form token is refused before any query. The pool is a stub that fails the
// test if it is used.

import { test, before, after } from 'node:test';
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

const pool = {
  query() {
    throw new Error('the database must not be used by these routes');
  },
};

let server;
let base;

before(async () => {
  const { config } = loadConfig(env);
  const app = createApp({ config, pool });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('/admin while logged out redirects to the login page', async () => {
  const res = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/login');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('every admin page redirects when logged out', async () => {
  for (const path of ['/admin/audit', '/admin/password']) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.get('location'), '/admin/login', path);
  }
});

test('the login page renders with a form token and no cache', async () => {
  const res = await fetch(`${base}/admin/login`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(await res.text(), /name="_csrf" value="\d+\.[0-9a-f]+\.[0-9a-f]{64}"/);
});

test('a login post without a valid form token is refused before any lookup', async () => {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'whatever-it-is', _csrf: 'forged' }),
  });
  assert.equal(res.status, 403);
});

test('an unknown ?msg= value shows no text of its own', async () => {
  const res = await fetch(`${base}/admin/login?msg=%3Cb%3Ehello%3C/b%3E`);
  assert.doesNotMatch(await res.text(), /hello/);
});
