// The content security policy: scripts strict, inline styles allowed only as
// attributes (KaTeX writes style="..." on its output), nothing inline for scripts.

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

const pool = { query: async () => [[{ 1: 1 }]] };
let server;
const directives = (async () => {
  const { config } = loadConfig(env);
  server = await new Promise((resolve) => {
    const s = createApp({ config, pool }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  const header = res.headers.get('content-security-policy');
  return Object.fromEntries(header.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
})();

after(() => new Promise((resolve) => server.close(resolve)));

test('scripts are limited to the site itself', async () => {
  const csp = await directives;
  assert.deepEqual(csp['script-src'], ["'self'"]);
  assert.deepEqual(csp['script-src-attr'], ["'none'"], 'no inline event handlers');
  assert.ok(!JSON.stringify(csp).includes("'unsafe-eval'"));
});

test('KaTeX style attributes are allowed, style elements are not', async () => {
  const csp = await directives;
  assert.deepEqual(csp['style-src'], ["'self'"]);
  assert.deepEqual(csp['style-src-attr'], ["'unsafe-inline'"]);
});

test('plugins, framing and form targets are locked down', async () => {
  const csp = await directives;
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
  assert.deepEqual(csp['base-uri'], ["'self'"]);
  assert.deepEqual(csp['form-action'], ["'self'"]);
  assert.deepEqual(csp['default-src'], ["'self'"]);
});
