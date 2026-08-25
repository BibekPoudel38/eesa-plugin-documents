// Letting a member open their OWN folder.
//
// The member folders live in the workspace's connected Drive, owned by
// whoever attached it. Creating a folder named after somebody grants them
// nothing, so every "Saved to your Drive folder — here is the link" message
// pointed at a file the recipient got a 403 on. That reads as "the drive does
// not work", and it is invisible from our side: the upload genuinely
// succeeded.
//
// ownerGrantPlan is where the decision lives, so it is what gets pinned: who
// is skipped, what role they get, and that Google does not email them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerGrantPlan, grantAlreadyHeld } from '../src/providers/google_drive.js';

const FOLDER = '1AbCdEfGhIjKlMnOpQrStUvWxYz';

test('a member with a folder and no grant yet gets one', () => {
  const plan = ownerGrantPlan({ email: 'jeeva@chupy.com', folderId: FOLDER });
  assert.ok(plan, 'no plan produced — the link would keep 403ing');
  assert.equal(plan.fileId, FOLDER);
  assert.equal(plan.requestBody.emailAddress, 'jeeva@chupy.com');
  assert.equal(plan.requestBody.type, 'user');
});

test('read, not write', () => {
  // Adding and removing files stays with the plugin: a member deleting from
  // Drive directly would leave the search index answering for a file that is
  // no longer there.
  const plan = ownerGrantPlan({ email: 'jeeva@chupy.com', folderId: FOLDER });
  assert.equal(plan.requestBody.role, 'reader');
});

test('Google does not email the member', () => {
  // Folders are created the first time each person touches Documents, so a
  // notification here means every employee gets "somebody shared a folder with
  // you" on deploy day — about a folder they already believed was theirs.
  const plan = ownerGrantPlan({ email: 'jeeva@chupy.com', folderId: FOLDER });
  assert.equal(plan.sendNotificationEmail, false);
});

test('a shared drive still applies the grant', () => {
  // Without supportsAllDrives the call succeeds and the link still fails,
  // which is the same invisible failure this whole change exists to remove.
  const plan = ownerGrantPlan({ email: 'jeeva@chupy.com', folderId: FOLDER });
  assert.equal(plan.supportsAllDrives, true);
});

test('an existing grant is not re-issued', () => {
  // This is what keeps the backfill to one Drive round-trip per person rather
  // than one per upload.
  assert.equal(
    ownerGrantPlan({ email: 'jeeva@chupy.com', folderId: FOLDER, ownerGranted: true }),
    null);
});

test('nobody to grant to, and nothing to grant on, are both skipped', () => {
  // The gateway token shape carries no email. Skipping leaves owner_granted
  // false, so a later call that does carry an address still repairs it.
  assert.equal(ownerGrantPlan({ email: '', folderId: FOLDER }), null);
  assert.equal(ownerGrantPlan({ email: 'jeeva@chupy.com', folderId: '' }), null);
  assert.equal(ownerGrantPlan({}), null);
  assert.equal(ownerGrantPlan(), null);
});

test('a grant that was already there counts as done', () => {
  // Otherwise owner_granted never gets set and every upload re-attempts it.
  assert.equal(grantAlreadyHeld('The user already has access to this file.'), true);
  assert.equal(grantAlreadyHeld('duplicate permission'), true);
});

test('a real failure does NOT count as done', () => {
  // Recording these would strand the member permanently: never granted, never
  // retried, and the link keeps failing with nothing left to notice it.
  assert.equal(grantAlreadyHeld('Insufficient permissions'), false);
  assert.equal(grantAlreadyHeld('Rate Limit Exceeded'), false);
  assert.equal(grantAlreadyHeld('Invalid sharing request: bad email'), false);
  assert.equal(grantAlreadyHeld(''), false);
  assert.equal(grantAlreadyHeld(undefined), false);
});
