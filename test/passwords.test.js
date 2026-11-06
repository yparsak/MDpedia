import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, passwordProblems } from '../app/services/passwords.js';

test('a hash verifies the right password and rejects a wrong one', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batterz', hash), false);
});

test('the same password hashes differently each time (random salt)', async () => {
  assert.notEqual(await hashPassword('same password here'), await hashPassword('same password here'));
});

test('a malformed stored hash is a failed login, not a crash', async () => {
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(await verifyPassword('anything', null), false);
  assert.equal(await verifyPassword('anything', 'scrypt$x$y$z$AAAA$BBBB'), false);
});

test('a password over the length cap is refused without hashing', async () => {
  const hash = await hashPassword('a decent password');
  assert.equal(await verifyPassword('x'.repeat(5000), hash), false);
});

test('too short is refused, and the message says how long it is', () => {
  const problems = passwordProblems('short', { minLength: 12 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /at least 12 characters \(this has 5\)/);
});

test('length counts characters, not bytes', () => {
  assert.deepEqual(passwordProblems('ççççççççççççx', { minLength: 12 }), []);
});

test('common passwords are refused whatever the case', () => {
  assert.equal(passwordProblems('PassWord12345', { minLength: 12 }).length, 1);
});

test('a single repeated character and the user name are refused', () => {
  assert.equal(passwordProblems('aaaaaaaaaaaaaaaa', { minLength: 12 }).length, 1);
  assert.equal(passwordProblems('administrator-x', { minLength: 12, username: 'Administrator-X' }).length, 1);
});

test('a plain long phrase is accepted: no complexity rules', () => {
  assert.deepEqual(passwordProblems('thisisalongpassphrase', { minLength: 12 }), []);
});
