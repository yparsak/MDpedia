import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../app/services/rate-limit.js';

test('requests up to the limit pass, the next is refused with a wait time', () => {
  let t = 1000;
  const limiter = createRateLimiter({ limit: 3, windowMs: 60000, now: () => t });
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.hit('1.2.3.4').allowed, true);
  t += 10000;
  assert.deepEqual(limiter.hit('1.2.3.4'), { allowed: false, retryAfterSeconds: 50 });
});

test('the window ends and the count starts again', () => {
  let t = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 60000, now: () => t });
  assert.equal(limiter.hit('a').allowed, true);
  assert.equal(limiter.hit('a').allowed, false);
  t = 60000;
  assert.equal(limiter.hit('a').allowed, true);
});

test('each key has its own count', () => {
  const limiter = createRateLimiter({ limit: 1 });
  assert.equal(limiter.hit('a').allowed, true);
  assert.equal(limiter.hit('b').allowed, true);
  assert.equal(limiter.hit('a').allowed, false);
});

test('a refused request is not counted, so the window still ends on time', () => {
  let t = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
  limiter.hit('a');
  for (let i = 0; i < 5; i += 1) limiter.hit('a');
  t = 1000;
  assert.equal(limiter.hit('a').allowed, true);
});
