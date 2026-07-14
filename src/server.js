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
import { encrypt, decrypt } from './crypto.js';
import * as db from './db.js';
import * as pipeline from './pipeline.js';
import { getProvider, listProviders, isSupported } from './providers/index.js';
import { handleRpc } from './mcp.js';
import { embedQuery, warm } from './embed.js';
import { search, ensureCollection } from './qdrant.js';

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
app.get('/manifest', (req, res) => res.json(MANIFEST));

// ---- MCP surface: gateway-only + token, JSON-RPC ----
app.post('/mcp', async (req, res) => {
  const body = req.body || {};
  const isNotification = !('id' in body);
  try {
    requireGateway(req);
    const ctx = await verifyToken(req.get('Authorization'));
    const result = await handleRpc(body, ctx, serverInfo);
    if (isNotification || result === null) return res.status(202).end();
    return res.json({ jsonrpc: '2.0', id: body.id, result });
  } catch (e) {
    if (isNotification) return res.status(202).end();
    return res.status(e.status || 200).json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: e.code || -32000, message: e.message } });
  }
});

// ---- admin gate (v1 is admin-only) ----------------------------------------
function isPlatformAdmin(ctx) {
  return String(ctx.role || '').toUpperCase() === 'ADMIN';
}
function admin() {
  return async (req, res, next) => {
    try {
      req.ctx = await verifyToken(req.get('Authorization'));
    } catch (e) {
      return res.status(e.status || 401).json({ ok: false, error: e.message });
    }
    const member = await db.getMember(req.ctx.tenantId, req.ctx.sub);
    if (!(isPlatformAdmin(req.ctx) || member)) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required.' } });
    }
    req.member = member;
    next();
  };
}

// ---- OAuth connect (generic across providers) -----------------------------
// state carries tenant + user + provider through the provider's redirect,
// tamper-proof (AES-256-GCM). start is token-authed; the callback trusts state.
function makeState(tenantId, sub, provider) {
  return encodeURIComponent(encrypt(JSON.stringify({ t: tenantId, s: sub, p: provider, ts: Date.now() })));
}
function readState(state) {
  try { return JSON.parse(decrypt(decodeURIComponent(String(state || '')))); }
  catch { return null; }
}
function page(title, body) {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
  <title>${title}</title><body style="font-family:system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#0b1020;color:#e6e9f0">
  <div style="max-width:420px;text-align:center;padding:24px"><h2 style="margin:0 0 8px">${title}</h2>
  <p style="opacity:.8;line-height:1.5">${body}</p></div>`;
}

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
  if (error) return res.status(400).send(page('Connection cancelled', String(error)));
  const st = readState(state);
  if (!isSupported(providerKey) || !code || !st?.t || st.p !== providerKey) {
    return res.status(400).send(page('Invalid callback', 'Missing or mismatched authorization state.'));
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
    return res.send(page(`${label} connected ✓`, `We're indexing <b>${tok.accountEmail || 'your drive'}</b> now. Return to Eesa chat and ask for a document by meaning — e.g. "find the lease agreement".`));
  } catch (e) {
    return res.status(500).send(page('Connection failed', e.message));
  }
});

// ---- status / documents / search / upload / sync --------------------------
app.get('/api/status', admin(), async (req, res) => {
  const [connections, counts, pending] = await Promise.all([
    db.listConnections(req.ctx.tenantId),
    db.documentCounts(req.ctx.tenantId),
    db.queuePending(),
  ]);
  res.json({ ok: true, data: { connection: connections[0] || null, connections, providers: listProviders(), counts, pending } });
});

app.get('/api/documents', admin(), async (req, res) => {
  res.json({ ok: true, data: await db.listDocuments(req.ctx.tenantId, { limit: Number(req.query.limit) || 50 }) });
});

app.get('/api/search', admin(), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: true, data: [] });
  try {
    const vec = await embedQuery(q);
    res.json({ ok: true, data: await search(req.ctx.tenantId, vec, Math.min(Number(req.query.limit) || 8, 20)) });
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

// ---- boot -----------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`eesa-plugin-documents listening on :${PORT}`);
  warm();
  ensureCollection().catch((e) => console.warn('qdrant init:', e.message));
  setInterval(() => { pipeline.drainQueue().catch(() => {}); }, 30_000);
});
