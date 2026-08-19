// Eesa Documents plugin server — three surfaces on one Coolify container:
//   POST /mcp   MCP (gateway-only + token)          → agent tools (search)
//   /api/*      REST (token; OAuth callback is open) → connect / upload / search
//   GET  /app   embedded admin UI (surface="ui")     → connect + upload + status
import express from 'express';
import multer from 'multer';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { verifyToken, requireGateway } from './auth.js';
import * as db from './db.js';
import * as pipeline from './pipeline.js';
import { getProvider, listProviders, isSupported } from './providers/index.js';
import { handleRpc } from './mcp.js';
// esc/page/state live in web.js so they can be unit tested: this module calls
// app.listen() at import, so nothing defined here is reachable from a test.
import { esc, page, makeState, readState } from './web.js';
import { embedQuery, warm } from './embed.js';
import { search, ping as qdrantPing } from './qdrant.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(__dirname, '..', 'manifest.json'), 'utf-8'));
const serverInfo = { name: MANIFEST.slug, version: MANIFEST.version };
const MAX_BYTES = Number(process.env.INGEST_MAX_FILE_MB || 25) * 1024 * 1024;

const app = express();
app.use(express.json({ limit: '2mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

// The admin UI is embedded inside the Eesa shell; allow framing from it only.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors https://app.eesa.ai https://eesa.ai");
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, plugin: MANIFEST.slug }));

// The Eesa launcher probes this to decide whether to show the app to a user,
// and fails CLOSED when it cannot reach it — without this route the tile never
// appears for anyone, however their role is set.
app.get('/api/me', async (req, res) => {
  let ctx;
  try {
    ctx = await verifyToken(req.get('Authorization'));
  } catch (e) {
    return res.status(e.status || 401).json({ ok: false, error: e.message });
  }
  const role = await effectiveRole(ctx);
  // role null (not the string "none") is what the launcher reads as "no access".
  res.json({ ok: true, role: role === 'none' ? null : role, plugin: MANIFEST.slug });
});
app.get('/manifest', (req, res) => res.json(MANIFEST));

// ---- MCP surface: gateway-only + token, JSON-RPC ----
app.post('/mcp', async (req, res) => {
  const body = req.body || {};
  const isNotification = !('id' in body);
  try {
    requireGateway(req);
    const ctx = await verifyToken(req.get('Authorization'));
    // Role-gate the agent surface too. Without this a user Eesa has set to
    // "none" still reaches every document through chat, which is the whole
    // point of the permission page defeated by the back door.
    ctx.role_ = await effectiveRole(ctx);
    const result = await handleRpc(body, ctx, serverInfo);
    if (isNotification || result === null) return res.status(202).end();
    return res.json({ jsonrpc: '2.0', id: body.id, result });
  } catch (e) {
    if (isNotification) return res.status(202).end();
    return res.status(e.status || 200).json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: e.code || -32000, message: e.message } });
  }
});

// ---- roles ----------------------------------------------------------------
// Eesa is authoritative. It derives a role from two protected positions and
// stamps it as the `appRole` claim:
//
//   admin  connect/disconnect a drive, upload, sync, search, read
//   staff  search and read only
//   none   refused everywhere
//
// The claim is ABSENT for a workspace that has not built a roster yet. That is
// deliberate on Eesa's side and must stay meaningful here: absent means "not
// governed", so we fall back to the original bootstrap rather than locking out
// the admin who connected the drive before roles existed. A claim of "none" is
// a decision and IS enforced.
function isPlatformAdmin(ctx) {
  return String(ctx.role || '').toUpperCase() === 'ADMIN';
}

/** Resolve the caller's effective role for this plugin. */
async function effectiveRole(ctx) {
  const claim = String(ctx.raw?.appRole || '').toLowerCase();
  if (claim === 'admin' || claim === 'staff' || claim === 'none') return claim;
  // Ungoverned tenant: the pre-roles behaviour.
  const member = await db.getMember(ctx.tenantId, ctx.sub);
  return isPlatformAdmin(ctx) || member ? 'admin' : 'none';
}

const RANK = { none: 0, staff: 1, admin: 2 };

/** Express middleware: verified token + at least `min` role. */
function requireRole(min) {
  return async (req, res, next) => {
    try {
      req.ctx = await verifyToken(req.get('Authorization'));
    } catch (e) {
      return res.status(e.status || 401).json({ ok: false, error: e.message });
    }
    req.role = await effectiveRole(req.ctx);
    ensureFolderForCaller(req.ctx, req.role);   // not awaited: see the comment
    if (RANK[req.role] < RANK[min]) {
      return res.status(403).json({
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: min === 'admin'
            ? 'Only a Documents admin can do that. Ask your workspace admin in Management, Documents.'
            : 'You do not have access to Documents. Ask your workspace admin in Management, Documents.',
        },
      });
    }
    next();
  };
}
const admin = () => requireRole('admin');
const reader = () => requireRole('staff');

// ---- OAuth connect (generic across providers) -----------------------------
// The signed state (see web.js) carries tenant + user + provider through the
// provider's redirect: tamper-proof, and expiring so it cannot be replayed.
// `start` is token-authed; the callback has no bearer and trusts that state.
app.get('/api/providers', admin(), async (req, res) => {
  res.json({ ok: true, data: { providers: listProviders(), connections: await db.listConnections(req.ctx.tenantId) } });
});

// The embedded UI fetches this (with its bearer) then navigates to the URL.
app.get('/api/connect/:provider/start', admin(), (req, res) => {
  const providerKey = req.params.provider;
  if (!isSupported(providerKey)) return res.status(400).json({ ok: false, error: 'unsupported provider' });
  if (providerKey === 'google_drive' && !process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return res.status(500).json({ ok: false, error: 'Google OAuth is not configured on the server.' });
  }
  res.json({ ok: true, url: getProvider(providerKey).authUrl(makeState(req.ctx.tenantId, req.ctx.sub, providerKey)) });
});

// The provider redirects here (top-level, no bearer) — trust the signed state.
app.get('/api/connect/:provider/callback', async (req, res) => {
  const providerKey = req.params.provider;
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(page('Connection cancelled', esc(error)));
  const st = readState(state);
  if (!isSupported(providerKey) || !code || !st?.t || st.p !== providerKey) {
    // One message for a malformed, mismatched OR expired state: telling the
    // caller which it was would help someone probing the endpoint.
    return res.status(400).send(page(
      'Link expired',
      'This connection link is no longer valid. Open Documents in Eesa and start again.',
    ));
  }
  try {
    const tok = await getProvider(providerKey).exchangeCode(String(code));
    await db.upsertConnection(st.t, providerKey, {
      accountEmail: tok.accountEmail, accessToken: tok.accessToken,
      refreshToken: tok.refreshToken, expiry: tok.expiry, connectedBy: st.s,
    });
    await db.upsertMember(st.t, { employeeRef: st.s, role: 'admin', email: tok.accountEmail });
    pipeline.syncTenant(st.t, providerKey).catch((e) => console.warn('initial sync failed:', e.message));
    const label = listProviders().find((p) => p.key === providerKey)?.label || providerKey;
    return res.send(page(
      `${label} connected`,
      `We are indexing <b>${esc(tok.accountEmail || 'your drive')}</b> now. Return to Eesa chat and ask for a document by meaning, for example "find the lease agreement".`,
    ));
  } catch (e) {
    // The provider's error text can carry echoed input, so escape it too.
    return res.status(500).send(page('Connection failed', esc(e.message)));
  }
});

// ---- status / documents / search / upload / sync --------------------------
// A member's folder is created the moment they are allowed in — not by an
// admin remembering to make one. effectiveRole() has just decided this caller
// may read documents, so this is the first instant we know the folder is owed.
//
// Fire-and-forget on purpose: a Drive hiccup must not fail the request that
// triggered it. The folder is idempotent, so the next request retries it.
async function ensureFolderForCaller(ctx, role) {
  if (role !== 'admin' && role !== 'staff') return;
  if (!ctx?.sub) return;
  try {
    const conn = await db.getConnection(ctx.tenantId, 'google_drive');
    if (!conn) return;                       // nothing to create it in yet
    const existing = await db.getMemberFolder(ctx.tenantId, ctx.sub);
    if (existing) return;
    const gd = getProvider('google_drive');
    await gd.ensureSharedFolder(ctx.tenantId);
    await gd.ensureMemberFolder(ctx.tenantId, {
      employeeRef: ctx.sub,
      email: ctx.raw?.email || ctx.email || '',
    });
  } catch (e) {
    console.warn('ensureFolderForCaller:', e.message);
  }
}

// The folder directory. An admin sees every member's folder — who has one, how
// many documents are in it — and never the documents themselves; the scope
// filter in search still applies to an admin like anyone else.
app.get('/api/folders', reader(), async (req, res) => {
  const isAdmin = req.role === 'admin';
  const shared = { name: 'Shared', scope: 'shared', everyone: true,
                   docCount: await db.sharedDocCount(req.ctx.tenantId) };
  if (!isAdmin) {
    const mine = await db.getMemberFolder(req.ctx.tenantId, req.ctx.sub);
    return res.json({ ok: true, data: { shared, folders: mine ? [{
      email: mine.email, employeeRef: mine.employee_ref, mine: true,
    }] : [] } });
  }
  const rows = await db.listMemberFolders(req.ctx.tenantId);
  res.json({ ok: true, data: { shared, folders: rows.map((r) => ({
    email: r.email || r.employee_ref,
    name: r.name || '',
    role: r.role || '',
    employeeRef: r.employee_ref,
    docCount: Number(r.doc_count || 0),
    mine: r.employee_ref === req.ctx.sub,
  })) } });
});

app.get('/api/status', reader(), async (req, res) => {
  const [connections, counts, pending] = await Promise.all([
    db.listConnections(req.ctx.tenantId),
    db.documentCounts(req.ctx.tenantId),
    db.queuePending(req.ctx.tenantId),
  ]);
  res.json({ ok: true, data: { connection: connections[0] || null, connections, providers: listProviders(), counts, pending } });
});

app.get('/api/documents', reader(), async (req, res) => {
  res.json({ ok: true, data: await db.listDocuments(req.ctx.tenantId, { limit: Number(req.query.limit) || 50 }) });
});

app.get('/api/search', reader(), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: true, data: [] });
  try {
    const vec = await embedQuery(q);
    const scopes = db.scopesFor(req.ctx.sub);
    res.json({ ok: true, data: await search(req.ctx.tenantId, vec, Math.min(Number(req.query.limit) || 8, 20), scopes) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Upload a file straight into the tenant's own Drive folder, then index it.
// The bytes go browser → plugin → the client's cloud; Eesa never stores them.
app.post('/api/upload', admin(), upload.single('file'), async (req, res) => {
  const providerKey = req.body.provider || 'google_drive';
  if (!isSupported(providerKey)) return res.status(400).json({ ok: false, error: 'unsupported provider' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file uploaded (field name must be "file")' });
  const conn = await db.getConnection(req.ctx.tenantId, providerKey);
  if (!conn) return res.status(400).json({ ok: false, error: { code: 'NOT_CONNECTED', message: 'Connect a drive first.' } });
  try {
    const uploaded = await getProvider(providerKey).uploadFile(req.ctx.tenantId, {
      name: req.file.originalname, mimeType: req.file.mimetype, buffer: req.file.buffer,
    });
    res.json({ ok: true, data: await pipeline.indexUploaded(req.ctx.tenantId, providerKey, uploaded) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/sync', admin(), async (req, res) => {
  try {
    const conns = await db.listConnections(req.ctx.tenantId);
    let queued = 0;
    for (const c of conns) { const r = await pipeline.syncTenant(req.ctx.tenantId, c.provider); queued += r.queued; }
    res.json({ ok: true, data: { queued, providers: conns.map((c) => c.provider) } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- embedded UI ----------------------------------------------------------
app.get('/app', (req, res) => res.sendFile(join(__dirname, '..', 'public', 'app.html')));

// ---- error handler --------------------------------------------------------
// Express's default handler answers a malformed body with an HTML stack trace
// listing /app/node_modules/... — a free map of the dependency tree and layout
// to anyone who POSTs `{`. Answer in the shape the caller expected instead, and
// keep the detail in the logs.
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('unhandled error:', err);
  const isRpc = req.path === '/mcp';
  const message = status === 400 && err.type === 'entity.parse.failed'
    ? 'malformed JSON body'
    : (status >= 500 ? 'internal error' : (err.message || 'request rejected'));
  if (isRpc) {
    return res.status(status).json({
      jsonrpc: '2.0', id: null, error: { code: -32700, message },
    });
  }
  res.status(status).json({ ok: false, error: message });
});

// ---- boot -----------------------------------------------------------------
const PORT = process.env.PORT || 3000;
// The schema is idempotent by design (every statement is IF NOT EXISTS, and
// db/schema.sql says so in its header), but nothing in the container ever
// applied it — the documented path is a human running
// `psql "$DATABASE_URL" -f db/schema.sql` by hand. A fresh deployment therefore
// came up healthy, served /manifest, and then failed every real call with
// `relation "members" does not exist`, which reads like a broken plugin rather
// than an un-provisioned database. Applying it at boot makes a new environment
// self-provisioning, and re-applying on every restart is a no-op.
async function applySchema() {
  const sql = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.pool.query(sql);
}

app.listen(PORT, () => {
  console.log(`eesa-plugin-documents listening on :${PORT}`);
  applySchema()
    .then(() => console.log('schema applied (idempotent)'))
    // Loud, but not fatal: a running process that can still serve /manifest and
    // report the failure beats a crash loop with no reachable diagnostics.
    .catch((e) => console.error('schema apply FAILED:', e.message));
  warm();
  // Nothing to provision at boot any more — each tenant's collection is created
  // on first use. This is a reachability check, so a wrong QDRANT_URL is loud
  // now rather than a failed search later.
  qdrantPing()
    .then((n) => console.log(`qdrant reachable (${n} collections)`))
    .catch((e) => console.warn('qdrant unreachable:', e.message));
  setInterval(() => { pipeline.drainQueue().catch(() => {}); }, 30_000);
});
