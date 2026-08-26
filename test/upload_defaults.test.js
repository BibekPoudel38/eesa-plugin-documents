// Two defaults that decide whether a file is usable at all.
//
// Both exist because of the same fact about this workspace: the drive belongs
// to one Google account and the Eesa logins are not Google accounts, so there
// is no per-person grant to fall back on. A file that is not published is a
// file its own uploader cannot open, and a folder named after a numeric ref is
// a folder nobody can identify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishOnUpload } from '../src/web.js';
import { shouldRenameMemberFolder } from '../src/providers/google_drive.js';

test('an upload publishes unless it explicitly says not to', () => {
  // The app's own Upload button sends no flag at all — that is the case that
  // used to produce a link opening for nobody.
  assert.equal(publishOnUpload(undefined), true);
  assert.equal(publishOnUpload(null), true);
  assert.equal(publishOnUpload(''), true);
  assert.equal(publishOnUpload('true'), true);
});

test('only a literal false opts out', () => {
  assert.equal(publishOnUpload('false'), false);
  assert.equal(publishOnUpload('False'), false);
  assert.equal(publishOnUpload(' FALSE '), false);
  assert.equal(publishOnUpload(false), false);
});

test('junk publishes rather than silently not publishing', () => {
  // Guessing wrong this way gives a working link on a file that did not need
  // one. Guessing wrong the other way gives a link that fails for the person
  // it was handed to, and nothing says why.
  assert.equal(publishOnUpload('no'), true);
  assert.equal(publishOnUpload('0'), true);
  assert.equal(publishOnUpload({}), true);
});

test('a folder named after the numeric ref gets the address once we learn it', () => {
  assert.equal(shouldRenameMemberFolder({ email: 'anbu@chupy.com', knownEmail: '' }), true);
  assert.equal(shouldRenameMemberFolder({ email: 'anbu@chupy.com', knownEmail: null }), true);
  assert.equal(shouldRenameMemberFolder({ email: 'anbu@chupy.com', knownEmail: '   ' }), true);
});

test('a folder that already has an address is left alone', () => {
  // Somebody may have renamed it deliberately. Overruling that on their next
  // upload would be worse than an out-of-date name.
  assert.equal(
    shouldRenameMemberFolder({ email: 'new@chupy.com', knownEmail: 'old@chupy.com' }), false);
});

test('no address to rename to means no rename', () => {
  // The gateway token shape carries no email. Renaming to '' would replace a
  // poor name with none at all.
  assert.equal(shouldRenameMemberFolder({ email: '', knownEmail: '' }), false);
  assert.equal(shouldRenameMemberFolder({}), false);
  assert.equal(shouldRenameMemberFolder(), false);
});
