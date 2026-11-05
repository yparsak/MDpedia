import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, summarize } from '../app/config.js';

const valid = {
  DB_HOST: '127.0.0.1',
  DB_NAME: 'MDpedia',
  DB_USER: 'MDpedia_app',
  DB_PASSWORD: 'db-secret-value',
  DOCS_DIR: '/srv/MDpedia-data/docs',
  STAGING_DIR: '/srv/MDpedia-data/staging',
  DATA_DIR: '/srv/MDpedia-data',
  SESSION_SECRET: 'x'.repeat(32),
};

test('valid values load and defaults apply', () => {
  const r = loadConfig(valid);
  assert.equal(r.ok, true);
  assert.equal(r.config.server.port, 3000);
  assert.equal(r.config.uploads.maxBytes, 262144);
});

test('COOKIE_SECURE=false is the boolean false, not the truthy string', () => {
  const r = loadConfig({ ...valid, COOKIE_SECURE: 'false' });
  assert.equal(r.config.session.cookieSecure, false);
  assert.equal(loadConfig({ ...valid, COOKIE_SECURE: 'true' }).config.session.cookieSecure, true);
});

test('a boolean that is not exactly true or false is rejected', () => {
  const r = loadConfig({ ...valid, COOKIE_SECURE: 'yes' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^COOKIE_SECURE:/);
});

test('PORT=abc is rejected and the message names PORT', () => {
  const r = loadConfig({ ...valid, PORT: 'abc' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^PORT:/);
});

test('PORT out of range is rejected', () => {
  assert.equal(loadConfig({ ...valid, PORT: '70000' }).ok, false);
  assert.equal(loadConfig({ ...valid, PORT: '0' }).ok, false);
});

test('an empty required value is reported by name', () => {
  const r = loadConfig({ ...valid, DB_PASSWORD: '' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^DB_PASSWORD:/);
});

test('a short session secret is rejected', () => {
  assert.equal(loadConfig({ ...valid, SESSION_SECRET: 'short' }).ok, false);
});

test('relative paths are rejected', () => {
  assert.equal(loadConfig({ ...valid, DOCS_DIR: 'docs' }).ok, false);
});

test('all search weights at zero is rejected', () => {
  const zeros = Object.fromEntries(
    ['TITLE', 'KEYWORD', 'PHRASE', 'SYNONYM', 'QUESTION', 'SUMMARY', 'BODY'].map((k) => [`SEARCH_WEIGHT_${k}`, '0']),
  );
  assert.equal(loadConfig({ ...valid, ...zeros }).ok, false);
  assert.equal(loadConfig({ ...valid, ...zeros, SEARCH_WEIGHT_BODY: '1' }).ok, true);
});

test('the summary never contains a secret', () => {
  const text = summarize(loadConfig({ ...valid, AI_API_KEY: 'nvapi-secret-key' }).config).join('\n');
  assert.equal(text.includes('db-secret-value'), false);
  assert.equal(text.includes('nvapi-secret-key'), false);
  assert.equal(text.includes('x'.repeat(32)), false);
});
