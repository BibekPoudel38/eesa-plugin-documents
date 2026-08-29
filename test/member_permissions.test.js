// Giving permissions to somebody who exists only because they used the app.
//
// members and member_folders are written by different events: a member row
// when somebody is provisioned, a folder row the first time somebody uploads.
// listMembersWithFolders full-outer-joins them for exactly that reason, so the
// admin roster lists people who have a folder and no member row.
//
// setMemberPermissions did a plain UPDATE, matched nothing for those people,
// and the route turned that into 404 "no such member" — so the read/upload
// switches silently failed for precisely the members who had actually used
// Documents. On the live workspace that was two of the four listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool, setMemberPermissions } from '../src/db.js';

async function capture(fn, rows = [{ employee_ref: '39', can_read: true, can_upload: false }]) {
  const calls = [];
  const original = pool.query;
  pool.query = async (text, params) => { calls.push({ text, params }); return { rows }; };
  try { return { result: await fn(), calls }; } finally { pool.query = original; }
}

test('it writes the row rather than requiring one to exist', async () => {
  const { result, calls } = await capture(
    () => setMemberPermissions('t1', '39', { canUpload: false }));
  const sql = calls[0].text.toLowerCase();
  assert.match(sql, /insert into members/, 'a bare UPDATE cannot reach a folder-only member');
  assert.match(sql, /on conflict/, 'an existing member must still be updated, not duplicated');
  assert.equal(result.employee_ref, '39');
});

test('an existing member keeps the field that was not sent', async () => {
  const { calls } = await capture(() => setMemberPermissions('t1', '39', { canUpload: false }));
  const conflict = calls[0].text.toLowerCase().split('on conflict')[1];
  assert.match(conflict, /can_read\s*=\s*coalesce\(\$3, members\.can_read\)/);
  assert.match(conflict, /can_upload\s*=\s*coalesce\(\$4, members\.can_upload\)/);
});

test('an unsent field travels as null, so coalesce keeps the old value', async () => {
  const { calls } = await capture(() => setMemberPermissions('t1', '39', { canUpload: false }));
  assert.equal(calls[0].params[2], null, 'canRead was not sent');
  assert.equal(calls[0].params[3], false);
});

test('both fields travel when both are sent', async () => {
  const { calls } = await capture(
    () => setMemberPermissions('t1', '39', { canRead: false, canUpload: true }));
  assert.equal(calls[0].params[2], false);
  assert.equal(calls[0].params[3], true);
});

test('a new row defaults to what the readers already assume', async () => {
  // Readers treat a missing value as permitted (`can_upload !== false`), so
  // materialising a row must not quietly take access away from anybody.
  const { calls } = await capture(() => setMemberPermissions('t1', '39', {}));
  const values = calls[0].text.toLowerCase().split('on conflict')[0];
  assert.match(values, /coalesce\(\$3, true\)/);
  assert.match(values, /coalesce\(\$4, true\)/);
});

test('the email is taken from the folder row the person already has', async () => {
  const { calls } = await capture(() => setMemberPermissions('t1', '39', { canUpload: true }));
  assert.match(calls[0].text.toLowerCase(), /select email from member_folders/);
});

test('a new row is a member, never an admin', async () => {
  const { calls } = await capture(() => setMemberPermissions('t1', '39', { canUpload: true }));
  assert.equal(calls[0].params[4], 'member',
    'materialising a row must not promote anyone');
});

test('no row returned still means no row', async () => {
  const { result } = await capture(() => setMemberPermissions('t1', '39', {}), []);
  assert.equal(result, null);
});
