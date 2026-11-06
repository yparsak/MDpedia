import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle } from '../app/services/throttle.js';

const MIN = 60 * 1000;

function setup(maxFails = 5) {
  let t = 1_000_000;
  const throttle = createThrottle({ maxFails, now: () => t });
  return { throttle, advance: (ms) => (t += ms) };
}

test('failures below the limit do not block, and the delay grows', () => {
  const { throttle } = setup();
  const delays = [];
  for (let i = 0; i < 4; i++) {
    const r = throttle.recordFailure('1.2.3.4');
    assert.equal(r.blocked, false);
    delays.push(r.delayMs);
  }
  assert.deepEqual(delays, [0, 500, 1000, 1500]);
  assert.equal(throttle.check('1.2.3.4').blocked, false);
});

test('the fifth failure blocks for 15 minutes, then the block ends', () => {
  const { throttle, advance } = setup();
  let last;
  for (let i = 0; i < 5; i++) last = throttle.recordFailure('1.2.3.4');
  assert.equal(last.blocked, true);
  assert.equal(last.justBlocked, true);

  advance(14 * MIN);
  const during = throttle.check('1.2.3.4');
  assert.equal(during.blocked, true);
  assert.equal(during.retryAfterSeconds, 60);

  advance(1 * MIN + 1);
  assert.equal(throttle.check('1.2.3.4').blocked, false);
});

test('failures older than 15 minutes stop counting', () => {
  const { throttle, advance } = setup();
  for (let i = 0; i < 4; i++) throttle.recordFailure('1.2.3.4');
  advance(16 * MIN);
  assert.equal(throttle.recordFailure('1.2.3.4').blocked, false);
});

test('keys are independent, and a success resets the count', () => {
  const { throttle } = setup(2);
  throttle.recordFailure('a');
  assert.equal(throttle.check('b').blocked, false);
  throttle.reset('a');
  assert.equal(throttle.recordFailure('a').blocked, false);
});
