// The `?scope=` browse gate.
//
// The Drive-style UI lets you click a folder in the sidebar and see just that
// folder, which means the browser now names a scope in the request. That name
// is a permission boundary: a member naming somebody else's folder must be
// REFUSED, not quietly given their own set back. Silently widening — or
// silently narrowing — a request somebody was not allowed to make is how a
// file browser ends up showing the wrong person's files with nobody noticing.
//
// requestedScope lives in web.js precisely so this file can import it; server.js
// calls app.listen() at import time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestedScope } from '../src/web.js';

const MEMBER = { master: false, mine: 'member:7' };
const MASTER = { master: true, mine: 'member:1' };

test('no scope means "use the caller\'s own readable set"', () => {
  // undefined, NOT null — null is a refusal, and confusing the two would turn
  // an ordinary listing into a 404.
  assert.equal(requestedScope(undefined, MEMBER), undefined);
  assert.equal(requestedScope('', MEMBER), undefined);
  assert.equal(requestedScope('   ', MEMBER), undefined);
});

test('a member may open their own folder and Shared', () => {
  assert.equal(requestedScope('member:7', MEMBER), 'member:7');
  assert.equal(requestedScope('shared', MEMBER), 'shared');
});

test('a member naming SOMEONE ELSE\'s folder is refused', () => {
  assert.equal(requestedScope('member:9', MEMBER), null);
});

test('a master admin may open anybody\'s folder', () => {
  assert.equal(requestedScope('member:9', MASTER), 'member:9');
  assert.equal(requestedScope('shared', MASTER), 'shared');
});

test('an unrecognised scope is refused, not passed through', () => {
  // The value reaches a SQL parameter, so it is bound rather than
  // interpolated — but a scope nobody owns must still not be answerable.
  assert.equal(requestedScope('../etc/passwd', MEMBER), null);
  assert.equal(requestedScope("member:7' or '1'='1", MEMBER), null);
  assert.equal(requestedScope('everyone', MEMBER), null);
});

test('a caller with no identity cannot name any folder', () => {
  // scopesFor('') returns [], so `mine` is empty and nothing can match it.
  assert.equal(requestedScope('member:7', { master: false, mine: '' }), null);
  assert.equal(requestedScope('shared', { master: false, mine: '' }), 'shared');
});

test('defaults are the closed ones', () => {
  // Called with no options at all: not a master, no folder of their own.
  assert.equal(requestedScope('member:7'), null);
});
