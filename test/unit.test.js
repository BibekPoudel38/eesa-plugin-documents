// Unit tests for the pieces where a mistake is a security bug rather than a
// visible glitch: HTML escaping, the signed OAuth state, token encryption, and
// per-tenant collection naming.
//
// Run: npm test   (node:test, built in — no test framework dependency)
//
// A 32-byte key must exist before src/crypto.js is imported, so it is set here
// rather than in a fixture.
process.env.PLUGIN_ENC_KEY = process.env.PLUGIN_ENC_KEY
  || '0'.repeat(64);

import test from 'node:test';
import assert from 'node:assert/strict';

import { esc, page, makeState, readState, STATE_TTL_MS } from '../src/web.js';
import { encrypt, decrypt } from '../src/crypto.js';
import { collectionFor } from '../src/qdrant.js';

// ---------------------------------------------------------------- escaping --
test('esc neutralises every character that could break out of HTML text', () => {
  assert.equal(esc('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc(`" onload="x`), '&quot; onload=&quot;x');
  assert.equal(esc("' onerror='x"), '&#39; onerror=&#39;x');
  assert.equal(esc('a & b'), 'a &amp; b');
});

test('esc handles null and undefined without printing them', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('the callback page cannot be injected through the provider error param', () => {
  // This is the exact shape of the reflected-XSS bug this guards: the provider
  // controls `error`, and it lands in the page body.
  const html = page('Connection cancelled', esc('<img src=x onerror=alert(1)>'));
  assert.ok(!html.includes('<img'), 'raw tag survived into the page');
  assert.ok(html.includes('&lt;img'), 'escaped form missing');
});

// ------------------------------------------------------------------- state --
test('state round-trips the tenant, user and provider', () => {
  const st = readState(makeState('tenant-abc', 'user-1', 'google_drive'));
  assert.equal(st.t, 'tenant-abc');
  assert.equal(st.s, 'user-1');
  assert.equal(st.p, 'google_drive');
});

test('a tampered state is rejected, not silently accepted', () => {
  const good = makeState('tenant-abc', 'user-1', 'google_drive');
  const tampered = good.slice(0, -4) + 'AAAA';
  assert.equal(readState(tampered), null);
});

test('an expired state is rejected', () => {
  const s = makeState('tenant-abc', 'user-1', 'google_drive');
  // Just inside the window still works; just outside does not.
  assert.notEqual(readState(s, { now: Date.now() + STATE_TTL_MS - 1000 }), null);
  assert.equal(readState(s, { now: Date.now() + STATE_TTL_MS + 1000 }), null);
});

test('garbage and empty state are rejected without throwing', () => {
  for (const bad of ['', null, undefined, 'not-encrypted', '...', 'a.b.c']) {
    assert.equal(readState(bad), null, `accepted: ${String(bad)}`);
  }
});

// ------------------------------------------------------------------ crypto --
test('token encryption round-trips', () => {
  // Deliberately not shaped like a real Google token: a `ya29.` prefix here
  // would trip push-protection secret scanners on every clone and push.
  const secret = 'fake-refresh-token-for-tests';
  const blob = encrypt(secret);
  assert.notEqual(blob, secret, 'stored value must not be the plaintext');
  assert.equal(decrypt(blob), secret);
});

test('encrypting the same value twice gives different ciphertext', () => {
  // A fresh IV per call — otherwise equal tokens are visibly equal at rest.
  assert.notEqual(encrypt('same'), encrypt('same'));
});

test('a corrupted ciphertext throws rather than returning wrong plaintext', () => {
  const blob = encrypt('sensitive');
  const [iv, tag, data] = blob.split('.');
  const flipped = [iv, tag, data.slice(0, -2) + (data.endsWith('AA') ? 'BB' : 'AA')].join('.');
  assert.throws(() => decrypt(flipped));
});

// ------------------------------------------------------- collection naming --
test('collection names are per-tenant and stable', () => {
  const a = collectionFor('11111111-2222-3333-4444-555555555555');
  const b = collectionFor('99999999-2222-3333-4444-555555555555');
  assert.notEqual(a, b, 'two tenants must not share a collection');
  assert.equal(a, collectionFor('11111111-2222-3333-4444-555555555555'));
});

test('collection names strip anything that is not safe in a URL path', () => {
  // Slashes and dots go entirely, so a traversal-shaped id cannot address
  // another collection. The name lands in a Qdrant URL path.
  const name = collectionFor('abc/../../admin');
  assert.equal(name, 'eesa_docs_abcadmin');
  assert.ok(!name.includes('/') && !name.includes('.'));
  assert.match(collectionFor('AB-12_cd'), /^eesa_docs_[a-z0-9_-]+$/);
});

test('an empty tenant id is refused rather than collapsing to a shared name', () => {
  // Without this, a falsy tenant would silently produce one collection every
  // such caller shares.
  assert.throws(() => collectionFor(''));
  assert.throws(() => collectionFor(null));
  assert.throws(() => collectionFor('///'));
});

// ---------------------------------------------------------------------------
// What a member's folder is called
// ---------------------------------------------------------------------------
// It used to be `email || employeeRef`, so a token carrying no email claim
// produced a folder called "36" — unidentifiable in Drive, and listed as "36"
// in the admin roster with no way to tell whose it was.
import { memberFolderName } from '../src/providers/google_drive.js';

test('the name and the ref both appear', () => {
  assert.equal(
    memberFolderName({ employeeRef: '39', name: 'Jeeva Kumar', email: 'j@x.com' }),
    'Jeeva Kumar (39)');
});

test('the email stands in when there is no name', () => {
  assert.equal(
    memberFolderName({ employeeRef: '39', email: 'jeeva@chupy.com' }),
    'jeeva@chupy.com (39)');
});

test('the ref alone is still better than nothing', () => {
  assert.equal(memberFolderName({ employeeRef: '39' }), '39');
  assert.equal(memberFolderName({ employeeRef: 39 }), '39');
});

test('blank human parts do not leave dangling punctuation', () => {
  assert.equal(memberFolderName({ employeeRef: '39', name: '   ', email: '' }), '39');
});

test('the ref is always present, because it is the only stable key', () => {
  const out = memberFolderName({ employeeRef: '39', name: 'Jeeva' });
  assert.match(out, /39/, 'a folder with no ref cannot be matched back to a person');
});

test('a missing ref does not produce the string "undefined"', () => {
  assert.equal(memberFolderName({ name: 'Jeeva' }), 'Jeeva');
  assert.equal(memberFolderName({}), '');
  assert.equal(memberFolderName(), '');
});

test('a very long name cannot overflow the Drive name limit', () => {
  const out = memberFolderName({ employeeRef: '39', name: 'x'.repeat(500) });
  assert.ok(out.length <= 300, `got ${out.length}`);
});
