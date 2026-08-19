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
  if (known?.folder_id) return known.folder_id;

  const drive = await driveFor(tenantId);
  const root = await ensureFolder(tenantId);
  if (!drive || !root) return null;
  const membersId = await ensureSubfolder(drive, MEMBERS_NAME, root);
  const folderId = await ensureSubfolder(drive, email || employeeRef, membersId);
  await db.upsertMemberFolder(tenantId, { employeeRef, email: email || '', folderId });
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
