-- Eesa Documents plugin — Postgres schema.
-- Tenant isolation is app-level: every row carries tenant_id (the Eesa tenant id
-- from the verified token). The plugin stores ONLY metadata + pointers — the
-- original file BYTES always live in the client's own cloud (Google Drive /
-- Dropbox). Vector embeddings live in Qdrant (src/qdrant.js), also partitioned
-- by tenant_id. OAuth tokens are AES-256-GCM encrypted before insert.
--
-- Apply:  psql "$DATABASE_URL" -f db/schema.sql   (idempotent — safe to re-run)

create extension if not exists pgcrypto;

-- One connected cloud account per (tenant, provider).
create table if not exists connections (
    id             uuid primary key default gen_random_uuid(),
    tenant_id      text not null,
    provider       text not null check (provider in ('google_drive', 'dropbox')),
    account_email  text not null default '',
    access_token   text not null default '',    -- encrypted (src/crypto.js)
    refresh_token  text not null default '',     -- encrypted
    token_expiry   timestamptz,
    root_folder_id text,                          -- the plugin-owned "Eesa Documents" folder
    sync_cursor    text,                          -- provider change cursor (incremental sync)
    status         text not null default 'connected', -- connected | syncing | error | disconnected
    last_error     text not null default '',
    connected_by   text not null default '',      -- Eesa user id (token sub) who connected
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    unique (tenant_id, provider)
);
create index if not exists connections_tenant_idx on connections (tenant_id);

-- Indexed document metadata (NOT the bytes). One row per source file.
create table if not exists documents (
    id            uuid primary key default gen_random_uuid(),
    tenant_id     text not null,
    provider      text not null,
    file_id       text not null,                  -- provider's file id
    title         text not null default '',
    mime          text not null default '',
    link          text not null default '',       -- link back to the file in the client's cloud
    folder        text not null default '',
    size_bytes    bigint,
    content_hash  text,                            -- skip re-index when unchanged
    chunk_count   integer not null default 0,
    visibility    text not null default 'admin',   -- v1: admin-only. staff/ACL comes later.
    state         text not null default 'pending', -- pending | indexed | error | skipped
    error         text not null default '',
    indexed_at    timestamptz,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    unique (tenant_id, provider, file_id)
);
create index if not exists documents_tenant_idx on documents (tenant_id, state);

-- Role membership (plugin-owned). v1 uses only 'admin'; staff added later.
create table if not exists members (
    tenant_id     text not null,
    employee_ref  text not null,                  -- Eesa user id (token sub)
    role          text not null default 'admin',
    name          text not null default '',
    email         text not null default '',
    active        boolean not null default true,
    created_at    timestamptz not null default now(),
    primary key (tenant_id, employee_ref)
);

-- Durable ingest queue: one job per file (fetch -> extract -> embed -> index).
create table if not exists ingest_jobs (
    id           uuid primary key default gen_random_uuid(),
    tenant_id    text not null,
    provider     text not null,
    file_id      text not null,
    state        text not null default 'queued',  -- queued | running | done | error
    attempts     integer not null default 0,
    last_error   text not null default '',
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    unique (tenant_id, provider, file_id)
);
create index if not exists ingest_jobs_state_idx on ingest_jobs (state, updated_at);
