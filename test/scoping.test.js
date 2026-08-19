// Per-member document isolation.
//
// The promise is narrow and absolute: a question asked by one member draws on
// that member's folder and the shared folder, and on nothing else. These tests
// pin the two ways that promise breaks quietly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopesFor, SHARED_REF } from '../src/db.js';

test('a member reads their own folder and the shared one — nothing else', () => {
  const s = scopesFor('user-123');
  assert.deepEqual(s, ['shared', 'member:user-123']);
  assert.ok(!s.includes('member:user-456'), 'another member leaked in');
});

test('no identity reads nothing', () => {
  // Empty, NOT ['shared']. An unidentified caller is not a colleague with
  // limited access; it is a request we cannot attribute, and the search layer
  // turns [] into "match nothing".
  assert.deepEqual(scopesFor(''), []);
  assert.deepEqual(scopesFor(null), []);
  assert.deepEqual(scopesFor(undefined), []);
});

test('an empty scope list must never be built into a Qdrant filter', async () => {
  // Qdrant treats `should: []` as an empty constraint — it matches EVERYTHING.
  // So the one case that must never reach the filter builder is the one that
  // means "may read nothing". search() short-circuits before the query; this
  // test pins that the short-circuit is still there by reading the source,
  // because the failure is silent and total.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/qdrant.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /Array\.isArray\(scopes\)\s*&&\s*scopes\.length === 0\)\s*return \[\]/,
    'search() no longer short-circuits on an empty scope list — an empty '
    + 'should[] in Qdrant matches every document in the workspace',
  );
});

test('the shared sentinel resolves to shared, not to a member nobody is', () => {
  assert.equal(SHARED_REF, '__shared__');
  assert.ok(!scopesFor('anyone').includes(`member:${SHARED_REF}`));
});
