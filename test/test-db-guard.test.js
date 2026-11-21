// The guard that keeps database tests away from the project database
// (brainstorm 5.18): a name must end in _test, and nothing connects before that is checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTestDatabaseName, openTestDatabase } from '../scripts/lib/test-db.js';

test('a name ending in _test is accepted', () => {
  assert.equal(assertTestDatabaseName('MDpedia_test'), 'MDpedia_test');
  assert.equal(assertTestDatabaseName('other_project_test'), 'other_project_test');
});

test('the real database name is refused, with a message that says why', () => {
  assert.throws(() => assertTestDatabaseName('MDpedia'), /Refusing to run.*must end in "_test"/);
});

test('names that only look like test databases are refused', () => {
  for (const name of ['', undefined, null, '_test', 'MDpedia_test2', 'MDpedia_testing', 'MDpedia-test', 'x; DROP DATABASE y;_test', 'MDpedia_TEST ']) {
    assert.throws(() => assertTestDatabaseName(name), /Refusing to run/, String(name));
  }
});

test('opening the test database does nothing when TEST_DB_NAME is unset', () => {
  assert.equal(openTestDatabase({}), null);
});

test('opening the test database is refused for the real name, before any connection', () => {
  assert.throws(() => openTestDatabase({ TEST_DB_NAME: 'MDpedia' }), /Refusing to run/);
});
