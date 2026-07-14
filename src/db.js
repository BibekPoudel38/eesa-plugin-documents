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

// ---- members (v1: admin-only) ---------------------------------------------
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
    [tenantId, employeeRef, role === 'admin' ? 'admin' : 'admin', String(name).slice(0, 200), String(email).slice(0, 200)],
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

export async function queuePending() {
  const rows = await q(`select count(*)::int as n from ingest_jobs where state in ('queued','running')`, []);
  return rows[0].n;
}
