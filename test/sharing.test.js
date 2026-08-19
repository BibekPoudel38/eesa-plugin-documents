// Listing, linking and sharing — the surfaces that leaked.
//
// Search was scoped from the start; list_documents and get_document_link were
// not, and neither was GET /api/documents. All three answered "what is in this
// workspace" for anybody who could reach them, which is the same leak on
// routes nobody thought of as a search. These tests pin the parts that can be
// checked without a database or a Drive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileIdFromLink } from '../src/qdrant.js';
import { downloadUrlFor, viewUrlFor } from '../src/providers/google_drive.js';
import { isMasterByEnv } from '../src/db.js';
import { readFileSync } from 'node:fs';

test('a Drive view link yields the file id a download link needs', () => {
  assert.equal(
    fileIdFromLink('https://drive.google.com/file/d/1G8KuDO0Z2E-7XnwyNFI9Qf4ETNdEgABP/view?usp=drivesdk'),
    '1G8KuDO0Z2E-7XnwyNFI9Qf4ETNdEgABP');
  assert.equal(
    fileIdFromLink('https://drive.google.com/uc?export=download&id=1G8KuDO0Z2E-7XnwyNFI9Qf4ETNdEgABP'),
    '1G8KuDO0Z2E-7XnwyNFI9Qf4ETNdEgABP');
});

test('a link we cannot parse yields no id rather than a wrong one', () => {
  // A wrong id is a link to somebody else's file. Empty is the safe answer.
  for (const junk of ['', null, undefined, 'https://example.com/nope', 'https://drive.google.com/file/d/short/view']) {
    assert.equal(fileIdFromLink(junk), '', `parsed something out of ${junk}`);
  }
});

test('no file id produces no url, not a url to nothing', () => {
  assert.equal(downloadUrlFor(''), '');
  assert.equal(viewUrlFor(''), '');
  assert.ok(downloadUrlFor('abc123').includes('abc123'));
});

test('master admin is off unless the env names you', () => {
  // The default matters more than the grant: in the live workspace both the
  // owner and an ordinary member carry Eesa role ADMIN, so anything that
  // guesses at master admin promotes everyone.
  assert.equal(isMasterByEnv({ employeeRef: '42', email: 'raja@chupy.com' }), false);
  assert.equal(isMasterByEnv({}), false);
  assert.equal(isMasterByEnv({ employeeRef: '', email: '' }), false);
});

test('the scoped readers are actually scoped in the source', () => {
  // A unit test cannot reach Postgres here, and these two functions are
  // exactly where the leak lived: both used to take (tenantId) alone and
  // return the whole workspace. Pin the signature so a future edit that drops
  // the scopes argument fails here rather than in production.
  const src = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  assert.match(src, /export async function listDocuments\(tenantId, \{ limit = 50, scopes \} = \{\}\)/,
    'listDocuments no longer takes scopes — every reader would see the tenant');
  assert.match(src, /export async function findDocument\(tenantId, ref, scopes\)/,
    'findDocument no longer takes scopes — any title would resolve to any file');

  const mcp = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');
  for (const tool of ['list_documents', 'get_document_link', 'share_document']) {
    assert.ok(mcp.includes(tool), `${tool} vanished from the agent surface`);
  }
  // Every agent path derives scopes from the verified identity, never args.
  assert.ok(!/scopes\s*=\s*args\./.test(mcp), 'scopes taken from tool arguments');
});

test('an empty scope list is never handed to the vector filter as "no filter"', () => {
  const src = readFileSync(new URL('../src/qdrant.js', import.meta.url), 'utf8');
  assert.match(src, /if \(Array\.isArray\(scopes\) && scopes\.length === 0\) return \[\]/,
    'the empty-scope short-circuit is gone — Qdrant reads should:[] as match-everything');
});

test('the sync path carries the folder, or every sync un-scopes the library', () => {
  // upsertDocument writes `folder = excluded.folder` on conflict and defaults
  // the field to ''. syncTenant omitted it, so a re-sync overwrote each file's
  // folder with empty and the scope derived from it collapsed to "readable by
  // nobody" — a correctly-scoped document silently stopped answering, with
  // nothing in its state to show why. Observed in production: a file went from
  // scope=member:36 to scope='' across one sync.
  const src = readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');
  const sync = src.slice(src.indexOf('export async function syncTenant'),
                         src.indexOf('export async function indexUploaded'));
  assert.match(sync, /folder: f\.folderId \|\| ''/,
    'syncTenant no longer passes the folder — the next sync un-scopes everything');
  assert.match(sync, /moved/,
    'a file moved between folders must be re-indexed: its permission changed even though its bytes did not');
});
