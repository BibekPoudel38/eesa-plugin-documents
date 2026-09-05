// Two halves of one log that sampled differently would give two different
// answers to "how often". These pin the plugin's rule to the backend's.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { shouldKeep, routeOf } from '../src/telemetry.js';

describe('what the plugin keeps', () => {
  test('a failure is never sampled away', () => {
    assert.deepEqual(shouldKeep({ status: 500, durationMs: 3, method: 'GET' }),
      { keep: true, sampled: false });
    assert.deepEqual(shouldKeep({ status: 403, durationMs: 3, method: 'GET' }),
      { keep: true, sampled: false });
  });

  test('a slow success is never sampled away', () => {
    assert.deepEqual(shouldKeep({ status: 200, durationMs: 2500, method: 'GET' }),
      { keep: true, sampled: false });
  });

  test('a punch is a write, and writes are always kept', () => {
    // The whole point: a check-in must never be the row that got thinned out.
    assert.deepEqual(shouldKeep({ status: 200, durationMs: 5, method: 'POST' }),
      { keep: true, sampled: false });
  });

  test('fast reads are thinned but not silenced', () => {
    let kept = 0;
    for (let i = 0; i < 4000; i++) {
      if (shouldKeep({ status: 200, durationMs: 5, method: 'GET' }).keep) kept++;
    }
    assert.ok(kept > 60 && kept < 340, `kept ${kept}`);
  });
});

describe('the route is a pattern', () => {
  test('an id in the path does not become its own row', () => {
    assert.equal(
      routeOf({ baseUrl: '', route: { path: '/api/admin/events/:id' }, method: 'DELETE' }),
      '/api/admin/events/:id',
    );
  });

  test('an unrouted request still reports something', () => {
    assert.equal(routeOf({ originalUrl: '/api/nope?x=1', path: '' }), '/api/nope');
  });
});
