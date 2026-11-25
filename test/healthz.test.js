// /healthz is 200 only when the database answers and every started background
// loop is alive, and it says nothing else.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../app/config.js';
import { createApp } from '../app/app.js';
import { createLoopMonitor } from '../app/services/loops.js';

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

async function start({ dbUp = true, loops = null } = {}) {
  const state = { dbUp };
  const pool = {
    async query() {
      if (!state.dbUp) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return [[{ 1: 1 }]];
    },
  };
  const { config } = loadConfig(env);
  const server = await new Promise((resolve) => {
    const s = createApp({ config, pool, loops }).listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, state };
}

after(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))));

test('healthy: the database answers and there are no loops', async () => {
  const { base } = await start();
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('fails when the database does not answer, and recovers when it does', async () => {
  const { base, state } = await start({ dbUp: false });
  const down = await fetch(`${base}/healthz`);
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { status: 'fail' });
  state.dbUp = true;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('fails when a started loop has gone silent, and recovers on its next beat', async () => {
  let now = 1_000_000;
  const loops = createLoopMonitor(() => now);
  loops.register('ai-worker', 60_000);
  const { base } = await start({ loops });

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  now += 59_000;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  now += 2_000;
  const stalled = await fetch(`${base}/healthz`);
  assert.equal(stalled.status, 503);
  assert.deepEqual(await stalled.json(), { status: 'fail' }, 'no detail about which check failed');
  loops.beat('ai-worker');
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('a loop that was never registered cannot fail the check', async () => {
  const loops = createLoopMonitor();
  loops.beat('ai-worker');
  assert.equal(loops.allAlive(), true);
  loops.register('ai-worker', 10);
  loops.unregister('ai-worker');
  assert.equal(loops.allAlive(), true);
});
