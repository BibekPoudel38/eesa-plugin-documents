// Eesa Documents MCP surface — the agent tools. Text + links only (fits the
// platform's text-only tool-result rule): search returns titles, matching
// passages, and links back to the file in the tenant's own cloud.
import * as db from './db.js';
import { embedQuery } from './embed.js';
import { search } from './qdrant.js';
import { getProvider } from './providers/index.js';

const PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'search_documents',
    description:
      'Find the most relevant documents by MEANING (semantic search over content), not just filename. Use for "find the doc about X", "which file mentions Y". Returns titles, matching passages, and links.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in natural language.' },
        limit: { type: 'integer', description: 'Max documents to return (default 6).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_documents',
    description: 'List the documents you can see (most recent first). Your own folder plus anything in Shared.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'get_document_link',
    description:
      'Get the links to a specific document by title (or id): a view link and a direct DOWNLOAD url. '
      + 'Use when asked to "send me the file", "share the doc", "give me a download link".',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  },
  {
    name: 'share_document',
    description:
      'Make a document public (anyone with the link can view/download) and return the link, or '
      + 'set public=false to revoke. Use for "make this file public", "share this outside", "stop sharing".',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title or id.' },
        public: { type: 'boolean', description: 'true to publish (default), false to revoke.' },
      },
      required: ['title'],
    },
  },
];

export async function handleRpc(body, ctx, serverInfo) {
  const { method, params = {} } = body;
  if (method === 'initialize') {
    return { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments || {};
    try {
      const result = await runTool(name, args, ctx);
      const text = typeof result === 'string' ? result : JSON.stringify(result);
      return { content: [{ type: 'text', text }], isError: false };
    } catch (e) {
      if (e.code === -32601) throw e;
      return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
    }
  }
  const err = new Error('Unknown method: ' + method);
  err.code = -32601;
  throw err;
}

const gd = () => getProvider('google_drive');

/** What this caller may read: their own folder plus Shared — or everything,
 *  for a master admin. Derived here from the verified identity, never from
 *  tool arguments: an agent tool call is attacker-influenced text, and a scope
 *  taken from it would let a question ask for someone else's folder. */
async function callerScopes(ctx) {
  if (await db.isMasterAdmin(ctx.tenantId, ctx.sub, ctx.email || '')) return null;
  return db.readableScopes(ctx.tenantId, ctx.sub);
}

async function runTool(name, args, ctx) {
  // Every tool here reads documents, so "staff" is the floor. `role_` is set by
  // the /mcp handler; when it is absent (a caller that skipped that path) fail
  // closed rather than assuming access.
  if (ctx.role_ !== 'admin' && ctx.role_ !== 'staff') {
    return {
      results: [],
      note: 'You do not have access to the documents in this workspace. '
        + 'A workspace admin can grant it under Management, Documents.',
    };
  }
  if (name === 'search_documents') {
    const query = String(args.query || '').trim();
    if (!query) return { results: [], note: 'Provide a search query.' };
    const conn = await db.getConnection(ctx.tenantId, 'google_drive');
    if (!conn) return { results: [], note: 'No cloud drive is connected yet. Open the Documents app and connect Google Drive.' };
    const vec = await embedQuery(query);
    // The caller's own scopes, derived here rather than trusted from args —
    // an agent tool call is attacker-influenced text, and a scope taken from
    // it would let a question ask for someone else's folder.
    const scopes = await callerScopes(ctx);
    const hits = await search(ctx.tenantId, vec, Math.min(Number(args.limit) || 6, 20), scopes);
    return {
      results: hits.map((h) => ({
        title: h.title,
        link: h.link,
        // So "find the supplier doc and send me the file" is one call, not two.
        downloadUrl: gd().downloadUrlFor(h.fileId),
        snippet: (h.snippet || '').slice(0, 400),
        score: Number((h.score ?? 0).toFixed(3)),
      })),
      note: hits.length ? undefined : 'No matching documents were found.',
    };
  }
  if (name === 'list_documents') {
    // Scoped exactly like search. Without this a member could skip the vector
    // search entirely and just LIST the workspace — the same leak, on a route
    // that never looked like a search.
    const scopes = await callerScopes(ctx);
    const docs = await db.listDocuments(ctx.tenantId, {
      limit: Math.min(Number(args.limit) || 30, 200), scopes,
    });
    return {
      documents: docs.filter((d) => d.state === 'indexed').map((d) => ({
        title: d.title,
        link: d.link,
        downloadUrl: gd().downloadUrlFor(d.fileId),
        public: !!d.publicUrl,
        indexedAt: d.indexedAt,
      })),
    };
  }
  if (name === 'get_document_link') {
    const ref = String(args.title || args.ref || args.id || '').trim();
    const scopes = await callerScopes(ctx);
    const d = ref ? await db.findDocument(ctx.tenantId, ref, scopes) : null;
    // Same wording whether the file is missing or simply not yours: an
    // answer that distinguishes them tells a member which documents exist in
    // someone else's folder.
    if (!d) return { found: false, note: 'No matching document you can access.' };
    return {
      found: true,
      title: d.title,
      link: d.link,
      downloadUrl: gd().downloadUrlFor(d.fileId),
      public: !!d.publicUrl,
      publicUrl: d.publicUrl || undefined,
    };
  }

  if (name === 'share_document') {
    const ref = String(args.title || args.ref || args.id || '').trim();
    const scopes = await callerScopes(ctx);
    const d = ref ? await db.findDocument(ctx.tenantId, ref, scopes) : null;
    if (!d) return { ok: false, note: 'No matching document you can access.' };
    // Publishing is a write, and a link that leaves the workspace is the one
    // action here with consequences outside it. Anyone who may not upload may
    // not publish either.
    const master = await db.isMasterAdmin(ctx.tenantId, ctx.sub, ctx.email || '');
    if (!master && !(await db.canUpload(ctx.tenantId, ctx.sub))) {
      return { ok: false, note: 'You do not have permission to share files. Ask a workspace admin.' };
    }
    const wantPublic = args.public === undefined ? true : !!args.public;
    const provider = gd();
    if (!wantPublic) {
      await provider.makePrivate(ctx.tenantId, d.fileId);
      await db.setDocumentPublic(ctx.tenantId, d.id, { publicUrl: '' });
      return { ok: true, title: d.title, public: false, note: 'The public link has been revoked.' };
    }
    const out = await provider.makePublic(ctx.tenantId, d.fileId);
    await db.setDocumentPublic(ctx.tenantId, d.id, {
      publicUrl: out.viewUrl, sharedBy: String(ctx.sub || ''),
    });
    return {
      ok: true, title: d.title, public: true,
      link: out.viewUrl, downloadUrl: out.downloadUrl,
      note: 'Anyone with this link can now view and download the file.',
    };
  }
  const err = new Error('Unknown tool: ' + name);
  err.code = -32601;
  throw err;
}
