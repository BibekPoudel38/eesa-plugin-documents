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
import { ownerGrantPlan, grantSettled, grantSucceeded, PUBLIC_ROLE } from '../src/providers/google_drive.js';

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
  assert.equal(grantSettled('The user already has access to this file.'), true);
  assert.equal(grantSettled('duplicate permission'), true);
  assert.equal(grantSucceeded('The user already has access to this file.'), true);
});

test('an address with no Google account is terminal, not retried', () => {
  // The live workspace signs in as anbu@chupy.com while the drive belongs to
  // chups.com; those logins are not mailboxes, and Drive refuses to grant to
  // them at all while sendNotificationEmail is false. Retrying every upload
  // cannot fix it, so we stop — but it did NOT succeed, and saying otherwise
  // would hide why their link keeps 403ing.
  const err = 'You are trying to invite anbu@chupy.com. Since there is no Google '
            + 'account associated with this email address, you must check the '
            + '"Notify people" box to invite this recipient.';
  assert.equal(grantSettled(err), true, 'would retry forever');
  assert.equal(grantSucceeded(err), false, 'would claim access nobody has');
});

test('a transient failure IS retried', () => {
  // Recording these would strand the member permanently: never granted, never
  // retried, and the link keeps failing with nothing left to notice it.
  for (const m of ['Insufficient permissions', 'Rate Limit Exceeded',
                   'Internal Error', '', undefined]) {
    assert.equal(grantSettled(m), false, `stopped retrying on: ${m}`);
    assert.equal(grantSucceeded(m), false);
  }
});

test('a public link grants EDIT, deliberately', () => {
  // Set on purpose, not by drift. The drive belongs to one Gmail account while
  // the Eesa logins are not Google accounts, so no per-person grant can reach
  // anybody and a read-only link left members unable to work on their own
  // files. The cost is real and should stay visible in a test: anyone holding
  // the link can CHANGE the file, with no account and no further check.
  assert.equal(PUBLIC_ROLE, 'writer');
});

test('the per-member folder grant stays read-only', () => {
  // Different decision from the public link, and it must not follow it: the
  // folder grant is per-person, so read is enough to open what is theirs,
  // while adding and removing files stays with the plugin and the index.
  assert.equal(
    ownerGrantPlan({ email: 'a@b.com', folderId: 'F1' }).requestBody.role,
    'reader');
});
