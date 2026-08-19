// Eesa Documents data layer — Postgres via pg. Stores ONLY metadata + pointers;
// never file bytes. Every query is scoped to tenant_id (from the verified token).
// OAuth tokens are encrypted/decrypted at this boundary (src/crypto.js).
import pg from 'pg';
import { encrypt, decrypt } from './crypto.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

async function q(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

const iso = (v) => (v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString());

// ---- connections ----------------------------------------------------------
// Public shape hides the encrypted token columns; call getTokens() for those.
const connOut = (c) =>
  c && {
    id: String(c.id),
    provider: c.provider,
    accountEmail: c.account_email,
    rootFolderId: c.root_folder_id || null,
    status: c.status,
    lastError: c.last_error || '',
    connectedBy: c.connected_by || '',
    updatedAt: iso(c.updated_at),
  };

export async function getConnection(tenantId, provider) {
  const rows = await q(
    `select * from connections where tenant_id = $1 and provider = $2`,
    [tenantId, provider],
  );
  return connOut(rows[0]);
}

export async function listConnections(tenantId) {
  const rows = await q(`select * from connections where tenant_id = $1 order by provider`, [tenantId]);
  return rows.map(connOut);
}

// Decrypted tokens for server-side provider calls. Never leaves the backend.
export async function getTokens(tenantId, provider) {
  const rows = await q(
    `select access_token, refresh_token, token_expiry, root_folder_id, sync_cursor
       from connections where tenant_id = $1 and provider = $2`,
    [tenantId, provider],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    accessToken: decrypt(r.access_token),
    refreshToken: decrypt(r.refresh_token),
    expiry: r.token_expiry ? new Date(r.token_expiry).getTime() : null,
    rootFolderId: r.root_folder_id || null,
    syncCursor: r.sync_cursor || null,
  };
}

export async function upsertConnection(tenantId, provider, { accountEmail = '', accessToken, refreshToken, expiry = null, connectedBy = '' }) {
  const rows = await q(
    `insert into connections (tenant_id, provider, account_email, access_token, refresh_token, token_expiry, connected_by, status, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,'connected', now())
     on conflict (tenant_id, provider) do update
       set account_email = excluded.account_email,
           access_token  = excluded.access_token,
           refresh_token = case when excluded.refresh_token <> '' then excluded.refresh_token else connections.refresh_token end,
           token_expiry  = excluded.token_expiry,
           status = 'connected', last_error = '', updated_at = now()
     returning *`,
    [tenantId, provider, accountEmail, encrypt(accessToken), encrypt(refreshToken || ''),
     expiry ? new Date(expiry) : null, connectedBy],
  );
  return connOut(rows[0]);
}

// Persist a refreshed access token without touching the refresh token.
export async function updateAccessToken(tenantId, provider, accessToken, expiry) {
  await q(
    `update connections set access_token = $3, token_expiry = $4, updated_at = now()
      where tenant_id = $1 and provider = $2`,
    [tenantId, provider, encrypt(accessToken), expiry ? new Date(expiry) : null],
  );
}

export async function setConnectionMeta(tenantId, provider, { rootFolderId, syncCursor, status, lastError } = {}) {
  await q(
    `update connections set
        root_folder_id = coalesce($3, root_folder_id),
        sync_cursor    = coalesce($4, sync_cursor),
        status         = coalesce($5, status),
        last_error     = coalesce($6, last_error),
        updated_at = now()
      where tenant_id = $1 and provider = $2`,
    [tenantId, provider, rootFolderId ?? null, syncCursor ?? null, status ?? null, lastError ?? null],
  );
}

// ---- members ---------------------------------------------------------------
//: Roles this plugin understands. v1 only ever writes `admin`, but the set is
//: named so the staff-access work has one place to extend rather than a literal
//: to hunt for. Anything unrecognised falls back to the least privilege.
export const ROLES = ['admin', 'member'];
const DEFAULT_ROLE = 'member';

const memberOut = (m) => m && { employeeRef: m.employee_ref, role: m.role, name: m.name, email: m.email };

export async function getMember(tenantId, employeeRef) {
  const rows = await q(
    `select * from members where tenant_id = $1 and employee_ref = $2 and active = true`,
    [tenantId, employeeRef],
  );
  return memberOut(rows[0]);
}

export async function upsertMember(tenantId, { employeeRef, role = 'admin', name = '', email = '' }) {
  const rows = await q(
    `insert into members (tenant_id, employee_ref, role, name, email, active)
     values ($1,$2,$3,$4,$5,true)
     on conflict (tenant_id, employee_ref) do update
       set role = excluded.role, name = excluded.name, email = excluded.email, active = true
     returning *`,
    // Was `role === 'admin' ? 'admin' : 'admin'`, which silently granted admin
    // to every caller-supplied value. Harmless while v1 only ever passes
    // 'admin', and exactly the kind of thing that stops being harmless the day
    // staff roles arrive.
    [tenantId, employeeRef, ROLES.includes(role) ? role : DEFAULT_ROLE,
     String(name).slice(0, 200), String(email).slice(0, 200)],
  );
  return memberOut(rows[0]);
}

// ---- documents ------------------------------------------------------------
const docOut = (d) =>
  d && {
    id: String(d.id),
    title: d.title,
    mime: d.mime,
    link: d.link,
    folder: d.folder,
    state: d.state,
    chunkCount: d.chunk_count,
    indexedAt: iso(d.indexed_at),
    updatedAt: iso(d.updated_at),
  };

// Upsert the metadata row for a source file; returns the row id + whether the
// content changed (so the pipeline can skip re-indexing unchanged files).
export async function upsertDocument(tenantId, { provider, fileId, title, mime, link, folder = '', sizeBytes = null, contentHash = null }) {
  // content_hash is left NULL until a successful index, so a brand-new file always
  // reads as "changed" and gets queued. markDocumentIndexed() stamps the hash;
  // subsequent syncs compare the source hash to it and skip when unchanged.
  const rows = await q(
    `insert into documents (tenant_id, provider, file_id, title, mime, link, folder, size_bytes, state, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'pending', now())
     on conflict (tenant_id, provider, file_id) do update
       set title = excluded.title, mime = excluded.mime, link = excluded.link,
           folder = excluded.folder, size_bytes = excluded.size_bytes, updated_at = now()
     returning id, content_hash`,
    [tenantId, provider, fileId, String(title).slice(0, 500), mime, link, folder, sizeBytes],
  );
  const prevHash = rows[0].content_hash; // NULL until first successful index
  return { id: String(rows[0].id), changed: contentHash == null || contentHash !== prevHash };
}

export async function getDocumentByFile(tenantId, provider, fileId) {
  const rows = await q(
    `select id, title, mime, link, size_bytes, content_hash, state from documents
      where tenant_id = $1 and provider = $2 and file_id = $3`,
    [tenantId, provider, fileId],
  );
  const d = rows[0];
  return d && {
    id: String(d.id), title: d.title, mime: d.mime, link: d.link,
    sizeBytes: d.size_bytes == null ? null : Number(d.size_bytes),
    contentHash: d.content_hash, state: d.state,
  };
}

export async function markDocumentIndexed(id, { chunkCount, contentHash }) {
  await q(
    `update documents set state = 'indexed', chunk_count = $2, content_hash = $3,
        error = '', indexed_at = now(), updated_at = now() where id = $1`,
    [id, chunkCount, contentHash],
  );
}

export async function markDocumentState(id, state, error = '') {
  await q(`update documents set state = $2, error = $3, updated_at = now() where id = $1`, [id, state, String(error).slice(0, 2000)]);
}

export async function listDocuments(tenantId, { limit = 50 } = {}) {
  const rows = await q(
    `select * from documents where tenant_id = $1 order by updated_at desc limit $2`,
    [tenantId, Math.max(1, Math.min(limit, 500))],
  );
  return rows.map(docOut);
}

export async function findDocument(tenantId, ref) {
  // by uuid id, else by title (case-insensitive contains)
  const byId = /^[0-9a-f-]{36}$/i.test(ref)
    ? await q(`select * from documents where tenant_id = $1 and id = $2`, [tenantId, ref])
    : [];
  if (byId[0]) return docOut(byId[0]);
  const byTitle = await q(
    `select * from documents where tenant_id = $1 and title ilike $2 order by updated_at desc limit 1`,
    [tenantId, `%${ref}%`],
  );
  return docOut(byTitle[0]);
}

export async function documentCounts(tenantId) {
  const rows = await q(
    `select state, count(*)::int as n from documents where tenant_id = $1 group by state`,
    [tenantId],
  );
  const out = { total: 0, indexed: 0, pending: 0, error: 0, skipped: 0 };
  for (const r of rows) { out[r.state] = r.n; out.total += r.n; }
  return out;
}

// ---- ingest queue ---------------------------------------------------------
export async function enqueue(tenantId, provider, fileId) {
  await q(
    `insert into ingest_jobs (tenant_id, provider, file_id, state, updated_at)
     values ($1,$2,$3,'queued', now())
     on conflict (tenant_id, provider, file_id) do update
       set state = 'queued', last_error = '', updated_at = now()`,
    [tenantId, provider, fileId],
  );
}

// Atomically claim the next queued job (SKIP LOCKED so multiple workers are safe).
export async function claimJob() {
  const rows = await q(
    `update ingest_jobs set state = 'running', attempts = attempts + 1, updated_at = now()
       where id = (
         select id from ingest_jobs where state = 'queued'
           order by updated_at asc for update skip locked limit 1
       )
     returning *`,
    [],
  );
  return rows[0] || null;
}

export async function finishJob(id, ok, error = '') {
  await q(`update ingest_jobs set state = $2, last_error = $3, updated_at = now() where id = $1`,
    [id, ok ? 'done' : 'error', String(error).slice(0, 2000)]);
}

// Tenant-scoped, like every other read here. An unscoped count would report the
// whole platform's indexing backlog to any one workspace's admin, which is both
// a small information leak and a confusing number to show them.
export async function queuePending(tenantId) {
  const rows = await q(
    `select count(*)::int as n from ingest_jobs
      where tenant_id = $1 and state in ('queued','running')`,
    [tenantId],
  );
  return rows[0].n;
}


// ---------------------------------------------------------------------------
// Per-member scoping
// ---------------------------------------------------------------------------
// One rule, in one place: what may this caller read?
//
//   'shared'          the workspace folder everyone sees
//   'member:<ref>'    that person's own folder, and nobody else's
//
// An admin is NOT given everyone's folders. "Admin" here governs connecting a
// drive and managing members, not reading colleagues' private documents — the
// point of the feature is that a member's folder answers only for them, and an
// admin backdoor would quietly make that untrue.

/** Scopes this caller may read. Never returns [] for a real member — 'shared'
 *  is always readable — so an empty result means "no identity", which the
 *  search layer treats as "read nothing". */
export const SHARED_REF = '__shared__';

export function scopesFor(employeeRef) {
  const ref = String(employeeRef || '').trim();
  if (!ref) return [];              // no identity -> reads nothing
  return ['shared', `member:${ref}`];
}

/** Scopes for a caller, after checking the admin has not revoked reading.
 *  Returns [] when read is off — which search() turns into "match nothing",
 *  so revoking is total rather than merely hiding the folder in the UI. */
export async function readableScopes(tenantId, employeeRef) {
  const ref = String(employeeRef || '').trim();
  if (!ref) return [];
  const rows = await q(
    `select can_read from members where tenant_id = $1 and employee_ref = $2 and active = true`,
    [tenantId, ref]);
  // No member row yet: they are mid-provisioning, so fall back to the default
  // (readable). A missing row must not read as "revoked" or the first request
  // after a grant would fail confusingly.
  if (rows[0] && rows[0].can_read === false) return [];
  return scopesFor(ref);
}

export async function canUpload(tenantId, employeeRef) {
  const rows = await q(
    `select can_upload from members where tenant_id = $1 and employee_ref = $2 and active = true`,
    [tenantId, employeeRef]);
  return rows[0] ? rows[0].can_upload !== false : true;
}

/** The admin panel's roster: every member, their permissions, their folder and
 *  how much is in it. */
export async function listMembersWithFolders(tenantId) {
  return q(
    `select m.employee_ref, m.name, m.email, m.role, m.active,
            m.can_read, m.can_upload,
            f.folder_id,
            (select count(*) from documents d
              where d.tenant_id = m.tenant_id
                and d.scope = 'member:' || m.employee_ref) as doc_count
       from members m
       left join member_folders f
         on f.tenant_id = m.tenant_id and f.employee_ref = m.employee_ref
      where m.tenant_id = $1
      order by m.created_at asc`, [tenantId]);
}

export async function setMemberPermissions(tenantId, employeeRef, { canRead, canUpload }) {
  const rows = await q(
    `update members
        set can_read   = coalesce($3, can_read),
            can_upload = coalesce($4, can_upload)
      where tenant_id = $1 and employee_ref = $2
      returning employee_ref, can_read, can_upload`,
    [tenantId, employeeRef,
     canRead === undefined ? null : !!canRead,
     canUpload === undefined ? null : !!canUpload]);
  return rows[0] || null;
}

export async function getMemberFolder(tenantId, employeeRef) {
  const rows = await q(
    `select * from member_folders where tenant_id = $1 and employee_ref = $2`,
    [tenantId, employeeRef],
  );
  return rows[0] || null;
}

export async function upsertMemberFolder(tenantId, { employeeRef, email = '', folderId }) {
  const rows = await q(
    `insert into member_folders (tenant_id, employee_ref, email, folder_id)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, employee_ref)
     do update set email = excluded.email, folder_id = excluded.folder_id
     returning *`,
    [tenantId, employeeRef, email, folderId],
  );
  return rows[0];
}

/** Which scope a file belongs to, from the Drive folder it sits in.
 *  Unknown folder -> '' -> indexed but readable by nobody, which is the safe
 *  direction: a misfiled document is invisible rather than public. */
export async function scopeForFolder(tenantId, folderId, sharedFolderId) {
  if (folderId && sharedFolderId && folderId === sharedFolderId) return 'shared';
  const rows = await q(
    `select employee_ref from member_folders where tenant_id = $1 and folder_id = $2`,
    [tenantId, folderId],
  );
  const ref = rows[0]?.employee_ref;
  if (!ref) return '';
  // The Shared folder is stored in this same table under a sentinel ref so
  // there is one folder->scope map rather than two. Without this line it would
  // resolve to `member:__shared__` — a scope nobody holds — and the shared
  // folder would answer for no one whenever the cached id was missing.
  return ref === SHARED_REF ? 'shared' : `member:${ref}`;
}


export async function setDocumentScope(documentId, scope) {
  await q(`update documents set scope = $2, updated_at = now() where id = $1`,
          [documentId, scope || '']);
}

/** The tenant's Shared folder id, cached on the connection row so indexing a
 *  thousand files is not a thousand Drive lookups. */
export async function getSharedFolderId(tenantId) {
  const rows = await q(
    `select folder_id from member_folders
      where tenant_id = $1 and employee_ref = $2`, [tenantId, SHARED_REF]);
  return rows[0]?.folder_id || '';
}

export async function setSharedFolderId(tenantId, folderId) {
  return upsertMemberFolder(tenantId, { employeeRef: SHARED_REF, email: '', folderId });
}


/** Every member folder in the workspace, newest first, with the member's name
 *  when we know it. Admin-only view: this is a directory of who has a folder,
 *  never their contents. */
export async function listMemberFolders(tenantId) {
  return q(
    `select f.employee_ref, f.email, f.folder_id, f.created_at,
            m.name, m.role,
            (select count(*) from documents d
              where d.tenant_id = f.tenant_id
                and d.scope = 'member:' || f.employee_ref) as doc_count
       from member_folders f
       left join members m
         on m.tenant_id = f.tenant_id and m.employee_ref = f.employee_ref
      where f.tenant_id = $1 and f.employee_ref <> $2
      order by f.created_at desc`,
    [tenantId, SHARED_REF],
  );
}

export async function sharedDocCount(tenantId) {
  const rows = await q(
    `select count(*)::int as n from documents where tenant_id = $1 and scope = 'shared'`,
    [tenantId]);
  return rows[0]?.n || 0;
}


export async function createSetupLink(tenantId, { token, employeeRef = 'setup',
                                                  provider = 'google_drive', ttlMinutes = 60 }) {
  const rows = await q(
    `insert into setup_links (token, tenant_id, employee_ref, provider, expires_at)
     values ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)
     returning token, expires_at`,
    [token, tenantId, employeeRef, provider, String(ttlMinutes)],
  );
  return rows[0];
}

/** Claim a setup link. Marks it used in the SAME statement that reads it, so
 *  two clicks on the same URL cannot both proceed — the second gets nothing.
 *  Returns null for unknown, expired or already-used tokens alike: a caller
 *  probing tokens learns the same thing either way. */
export async function claimSetupLink(token) {
  const rows = await q(
    `update setup_links set used_at = now()
      where token = $1 and used_at is null and expires_at > now()
      returning tenant_id, employee_ref, provider`,
    [token],
  );
  return rows[0] || null;
}
