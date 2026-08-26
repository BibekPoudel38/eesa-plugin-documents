// Google Drive — the first implementation of the storage-provider interface
// (see ./index.js). The plugin owns its OWN OAuth (one admin login per tenant,
// full Drive scope). Bytes are pulled transiently for indexing; the plugin
// never persists them.
//
// Provider interface every storage backend must implement:
//   key, label
//   authUrl(state) -> string
//   exchangeCode(code) -> { accessToken, refreshToken, expiry, accountEmail }
//   ensureFolder(tenantId) -> folderId
//   listAllFiles(tenantId, onFile) -> count      // onFile(normalizedFile)
//   downloadContent(tenantId, file) -> { buffer, mime }
//   uploadFile(tenantId, { name, mimeType, buffer }) -> normalizedFile
//
// Normalized file shape (provider-agnostic): { id, name, mimeType, link, size, hash }
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import * as db from '../db.js';

export const key = 'google_drive';
export const label = 'Google Drive';

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const FOLDER_NAME = 'Eesa Documents';
const INDEXABLE = /(pdf|wordprocessing|spreadsheet|sheet|presentation|csv|text\/|vnd\.google-apps\.(document|spreadsheet|presentation)|image\/(png|jpe?g))/i;

function redirectUri() {
  // Google matches the redirect URI byte-for-byte against what is registered,
  // so the registration is the authority — not our provider key. This plugin's
  // key is 'google_drive', but the Chups client was registered with
  // .../api/connect/google/callback, and the console lives under an account
  // this deployment cannot reach. Rather than leave a permanent mismatch
  // undocumented, the exact URI is settable and the callback route accepts the
  // alias (see server.js), so both spellings work.
  const explicit = (process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const base = (process.env.PLUGIN_BASE_URL || '').replace(/\/$/, '');
  return `${base}/api/connect/${key}/callback`;
}
function oauth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri(),
  );
}

export function authUrl(state) {
  return oauth().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
}

export async function exchangeCode(code) {
  const client = oauth();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  let accountEmail = '';
  try {
    const me = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    accountEmail = me.data.email || '';
  } catch { /* best-effort */ }
  return {
    accessToken: tokens.access_token || '',
    refreshToken: tokens.refresh_token || '',
    expiry: tokens.expiry_date || null,
    accountEmail,
  };
}

async function authFor(tenantId) {
  const t = await db.getTokens(tenantId, key);
  if (!t || (!t.accessToken && !t.refreshToken)) return null;
  const client = oauth();
  client.setCredentials({
    access_token: t.accessToken || undefined,
    refresh_token: t.refreshToken || undefined,
    expiry_date: t.expiry || undefined,
  });
  client.on('tokens', (tok) => {
    if (tok.access_token) {
      db.updateAccessToken(tenantId, key, tok.access_token, tok.expiry_date || null)
        .catch((e) => console.warn('drive token persist failed:', e.message));
    }
  });
  return client;
}

async function driveFor(tenantId) {
  const auth = await authFor(tenantId);
  return auth ? google.drive({ version: 'v3', auth }) : null;
}

export async function ensureFolder(tenantId) {
  const t = await db.getTokens(tenantId, key);
  if (t?.rootFolderId) return t.rootFolderId;
  const drive = await driveFor(tenantId);
  if (!drive) return null;
  const found = await drive.files.list({
    q: `name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: 1,
  });
  let id = found.data.files?.[0]?.id;
  if (!id) {
    const created = await drive.files.create({
      requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    });
    id = created.data.id;
  }
  await db.setConnectionMeta(tenantId, key, { rootFolderId: id });
  return id;
}

const SHARED_NAME = 'Shared';
const MEMBERS_NAME = 'members';

/** Find-or-create a folder by name under a known parent. Idempotent: two
 *  concurrent syncs can both run this and converge on the same folder. */
async function ensureSubfolder(drive, name, parentId) {
  const safe = String(name).replace(/'/g, "\\'");
  const found = await drive.files.list({
    q: `name = '${safe}' and '${parentId}' in parents `
     + `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: 1,
  });
  const hit = found.data.files?.[0]?.id;
  if (hit) return hit;
  const made = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  return made.data.id;
}

/** The workspace folder everyone can search. */
export async function ensureSharedFolder(tenantId) {
  const drive = await driveFor(tenantId);
  const root = await ensureFolder(tenantId);
  if (!drive || !root) return null;
  const id = await ensureSubfolder(drive, SHARED_NAME, root);
  // Record it in the same folder->scope map the pipeline reads, or indexing
  // would have no way to recognise a file as shared.
  await db.setSharedFolderId(tenantId, id);
  return id;
}

/** Should this member be granted access to their own folder, and with what?
 *
 *  The folder sits in the workspace's connected Drive, owned by whoever
 *  attached it — so creating one named after somebody granted them nothing.
 *  Every "Saved to your Drive folder" link handed to a member 403'd for the
 *  one person it was addressed to. Drive inherits folder permissions down to
 *  contents, so a single grant covers everything they file from now on.
 *
 *  Pure, and exported, because the decision is the part worth pinning: who is
 *  skipped, and that the notification stays off. Returns the Drive request, or
 *  null when there is nothing to do.
 */
export function ownerGrantPlan({ email, folderId, ownerGranted = false } = {}) {
  // Already done. Checked from our own mirror rather than by asking Drive,
  // so a member who uploads daily costs one round-trip in total, not one each.
  if (ownerGranted) return null;
  // A token without an email claim (the gateway shape) names nobody to grant
  // to. Skipping leaves owner_granted false, so the next call that DOES carry
  // an address still fixes it.
  if (!email || !folderId) return null;
  return {
    fileId: folderId,
    // Reader, not writer: they read and download their documents, while adding
    // and removing files stays with the plugin — which is what keeps the
    // search index and the folder saying the same thing.
    requestBody: { role: 'reader', type: 'user', emailAddress: email },
    // Google emails the recipient by default. Member folders are created the
    // first time each person touches Documents, so leaving this on would put
    // "somebody shared a folder with you" in every employee's inbox on the day
    // this ships — for a folder they already thought was theirs.
    sendNotificationEmail: false,
    supportsAllDrives: true,
  };
}

/** Is there any point trying this grant again?
 *
 *  Two different reasons to stop, both recorded the same way so the backfill
 *  does not retry on every upload forever:
 *
 *  - the permission is already there, which is the end state we wanted;
 *  - the address has no Google account behind it, which Drive refuses outright
 *    while sendNotificationEmail is false. Workspaces whose Eesa logins are not
 *    real mailboxes hit this for every member, and retrying cannot fix it —
 *    a public link is the only thing that reaches those people.
 */
export function grantSettled(message) {
  const m = String(message || '');
  if (/already|duplicate/i.test(m)) return true;
  return /no Google account|not a valid email|invalid sharing request|notify people/i.test(m);
}

/** Did the grant actually land, or did we merely stop trying? Kept separate so
 *  a caller can tell "they can open it" from "nobody could have". */
export function grantSucceeded(message) {
  return /already|duplicate/i.test(String(message || ''));
}

/** Run a plan from ownerGrantPlan. Never fatal: a failed grant must not cost
 *  somebody their upload, so this reports and returns, leaving owner_granted
 *  false so the next upload tries again. */
async function applyOwnerGrant(tenantId, drive, employeeRef, plan) {
  try {
    await drive.permissions.create(plan);
  } catch (e) {
    const msg = String(e?.message || e);
    if (!grantSettled(msg)) {
      // Transient or unexpected: leave it unrecorded so the next upload retries.
      console.warn('applyOwnerGrant RETRY', employeeRef, msg);
      return;
    }
    if (!grantSucceeded(msg)) {
      // Terminal. Said plainly because the symptom otherwise is a link that
      // 403s for the person it was addressed to, with nothing in the logs
      // connecting the two.
      console.warn('applyOwnerGrant GAVE UP', employeeRef, plan.requestBody.emailAddress,
                   '- not a Google account; only a public link can reach them:', msg);
    }
  }
  await db.markFolderGranted(tenantId, employeeRef);
}

/** One person's folder: Eesa Documents/members/<email>.
 *  Named by email so a human can find it in Drive; the PERMISSION is keyed on
 *  employeeRef in member_folders, so renaming a mailbox cannot hand someone
 *  else's documents to a new address. */
export async function ensureMemberFolder(tenantId, { employeeRef, email }) {
  // Reuse the mapping first. Naming is not a stable key: the downstream token
  // carries no email, so a call from the upload path would fall back to the
  // employeeRef, not find the folder named after the address, and create a
  // SECOND folder for the same person — splitting their documents across two
  // scopes and silently orphaning whatever was already filed.
  const known = await db.getMemberFolder(tenantId, employeeRef);
  if (known?.folder_id) {
    // Backfill. Folders made before members were granted access carry no
    // permission, and the early return here means they would never acquire
    // one — leaving the people who have used Documents longest as exactly the
    // ones whose links keep failing.
    const plan = ownerGrantPlan({
      email, folderId: known.folder_id, ownerGranted: known.owner_granted,
    });
    if (plan) {
      const drive = await driveFor(tenantId);
      if (drive) await applyOwnerGrant(tenantId, drive, employeeRef, plan);
    }
    return known.folder_id;
  }

  const drive = await driveFor(tenantId);
  const root = await ensureFolder(tenantId);
  if (!drive || !root) return null;
  const membersId = await ensureSubfolder(drive, MEMBERS_NAME, root);
  const folderId = await ensureSubfolder(drive, email || employeeRef, membersId);
  await db.upsertMemberFolder(tenantId, { employeeRef, email: email || '', folderId });
  const plan = ownerGrantPlan({ email, folderId });
  if (plan) await applyOwnerGrant(tenantId, drive, employeeRef, plan);
  return folderId;
}

const normalize = (f) => ({
  id: f.id,
  name: f.name,
  mimeType: f.mimeType || '',
  link: f.webViewLink || '',
  size: f.size ? Number(f.size) : null,
  hash: f.md5Checksum || (f.modifiedTime ? `m:${f.modifiedTime}` : null),
  // The folder a file sits in IS its permission. Without this the pipeline has
  // nothing to derive a scope from and every document would fall back to
  // "readable by nobody".
  folderId: (f.parents && f.parents[0]) || '',
});

export async function listAllFiles(tenantId, onFile) {
  const drive = await driveFor(tenantId);
  if (!drive) return 0;
  let pageToken, count = 0;
  do {
    const res = await drive.files.list({
      q: `trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id,name,mimeType,webViewLink,size,modifiedTime,md5Checksum,parents)',
      pageSize: 100, pageToken, corpora: 'user',
    });
    for (const f of res.data.files || []) {
      if (INDEXABLE.test(f.mimeType || '')) { await onFile(normalize(f)); count++; }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return count;
}

export async function downloadContent(tenantId, file) {
  const drive = await driveFor(tenantId);
  const mime = file.mimeType || '';
  if (mime.startsWith('application/vnd.google-apps.')) {
    const exportMime = mime.endsWith('spreadsheet') ? 'text/csv' : 'text/plain';
    const res = await drive.files.export({ fileId: file.id, mimeType: exportMime }, { responseType: 'arraybuffer' });
    return { buffer: Buffer.from(res.data), mime: exportMime };
  }
  const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
  return { buffer: Buffer.from(res.data), mime };
}

// Upload a user file into the plugin-owned folder in the tenant's own Drive.
export async function uploadFile(tenantId, { name, mimeType, buffer, parentId = '' }) {
  const drive = await driveFor(tenantId);
  if (!drive) throw new Error('Google Drive is not connected.');
  // Caller-chosen parent wins: an upload belongs in the uploader's own folder,
  // and only falls back to the root when no one said where.
  const folderId = parentId || await ensureFolder(tenantId);
  const res = await drive.files.create({
    requestBody: { name, parents: folderId ? [folderId] : undefined },
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buffer) },
    // `parents` matters: normalize() turns it into folderId, which is what the
    // pipeline derives the document's SCOPE from. Without it an uploaded file
    // is indexed with an empty scope and is therefore readable by nobody —
    // a successful upload that silently answers for no one.
    fields: 'id,name,mimeType,webViewLink,size,md5Checksum,parents',
  });
  return normalize(res.data);
}

// ---- sharing & file edits -------------------------------------------------
// Drive's own link is only reachable by someone with access to the file, so a
// "share this with a customer" link has to be an explicit permission grant.
// These are the only calls in the plugin that change anything in the client's
// Drive, and each one is gated upstream by ownership or master admin.

/** A direct-download URL for a Drive file id. `webContentLink` is only present
 *  for binary files (a Google Doc has no bytes to stream), so build the stable
 *  form ourselves rather than returning undefined for half the library. */
export function downloadUrlFor(fileId) {
  return fileId ? `https://drive.google.com/uc?export=download&id=${fileId}` : '';
}

export function viewUrlFor(fileId) {
  return fileId ? `https://drive.google.com/file/d/${fileId}/view` : '';
}

// What "public" grants. 'writer' means anyone holding the link may CHANGE the
// file, not merely read it — no Google account required, no further check, and
// the link travels wherever it is forwarded. It is set deliberately: the drive
// belongs to one Gmail account while the Eesa logins are not Google accounts at
// all, so a per-person grant cannot reach anybody, and read-only links left
// members unable to work on their own documents.
//
// Two consequences worth keeping in view. An editor can alter contents, so the
// indexed text in Qdrant can drift from what the file now says until the next
// sync. And a link that leaks is an edit surface, not just a disclosure. One
// word here reverts it to 'reader'.
export const PUBLIC_ROLE = 'writer';

/** Publish: anyone with the link may read AND edit. Returns the shareable URLs.
 *  Idempotent — Drive answers with an error we treat as success when the
 *  permission is already there, so re-sharing is not a failure. */
export async function makePublic(tenantId, fileId) {
  const drive = await driveFor(tenantId);
  if (!drive) throw new Error('Google Drive is not connected.');
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: PUBLIC_ROLE, type: 'anyone' },
      // Without this the call succeeds and the link still 403s for anyone who
      // is not signed into the workspace.
      supportsAllDrives: true,
    });
  } catch (e) {
    const msg = String(e?.message || '');
    // "already has access" / duplicate permission — the desired end state.
    if (!/already|duplicate/i.test(msg)) throw e;
  }
  const res = await drive.files.get({
    fileId, fields: 'id,name,webViewLink,webContentLink',
  });
  return {
    fileId,
    name: res.data.name,
    viewUrl: res.data.webViewLink || viewUrlFor(fileId),
    downloadUrl: res.data.webContentLink || downloadUrlFor(fileId),
  };
}

/** Un-publish: drop every "anyone" permission, leaving named access intact. */
export async function makePrivate(tenantId, fileId) {
  const drive = await driveFor(tenantId);
  if (!drive) throw new Error('Google Drive is not connected.');
  const list = await drive.permissions.list({
    fileId, fields: 'permissions(id,type,role)', supportsAllDrives: true,
  });
  const anyone = (list.data.permissions || []).filter((p) => p.type === 'anyone');
  for (const p of anyone) {
    await drive.permissions.delete({ fileId, permissionId: p.id, supportsAllDrives: true });
  }
  return { fileId, revoked: anyone.length };
}

/** Is this file currently public? Read from Drive, not from our mirror — the
 *  answer that matters is the one Google will act on. */
export async function isPublic(tenantId, fileId) {
  const drive = await driveFor(tenantId);
  if (!drive) return false;
  const list = await drive.permissions.list({
    fileId, fields: 'permissions(id,type)', supportsAllDrives: true,
  });
  return (list.data.permissions || []).some((p) => p.type === 'anyone');
}

export async function renameFile(tenantId, fileId, name) {
  const drive = await driveFor(tenantId);
  if (!drive) throw new Error('Google Drive is not connected.');
  const res = await drive.files.update({
    fileId, requestBody: { name: String(name).slice(0, 300) },
    fields: 'id,name,webViewLink', supportsAllDrives: true,
  });
  return { fileId, name: res.data.name };
}

/** Trash rather than destroy. A delete in a shared workspace is someone else's
 *  document as often as it is your own, and Drive's own trash is a 30-day undo
 *  that costs nothing to keep. */
export async function trashFile(tenantId, fileId) {
  const drive = await driveFor(tenantId);
  if (!drive) throw new Error('Google Drive is not connected.');
  await drive.files.update({
    fileId, requestBody: { trashed: true }, supportsAllDrives: true,
  });
  return { fileId, trashed: true };
}
