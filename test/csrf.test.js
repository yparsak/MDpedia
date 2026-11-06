import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLoginToken, verifyLoginToken, tokensEqual, newToken } from '../app/services/csrf.js';

const secret = 's'.repeat(32);
const HOUR = 60 * 60 * 1000;

test('a fresh login token verifies', () => {
  assert.equal(verifyLoginToken(secret, makeLoginToken(secret)), true);
});

test('a login token expires after two hours', () => {
  const issued = 5_000_000;
  const token = makeLoginToken(secret, issued);
  assert.equal(verifyLoginToken(secret, token, issued + HOUR), true);
  assert.equal(verifyLoginToken(secret, token, issued + 2 * HOUR + 1), false);
});

test('a tampered, foreign or malformed login token is refused', () => {
  const token = makeLoginToken(secret);
  const [issued, nonce, sig] = token.split('.');
  assert.equal(verifyLoginToken(secret, `${issued}.${nonce}.${sig.replace(/.$/, sig.endsWith('0') ? '1' : '0')}`), false);
  assert.equal(verifyLoginToken('t'.repeat(32), token), false);
  assert.equal(verifyLoginToken(secret, 'nonsense'), false);
  assert.equal(verifyLoginToken(secret, undefined), false);
});

test('tokensEqual handles different lengths and non-strings', () => {
  const t = newToken();
  assert.equal(tokensEqual(t, t), true);
  assert.equal(tokensEqual(t, t.slice(1)), false);
  assert.equal(tokensEqual(t, undefined), false);
  assert.equal(tokensEqual(undefined, undefined), false);
});
