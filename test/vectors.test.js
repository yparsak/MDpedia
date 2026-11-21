// Vector search against a stub pool: which SQL the two modes run, that unpublished
// docs and other models are filtered in the same statement, and that the job
// scope keeps embed jobs away from the AI worker. No database, no model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimNext } from '../app/services/jobs.js';
import { enqueueEmbedding } from '../app/services/embed-queue.js';
import { embedDocument, searchVectors } from '../app/services/vectors.js';

const config = { embed: { enabled: true, model: 'm', dtype: 'fp32', dimensions: 3, pooling: 'cls', docPrefix: '' } };

function stubPool(handler = () => [[]]) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return handler(sql, params);
    },
  };
}

test('the exact scan wraps the distance so the index is not used, and filters in the same statement', async () => {
  const pool = stubPool((sql) => (sql.startsWith('EXPLAIN') ? [[{ table: 'v', type: 'ALL', key: null, rows: 3, Extra: 'Using filesort' }]] : [[{ id: 1, slug: 'a', title: 'A', summary: null, distance: '0.25' }]]));
  const found = await searchVectors(pool, config, [0.1, 0.2, 0.3], { limit: 5, mode: 'scan' });
  const select = pool.queries[0];
  assert.match(select.sql, /ORDER BY VEC_DISTANCE_COSINE\(v\.embedding, VEC_FromText\(\?\)\) \+ 0 LIMIT \?/);
  assert.match(select.sql, /d\.published = 1 AND v\.model = \? AND v\.pooling = \?/);
  assert.deepEqual(select.params, ['[0.1,0.2,0.3]', 'm', 'cls', '[0.1,0.2,0.3]', 5]);
  assert.equal(found.rows[0].distance, 0.25);
  assert.equal(found.rows[0].summary, '');
  assert.ok(pool.queries[1].sql.startsWith('EXPLAIN '));
  assert.equal(found.plan[0].key, '');
  assert.match(found.sql, /VEC_FromText\('\[0\.0123, \.\.\.\]'\)|VEC_FromText\('\[0\.1,0\.2,0\.3\]'\)/);
});

test('the index mode sorts by the bare distance in a subquery that over-fetches, then filters', async () => {
  const pool = stubPool((sql) => (sql.startsWith('EXPLAIN') ? [[]] : [[]]));
  await searchVectors(pool, config, [0.1, 0.2, 0.3], { limit: 10, mode: 'index' });
  const select = pool.queries[0];
  assert.match(select.sql, /ORDER BY VEC_DISTANCE_COSINE\(v\.embedding, VEC_FromText\(\?\)\) LIMIT \?\) c/);
  assert.doesNotMatch(select.sql.split(') c')[0], /\+ 0/);
  assert.match(select.sql, /WHERE d\.published = 1 AND c\.model = \? AND c\.pooling = \?/);
  assert.equal(select.params[2], 50, 'the inner limit is the page plus the extra rows');
  assert.equal(select.params[5], 10);
});

test('a query vector of the wrong length never reaches the database', async () => {
  const pool = stubPool();
  await assert.rejects(() => searchVectors(pool, config, [1, 2], { mode: 'scan' }), /Expected a vector of 3/);
  assert.equal(pool.queries.length, 0);
});

test('queueing does nothing when vector search is off', async () => {
  const pool = stubPool();
  assert.equal(await enqueueEmbedding(pool, { embed: { enabled: false } }, 1), false);
  assert.equal(await enqueueEmbedding(pool, {}, 1), false);
  assert.equal(pool.queries.length, 0);
});

test('queueing adds a job only for a published doc without a waiting one, and a failure is swallowed', async () => {
  const pool = stubPool(() => [{ affectedRows: 1 }]);
  assert.equal(await enqueueEmbedding(pool, config, 7), true);
  const { sql, params } = pool.queries[0];
  assert.match(sql, /d\.published = 1/);
  assert.match(sql, /NOT EXISTS/);
  assert.deepEqual(params, ['embed', 7, 'embed']);

  const broken = stubPool(() => {
    throw Object.assign(new Error('boom'), { code: 'ER_NO_SUCH_TABLE' });
  });
  assert.equal(await enqueueEmbedding(broken, config, 7), false);
});

test('the AI worker never claims an embed job, and the embed worker claims only those', async () => {
  const pool = stubPool(() => [[]]);
  await claimNext(pool);
  await claimNext(pool, { embed: true });
  assert.match(pool.queries[0].sql, /type <> 'embed'/);
  assert.match(pool.queries[1].sql, /type = 'embed'/);
});

test('an unchanged document is not embedded again, and an unpublished one is skipped', async () => {
  const embedder = {
    embed() {
      throw new Error('the model must not be called');
    },
  };
  const none = stubPool(() => [[]]);
  assert.equal(await embedDocument(none, config, embedder, 1), 'skipped');

  // Same text and settings as the stored hash: the hash is recomputed, so read it back from the stub.
  const { buildEmbedText, embedInputHash } = await import('../app/services/embed-text.js');
  const hash = embedInputHash(buildEmbedText({ title: 'T', summary: 'S', keywords: [], questions: [] }), config.embed);
  const pool = stubPool((sql) => {
    if (sql.startsWith('SELECT id, title, summary FROM docs')) return [[{ id: 1, title: 'T', summary: 'S' }]];
    if (sql.includes('FROM doc_terms')) return [[]];
    return [[{ input_hash: hash, model: 'm', pooling: 'cls' }]];
  });
  assert.equal(await embedDocument(pool, config, embedder, 1), 'unchanged');
});
