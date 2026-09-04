// Eesa Documents plugin server — three surfaces on one Coolify container:
//   POST /mcp   MCP (gateway-only + token)          → agent tools (search)
//   /api/*      REST (token; OAuth callback is open) → connect / upload / search
//   GET  /app   embedded admin UI (surface="ui")     → connect + upload + status
import express from 'express';
import { shouldRenameMemberFolder } from './providers/google_drive.js';
import { randomUUID } from 'node:crypto';
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
import { esc, page, makeState, readState, requestedScope, publishOnUpload } from './web.js';
import { embedQuery, warm } from './embed.js';
import { search, ping as qdrantPing, deleteDocument as qdrantDelete } from './qdrant.js';

const gdrive = () => getProvider('google_drive');

const __dirname = dirname(fileURLToPath(import.meta.url));
// The manifest ships with a hostname baked into every surface URL, which made
// moving the plugin to a new domain a code change and a redeploy — for a fact
// the running process already knows. PLUGIN_BASE_URL rewrites them at load, so
// the same image serves whatever hostname it is deployed behind and the
// manifest Eesa registers from is always the one that answers.
//
// Absent, it keeps the file verbatim: existing deployments are unaffected.
const MANIFEST = (() => {
  const m = JSON.parse(readFileSync(join(__dirname, '..', 'manifest.json'), 'utf-8'));
  const base = (process.env.PLUGIN_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) return m;
  // Swap only the origin, so the paths (/mcp, /app, /api) stay whatever the
  // manifest says they are.
  const rehost = (u) => {
    if (typeof u !== 'string' || !u) return u;
    try { return base + new URL(u).pathname; } catch { return u; }
  };
  for (const s of Object.values(m.surfaces || {})) {
    if (s.endpoint) s.endpoint = rehost(s.endpoint);
    if (s.url) s.url = rehost(s.url);
  }
  return m;
})();
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

// Readiness, not just liveness.
//
// This is what Coolify polls to decide when the NEW container may take over
// from the old one, and "the process is listening" is the wrong answer to that
// question: the schema is applied after listen(), so a container that answers
// 200 immediately gets traffic while its columns are still being added, and
// the first requests fail on a table the deploy is halfway through changing.
//
// Answering 503 until the schema is in place makes the swap wait. The old
// container keeps serving throughout — which is the entire point, because the
// migration is additive and the old code is happy against the new schema.
let SCHEMA_READY = false;
// Which build is actually running. Coolify exposes the deployed commit under
// one of a few names depending on version and build pack, so try them in turn
// rather than pin one and report 'unknown' forever.
//
// This exists because "did that deploy land?" kept being unanswerable. A change
// confined to server-side code alters nothing observable — same routes, same
// bytes on /app — so a redeploy that silently did not happen looked exactly
// like one that did, and the only way to tell was to exercise the behaviour and
// infer backwards. Twice that cost a debugging round chasing a bug that was
// simply not deployed yet.
const BUILD_SHA = (
  process.env.SOURCE_COMMIT
  || process.env.COOLIFY_GIT_COMMIT_SHA
  || process.env.GIT_COMMIT_SHA
  || process.env.GIT_SHA
  || ''
).slice(0, 12) || 'unknown';

app.get('/health', (req, res) => {
  if (!SCHEMA_READY) {
    return res.status(503).json({ ok: false, plugin: MANIFEST.slug, ready: false,
                                  reason: 'applying schema', build: BUILD_SHA });
  }
  res.json({ ok: true, plugin: MANIFEST.slug, ready: true, build: BUILD_SHA });
});

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
    // Identity, as it actually ARRIVES on the agent path. Inferring this from
    // outcomes cost hours: "1 hit" and "0 hits" look the same whether the
    // caller was resolved correctly, resolved as someone else, or not resolved
    // at all. Names and ids only — never query text or document content.
    try {
      const scopes = await db.readableScopes(ctx.tenantId, ctx.sub);
      console.log('[mcp] method=%s tool=%s sub=%s employeeRef=%s appRole=%s role=%s scopes=%s',
        body?.method || '?', body?.params?.name || '-',
        JSON.stringify(ctx.sub), JSON.stringify(ctx.raw?.employeeRef),
        JSON.stringify(ctx.raw?.appRole), ctx.role_, JSON.stringify(scopes));
    } catch (e) { console.warn('[mcp] identity log failed:', e.message); }
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

// Mint a one-time setup URL. Gateway-only: this is a server-to-server call
// from the platform (or an operator holding the platform secret), never
// something a browser reaches. It hands back a link, not a connection.
app.post('/api/setup-link', (req, res, next) => {
  try { requireGateway(req); } catch (e) { return res.status(e.status || 403).json({ ok: false, error: e.message }); }
  next();
}, async (req, res) => {
  const tenantId = String(req.body?.tenantId || '').trim();
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenantId is required' });
  const provider = String(req.body?.provider || 'google_drive');
  if (!isSupported(provider)) return res.status(400).json({ ok: false, error: 'unsupported provider' });
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const row = await db.createSetupLink(tenantId, {
    token, provider,
    // No fake default. 'setup' looked harmless and was not: the connect
    // callback records the member row under whatever ref the link carried, so
    // a placeholder here means the real admin never gets a member row and is
    // refused by their own plugin.
    employeeRef: String(req.body?.employeeRef || '').trim() || 'setup',
    ttlMinutes: Math.min(Number(req.body?.ttlMinutes) || 60, 1440),
  });
  const base = (process.env.PLUGIN_BASE_URL || '').replace(/\/$/, '');
  res.json({ ok: true, url: `${base}/setup/${token}`, expiresAt: row.expires_at });
});

// Open the link in a normal tab. No bearer — the token IS the authority, which
// is why claiming it is single-use and why it redirects straight out to Google
// rather than rendering anything that could be re-submitted.
app.get('/setup/:token', async (req, res) => {
  const claim = await db.claimSetupLink(String(req.params.token || ''));
  if (!claim) {
    return res.status(410).type('html').send(
      '<h3>This setup link is no longer valid.</h3>'
      + '<p>Setup links can be opened once and expire. Ask for a fresh one.</p>');
  }
  if (claim.provider === 'google_drive' && !process.env.GOOGLE_OAUTH_CLIENT_ID) {
    return res.status(500).type('html').send('<h3>Google OAuth is not configured on this server.</h3>');
  }
  const url = getProvider(claim.provider)
    .authUrl(makeState(claim.tenant_id, claim.employee_ref, claim.provider));
  res.redirect(302, url);
});

// The provider redirects here (top-level, no bearer) — trust the signed state.
// Google sends the user back to whatever URI was REGISTERED, which for this
// deployment says 'google' where our provider key says 'google_drive'. Accept
// both spellings here rather than 404 the user at the end of a consent flow
// they already completed — the alias costs nothing and the failure it prevents
// is the worst-placed one in the whole journey.
const PROVIDER_ALIASES = { google: 'google_drive' };

app.get('/api/connect/:provider/callback', async (req, res) => {
  const providerKey = PROVIDER_ALIASES[req.params.provider] || req.params.provider;
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
    const email = ctx.raw?.email || ctx.email || '';
    const existing = await db.getMemberFolder(ctx.tenantId, ctx.sub);
    if (existing) {
      // Return early only when there is genuinely nothing to repair. Two
      // separate repairs live in ensureMemberFolder and they do NOT share a
      // condition: gating both on the grant meant a folder whose grant had
      // already been settled — including one that gave up because the address
      // is not a Google account — never got its NAME fixed either. That is how
      // "36" stayed "36" through a deploy that was supposed to rename it.
      const needsGrant = !!email && !existing.owner_granted;
      const needsName = shouldRenameMemberFolder({ email, knownEmail: existing.email });
      if (!needsGrant && !needsName) return;
    }
    const gd = getProvider('google_drive');
    if (!existing) await gd.ensureSharedFolder(ctx.tenantId);
    await gd.ensureMemberFolder(ctx.tenantId, { employeeRef: ctx.sub, email });
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

// Why is a document unscoped? Answers that in one call instead of reading
// Qdrant payloads by hand. Gateway-only; returns mappings, never content.
app.get('/api/debug/scoping', (req, res, next) => {
  try { requireGateway(req); } catch (e) { return res.status(e.status || 403).json({ ok: false, error: e.message }); }
  next();
}, async (req, res) => {
  const tenantId = String(req.query.tenantId || '').trim();
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenantId required' });
  try {
    const folders = await db.listMemberFolders(tenantId);
    const shared = await db.getSharedFolderId(tenantId);
    const docs = await db.listDocuments(tenantId, { limit: 5 });
    const probes = [];
    for (const d of docs) {
      // Also load it the way the INDEXER does. listDocuments uses `select *`
      // and getDocumentByFile an explicit column list, so the two can disagree
      // about whether `folder` exists at all — which is exactly the bug this
      // endpoint was written to find.
      const asIndexer = await db.getDocumentByFile(tenantId, d.provider || 'google_drive', d.fileId || d.file_id || '');
      probes.push({ title: d.title, folder: d.folder, stored: d.scope,
                    indexerFolder: asIndexer ? (asIndexer.folder ?? null) : 'NOT FOUND',
                    computed: await db.scopeForFolder(tenantId, d.folder || '', shared) });
    }
    res.json({ ok: true, data: { sharedFolderId: shared,
      memberFolders: folders.map((f) => ({ ref: f.employee_ref, email: f.email, folderId: f.folder_id })),
      probes } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stack: String(e.stack || '').split('\n')[1] });
  }
});

// Provision a member from the platform. This is the hook Eesa calls when it
// grants someone Documents access: the plugin cannot see Eesa's roster, so
// without it a member only becomes real the first time they happen to open the
// app — and until then they are 'none' and everything refuses.
//
// Gateway-only: the platform asking, never a browser.
app.post('/api/members', (req, res, next) => {
  try { requireGateway(req); } catch (e) { return res.status(e.status || 403).json({ ok: false, error: e.message }); }
  next();
}, async (req, res) => {
  const tenantId = String(req.body?.tenantId || '').trim();
  const employeeRef = String(req.body?.employeeRef || '').trim();
  if (!tenantId || !employeeRef) {
    return res.status(400).json({ ok: false, error: 'tenantId and employeeRef are required' });
  }
  const m = await db.upsertMember(tenantId, {
    employeeRef,
    role: String(req.body?.role || 'admin'),
    email: String(req.body?.email || ''),
    name: String(req.body?.name || ''),
  });
  // Give them their folder now rather than on first visit, so an admin who
  // grants access can see it land.
  let folderId = null;
  try {
    const conn = await db.getConnection(tenantId, 'google_drive');
    if (conn) {
      const gd = getProvider('google_drive');
      await gd.ensureSharedFolder(tenantId);
      // The name travels too: a folder called "39" is unidentifiable in Drive
      // and unhelpful in the roster. Eesa sends it with the grant.
      folderId = await gd.ensureMemberFolder(tenantId, {
        employeeRef,
        email: String(req.body?.email || ''),
        name: String(req.body?.name || ''),
      });
    }
  } catch (e) {
    console.warn('member folder provisioning:', e.message);
  }
  res.json({ ok: true, data: { member: m, folderId } });
});

// The admin panel's roster: who has a folder, what is in it, and what they are
// allowed to do. Admin-only, because it lists colleagues.
app.get('/api/members', admin(), async (req, res) => {
  const rows = await db.listMembersWithFolders(req.ctx.tenantId);
  const email = req.ctx.raw?.email || req.ctx.email || '';
  const youAreMaster = await db.isMasterAdmin(req.ctx.tenantId, req.ctx.sub, email);
  res.json({ ok: true, youAreMaster, data: rows.map((r) => ({
    employeeRef: r.employee_ref,
    email: r.email || r.employee_ref,
    name: r.name || '',
    role: r.role || 'member',
    active: r.active !== false,
    canRead: r.can_read !== false,
    canUpload: r.can_upload !== false,
    hasFolder: !!r.folder_id,
    docCount: Number(r.doc_count || 0),
    // The env list counts even when the row was never stamped, so the roster
    // agrees with what enforcement will actually do.
    master: r.is_master === true
            || db.isMasterByEnv({ employeeRef: r.employee_ref, email: r.email }),
    you: r.employee_ref === req.ctx.sub,
  })) });
});

/** Grant or revoke master admin. Only a master admin may do this: an ordinary
 *  "admin" here is every member while per-app roles are dormant, so allowing
 *  it at that level would let anyone promote themselves to see everything. */
app.patch('/api/members/:ref/master', admin(), async (req, res) => {
  const email = req.ctx.raw?.email || req.ctx.email || '';
  if (!(await db.isMasterAdmin(req.ctx.tenantId, req.ctx.sub, email))) {
    return res.status(403).json({ ok: false, error: {
      code: 'FORBIDDEN', message: 'Only a master admin can change this.' } });
  }
  const row = await db.setMasterAdmin(req.ctx.tenantId, req.params.ref, !!req.body?.master);
  if (!row) return res.status(404).json({ ok: false, error: 'no such member' });
  res.json({ ok: true, data: row });
});

app.patch('/api/members/:ref', admin(), async (req, res) => {
  const ref = String(req.params.ref || '');
  const out = await db.setMemberPermissions(req.ctx.tenantId, ref, {
    canRead: req.body?.canRead,
    canUpload: req.body?.canUpload,
  });
  if (!out) return res.status(404).json({ ok: false, error: 'no such member' });
  res.json({ ok: true, data: { employeeRef: out.employee_ref,
                               canRead: out.can_read !== false,
                               canUpload: out.can_upload !== false } });
});

// ---- Shared group folders --------------------------------------------------
// Managed by Documents admins (create, rename, add and remove people, archive);
// read and written by their members; searched for members only. Everyone else
// gets "no such folder", the same answer as a folder that does not exist — a
// folder you are not in is not yours to know about. Master admins see all.

const NOT_FOUND_FOLDER = { ok: false, error: { code: 'NOT_FOUND', message: 'No such folder.' } };

function groupJson(g, sub) {
  return { ...g, member: g.members.includes(sub), memberCount: g.members.length };
}

/** The Drive folder a target string names — 'shared', 'group:<id>', or
 *  anything else for the caller's own — as `{ folderId }`. Answers the
 *  request itself and returns null when the target is a group the caller is
 *  not in. `folderId` can still be null with no Drive connected; callers that
 *  need one check. */
async function folderForTarget(req, res, gd, rawTarget) {
  const target = String(rawTarget || '').trim();
  const { tenantId, sub } = req.ctx;
  const email = req.ctx.raw?.email || req.ctx.email || '';
  if (target.toLowerCase() === 'shared') {
    return { folderId: await gd.ensureSharedFolder(tenantId) };
  }
  if (db.isGroupScope(target)) {
    const g = await db.getGroup(tenantId, db.groupIdFromScope(target));
    const master = g ? await db.isMasterAdmin(tenantId, sub, email) : false;
    if (!g || g.archived || !(master || g.members.includes(sub))) {
      res.status(404).json(NOT_FOUND_FOLDER);
      return null;
    }
    const folderId = await gd.ensureGroupFolder(tenantId, {
      groupId: g.id, name: g.name, knownFolderId: g.folderId,
    });
    return { folderId, group: g };
  }
  return { folderId: await gd.ensureMemberFolder(tenantId, { employeeRef: sub, email }) };
}

app.get('/api/groups', reader(), async (req, res) => {
  const { tenantId, sub } = req.ctx;
  const email = req.ctx.raw?.email || req.ctx.email || '';
  const master = await db.isMasterAdmin(tenantId, sub, email);
  const all = master || req.role === 'admin';
  const includeArchived = all && String(req.query.archived || '') === 'true';
  const groups = await db.listGroups(tenantId, { forRef: all ? null : sub, includeArchived });
  res.json({ ok: true, canManage: all, data: groups.map((g) => groupJson(g, sub)) });
});

app.post('/api/groups', admin(), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'A folder needs a name.' } });
  }
  const members = Array.isArray(req.body?.members) ? req.body.members : [];
  const g = await db.createGroup(req.ctx.tenantId, { name, createdBy: req.ctx.sub });
  const { unknown } = await db.addGroupMembers(req.ctx.tenantId, g.id, members, req.ctx.sub);
  // Make the Drive folder now rather than on first upload, so a file dropped
  // into it from Drive itself is already scoped when the sync finds it.
  try {
    await gdrive().ensureGroupFolder(req.ctx.tenantId, { groupId: g.id, name: g.name });
  } catch (e) {
    console.warn('group folder create:', g.id, String(e?.message || e));
  }
  const fresh = await db.getGroup(req.ctx.tenantId, g.id);
  res.status(201).json({ ok: true, data: groupJson(fresh, req.ctx.sub), unknown });
});

app.get('/api/groups/:id', reader(), async (req, res) => {
  const { tenantId, sub } = req.ctx;
  const g = await db.getGroup(tenantId, req.params.id);
  const email = req.ctx.raw?.email || req.ctx.email || '';
  const master = g ? await db.isMasterAdmin(tenantId, sub, email) : false;
  const visible = g && !(g.archived && !master)
    && (master || req.role === 'admin' || g.members.includes(sub));
  if (!visible) return res.status(404).json(NOT_FOUND_FOLDER);
  res.json({ ok: true, data: groupJson(g, sub) });
});

app.patch('/api/groups/:id', admin(), async (req, res) => {
  const g = await db.getGroup(req.ctx.tenantId, req.params.id);
  if (!g) return res.status(404).json(NOT_FOUND_FOLDER);
  const body = req.body || {};
  let unknown = [];
  const newName = typeof body.name === 'string' ? body.name.trim() : '';
  if (newName && newName !== g.name) {
    await db.renameGroup(req.ctx.tenantId, g.id, newName);
    if (g.folderId) {
      try {
        await gdrive().renameFolder(req.ctx.tenantId, g.folderId, gdrive().groupFolderName(newName, g.id));
      } catch (e) {
        console.warn('group folder rename:', g.id, String(e?.message || e));
      }
    }
  }
  if (Array.isArray(body.add) && body.add.length) {
    ({ unknown } = await db.addGroupMembers(req.ctx.tenantId, g.id, body.add, req.ctx.sub));
  }
  if (Array.isArray(body.remove) && body.remove.length) {
    await db.removeGroupMembers(req.ctx.tenantId, g.id, body.remove);
  }
  if (body.archived !== undefined) {
    await db.setGroupArchived(req.ctx.tenantId, g.id, !!body.archived);
  }
  const fresh = await db.getGroup(req.ctx.tenantId, g.id);
  res.json({ ok: true, data: groupJson(fresh, req.ctx.sub), unknown });
});

app.delete('/api/groups/:id', admin(), async (req, res) => {
  const g = await db.getGroup(req.ctx.tenantId, req.params.id);
  if (!g) return res.status(404).json(NOT_FOUND_FOLDER);
  const fresh = await db.setGroupArchived(req.ctx.tenantId, g.id, true);
  res.json({ ok: true, data: groupJson(fresh, req.ctx.sub) });
});

/** Like actionable(), for moving: the uploader and a master may, and so may
 *  anyone in the group the file currently sits in — a shared folder's files
 *  belong to the group, and "I cannot re-file what a colleague dropped here"
 *  would make the folder read-only for everyone but one person. */
async function movable(req, res) {
  const { tenantId, sub } = req.ctx;
  const email = req.ctx.raw?.email || req.ctx.email || '';
  const master = await db.isMasterAdmin(tenantId, sub, email);
  const held = master ? null : await db.readableScopes(tenantId, sub);
  const doc = await db.getDocument(tenantId, req.params.id, held);
  const mine = db.scopesFor(sub)[1] || '';
  const owned = !!doc && !!mine && doc.scope === mine;
  const inMyGroup = !!doc && db.isGroupScope(doc.scope) && Array.isArray(held) && held.includes(doc.scope);
  if (!doc || !(master || owned || inMyGroup)) {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'No such document.' } });
    return null;
  }
  return { doc, master, owned };
}

/** Move a document into another folder: 'mine' | 'shared' | 'group:<id>'.
 *  A file's scope follows its folder, so this is how a file parked in
 *  someone's own folder becomes a group's. Owner or master, like edit and
 *  delete, and the target must be one the caller may upload into. Postgres
 *  gets the new scope at once so listings are right immediately; the vectors
 *  are re-stamped by the indexer moments later. */
app.post('/api/documents/:id/move', reader(), async (req, res) => {
  const found = await movable(req, res);
  if (!found) return;
  if (!found.master && !(await db.canUpload(req.ctx.tenantId, req.ctx.sub))) {
    return res.status(403).json({ ok: false, error: {
      code: 'FORBIDDEN', message: 'An admin has turned off uploading for you.' } });
  }
  const gd = gdrive();
  const landed = await folderForTarget(req, res, gd, req.body?.target);
  if (!landed) return;
  if (!landed.folderId) {
    return res.status(409).json({ ok: false, error: { code: 'NO_DRIVE', message: 'Google Drive is not connected.' } });
  }
  try {
    const moved = await gd.moveFile(req.ctx.tenantId, found.doc.fileId, landed.folderId);
    const sharedId = await db.getSharedFolderId(req.ctx.tenantId).catch(() => '');
    const scope = await db.scopeForFolder(req.ctx.tenantId, landed.folderId, sharedId);
    await db.setDocumentFolder(found.doc.id, landed.folderId);
    await db.setDocumentScope(found.doc.id, scope);
    await db.enqueue(req.ctx.tenantId, found.doc.provider, found.doc.fileId);
    pipeline.drainQueue().catch(() => {});
    const labels = await db.scopeLabels(req.ctx.tenantId, [scope], { youRef: req.ctx.sub });
    res.json({ ok: true, data: {
      id: found.doc.id, title: found.doc.title, link: moved.link || found.doc.link,
      scope, folderLabel: labels[scope] || '',
    } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/status', reader(), async (req, res) => {
  const [connections, counts, pending] = await Promise.all([
    db.listConnections(req.ctx.tenantId),
    db.documentCounts(req.ctx.tenantId),
    db.queuePending(req.ctx.tenantId),
  ]);
  res.json({ ok: true, data: { connection: connections[0] || null, connections, providers: listProviders(), counts, pending } });
});

/** The caller's view of the library.
 *
 *  This route used to return every document in the tenant to every reader —
 *  the same leak search had, on a route nobody thought of as a search. Now it
 *  returns the caller's own folder plus Shared, and the whole workspace only
 *  for a master admin.
 *
 *  The response carries `you` so the UI does not have to guess what to show:
 *  a client that has to infer its own permissions gets it wrong, and gets it
 *  wrong in the direction of showing a button that then 403s. */
app.get('/api/documents', reader(), async (req, res) => {
  const { tenantId, sub } = req.ctx;
  const email = req.ctx.raw?.email || req.ctx.email || '';
  const master = await db.isMasterAdmin(tenantId, sub, email);
  const mineScope = db.scopesFor(sub)[1] || '';
  // The caller's readable set, once: it answers "may they ask for this
  // scope", "is their read revoked" and "which folders do they hold".
  const held = master ? [] : await db.readableScopes(tenantId, sub);
  const want = requestedScope(req.query.scope, { master, mine: mineScope, held });
  if (want === null) {
    // Same answer as a folder that does not exist — see actionable().
    return res.status(404).json({
      ok: false, error: { code: 'NOT_FOUND', message: 'No such folder.' },
    });
  }
  // undefined -> the caller's own readable set (or everything, for a master).
  const scopes = want !== undefined ? [want] : (master ? null : held);
  // A member whose read was revoked has an EMPTY readable set, and asking for
  // their own folder by name must not sneak past that.
  const revoked = !master && !held.length;
  const [docs, canUpload] = await Promise.all([
    revoked ? [] : db.listDocuments(tenantId, { limit: Number(req.query.limit) || 100, scopes }),
    db.canUpload(tenantId, sub),
  ]);
  const mine = mineScope;   // 'member:<ref>', '' if no identity
  const [groups, labels] = await Promise.all([
    db.listGroups(tenantId, { forRef: master ? null : sub }),
    db.scopeLabels(tenantId, docs.map((d) => d.scope), { youRef: sub }),
  ]);
  res.json({
    ok: true,
    data: docs.map((d) => ({
      ...d,
      downloadUrl: gdrive().downloadUrlFor(d.fileId),
      owned: d.scope === mine,
      shared: d.scope === 'shared',
      // Who may act on this row, decided server-side.
      group: db.isGroupScope(d.scope),
      folderLabel: labels[d.scope] || '',
      canEdit: master || d.scope === mine,
    })),
    you: {
      employeeRef: sub, master, canUpload, email,
      // Which folder these rows came from, so the UI can keep its sidebar
      // selection and the server's answer from disagreeing.
      viewing: want !== undefined ? want : (master ? 'all' : 'own'),
      // Master admins publish regardless of the upload switch: revoking
      // someone's upload rights should not disarm the person who administers
      // the workspace.
      canShare: master || canUpload,
      scope: mine,
      role: req.role,
      // The shared folders this caller is in (every folder, for a master), so
      // the UI never has to guess what it may show.
      groups: groups.map((g) => ({
        id: g.id, name: g.name, scope: g.scope, docCount: g.docCount,
        memberCount: g.members.length, member: g.members.includes(sub),
      })),
    },
  });
});

/** Resolve a document the caller is allowed to act on, or send the refusal.
 *  Returns null when it has already answered. */
async function actionable(req, res) {
  const { tenantId, sub } = req.ctx;
  const email = req.ctx.raw?.email || req.ctx.email || '';
  const master = await db.isMasterAdmin(tenantId, sub, email);
  const scopes = master ? null : await db.readableScopes(tenantId, sub);
  const doc = await db.getDocument(tenantId, req.params.id, scopes);
  if (!doc) {
    // Identical answer for "no such document" and "not yours": a 403 that
    // differs from a 404 tells a member exactly which documents exist in
    // someone else's folder.
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'No such document.' } });
    return null;
  }
  const mine = db.scopesFor(sub)[1] || '';
  const owned = !!mine && doc.scope === mine;
  if (!master && !owned) {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'No such document.' } });
    return null;
  }
  return { doc, master, owned };
}

/** Publish a file (anyone with the link may view) or revoke it. */
app.post('/api/documents/:id/share', reader(), async (req, res) => {
  const found = await actionable(req, res);
  if (!found) return;
  const { doc, master } = found;
  if (!master && !(await db.canUpload(req.ctx.tenantId, req.ctx.sub))) {
    return res.status(403).json({ ok: false, error: {
      code: 'SHARE_DISABLED', message: 'An admin has turned off sharing for you.' } });
  }
  const wantPublic = req.body?.public === undefined ? true : !!req.body.public;
  try {
    const gd = gdrive();
    if (!wantPublic) {
      await gd.makePrivate(req.ctx.tenantId, doc.fileId);
      const row = await db.setDocumentPublic(req.ctx.tenantId, doc.id, { publicUrl: '' });
      return res.json({ ok: true, data: { ...row, public: false } });
    }
    const out = await gd.makePublic(req.ctx.tenantId, doc.fileId);
    const row = await db.setDocumentPublic(req.ctx.tenantId, doc.id, {
      publicUrl: out.viewUrl, sharedBy: String(req.ctx.sub || ''),
    });
    res.json({ ok: true, data: {
      ...row, public: true, link: out.viewUrl, downloadUrl: out.downloadUrl } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Rename — the file in Drive and our mirror of it, in that order, so a
 *  failure leaves the two agreeing rather than diverging silently. */
app.patch('/api/documents/:id', reader(), async (req, res) => {
  const found = await actionable(req, res);
  if (!found) return;
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ ok: false, error: 'title required' });
  try {
    await gdrive().renameFile(req.ctx.tenantId, found.doc.fileId, title);
    res.json({ ok: true, data: await db.renameDocument(req.ctx.tenantId, found.doc.id, title) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** Remove a file: Drive trash (a 30-day undo), then its chunks, then the row.
 *  Chunks first among our own stores — an orphaned row is a cosmetic bug, an
 *  orphaned vector still answers questions. */
app.delete('/api/documents/:id', reader(), async (req, res) => {
  const found = await actionable(req, res);
  if (!found) return;
  try {
    await gdrive().trashFile(req.ctx.tenantId, found.doc.fileId);
    await qdrantDelete(req.ctx.tenantId, found.doc.id);
    await db.deleteDocumentRow(req.ctx.tenantId, found.doc.id);
    res.json({ ok: true, data: { id: found.doc.id, deleted: true } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/search', reader(), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: true, data: [] });
  try {
    const vec = await embedQuery(q);
    const email = req.ctx.raw?.email || req.ctx.email || '';
    const master = await db.isMasterAdmin(req.ctx.tenantId, req.ctx.sub, email);
    const scopes = master ? null : await db.readableScopes(req.ctx.tenantId, req.ctx.sub);
    const hits = await search(req.ctx.tenantId, vec, Math.min(Number(req.query.limit) || 8, 20), scopes);
    const labels = await db.scopeLabels(req.ctx.tenantId, hits.map((h) => h.scope), { youRef: req.ctx.sub });
    res.json({ ok: true, data: hits.map((h) => ({
      ...h, downloadUrl: gdrive().downloadUrlFor(h.fileId), folder: labels[h.scope] || '' })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Upload a file straight into the tenant's own Drive folder, then index it.
// The bytes go browser → plugin → the client's cloud; Eesa never stores them.
app.post('/api/upload', reader(), upload.single('file'), async (req, res) => {
  // reader(), not admin(): uploading into YOUR OWN folder is not an
  // administrative act. Whether you may do it at all is a per-member switch an
  // admin controls, checked here.
  if (!(await db.canUpload(req.ctx.tenantId, req.ctx.sub))) {
    return res.status(403).json({ ok: false, error: {
      code: 'UPLOAD_DISABLED',
      message: 'An admin has turned off uploading for you.' } });
  }
  const providerKey = req.body.provider || 'google_drive';
  if (!isSupported(providerKey)) return res.status(400).json({ ok: false, error: 'unsupported provider' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file uploaded (field name must be "file")' });
  const conn = await db.getConnection(req.ctx.tenantId, providerKey);
  if (!conn) return res.status(400).json({ ok: false, error: { code: 'NOT_CONNECTED', message: 'Connect a drive first.' } });
  try {
    // Into the caller's OWN folder. Without a parent the file lands in the root
    // and picks up no scope, which would make it readable by nobody and look
    // like a failed upload.
    const gd = getProvider(providerKey);
    // Where it lands decides who can read it, so the choice is explicit:
    // "shared" puts it in the workspace folder everyone can see, anything else
    // is the uploader's own. Default stays private — a file that quietly went
    // workspace-wide because a field was missing is the wrong failure.
    // 'shared', 'group:<id>' (a folder the caller is in), or the caller's own.
    const landed = await folderForTarget(req, res, gd, req.body.target);
    if (!landed) return;                           // answered: not their folder
    const folderId = landed.folderId;
    const toShared = String(req.body.target || '').toLowerCase() === 'shared';
    const uploaded = await gd.uploadFile(req.ctx.tenantId, {
      name: req.file.originalname, mimeType: req.file.mimetype,
      buffer: req.file.buffer, parentId: folderId,
    });
    const indexed = await pipeline.indexUploaded(req.ctx.tenantId, providerKey, uploaded);

    // Publish on upload, by DEFAULT. Send public=false to opt out.
    //
    // It used to require an explicit public=true, and only the chat-filing path
    // ever sent it — so a file uploaded from this app's own Upload button got a
    // Drive link that opened for nobody. In a workspace whose logins are not
    // Google accounts there is no per-person grant to fall back on, so an
    // unpublished file is one the person who uploaded it cannot open. Every
    // upload route defaulting to the same thing beats each caller remembering.
    //
    // Same permission check as sharing an existing file, checked the same way.
    let publicLinks = null;
    const wantPublic = publishOnUpload(req.body.public);
    if (wantPublic && indexed?.id) {
      const email = req.ctx.raw?.email || req.ctx.email || '';
      const master = await db.isMasterAdmin(req.ctx.tenantId, req.ctx.sub, email);
      if (master || await db.canUpload(req.ctx.tenantId, req.ctx.sub)) {
        const out = await gd.makePublic(req.ctx.tenantId, uploaded.fileId || uploaded.id);
        await db.setDocumentPublic(req.ctx.tenantId, indexed.id, {
          publicUrl: out.viewUrl, sharedBy: String(req.ctx.sub || ''),
        });
        publicLinks = { link: out.viewUrl, downloadUrl: out.downloadUrl };
      }
    }
    res.json({ ok: true, data: { ...indexed, target: toShared ? 'shared' : 'mine', public: publicLinks } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Trigger a sync without a user. The connect callback already kicks one off,
// but that is a single shot at the worst possible moment: if anything is
// misconfigured when the drive is attached — Qdrant unreachable, embeddings
// cold — the only sync that was ever going to run has already failed, and with
// no Re-sync button in the UI there is nothing left to retry it.
//
// Gateway-only, so this is the platform (or an operator holding its secret)
// asking, never a browser.
app.post('/api/sync-now', (req, res, next) => {
  try { requireGateway(req); } catch (e) { return res.status(e.status || 403).json({ ok: false, error: e.message }); }
  next();
}, async (req, res) => {
  const tenantId = String(req.body?.tenantId || '').trim();
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenantId is required' });
  try {
    const conns = await db.listConnections(tenantId);
    if (!conns.length) return res.json({ ok: true, data: { queued: 0, note: 'no drive connected' } });
    let queued = 0;
    for (const c of conns) { const r = await pipeline.syncTenant(tenantId, c.provider); queued += r.queued; }
    res.json({ ok: true, data: { queued, providers: conns.map((c) => c.provider) } });
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
    // After the schema, never before: the column it writes is created there.
    .then(() => db.syncMasterAdminsFromEnv())
    .then((n) => { if (n) console.log(`master admins synced from env (${n} row(s))`); })
    .then(() => { SCHEMA_READY = true; console.log('ready'); })
    // Loud, but not fatal: a running process that can still serve /manifest and
    // report the failure beats a crash loop with no reachable diagnostics.
    //
    // It does NOT become ready, so a deploy whose migration failed never takes
    // over from the container that is still working. The failure shows up as a
    // deploy that does not go live, which is the right place to notice it.
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
