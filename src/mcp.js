// Eesa Documents MCP surface — the agent tools. Text + links only (fits the
// platform's text-only tool-result rule): search returns titles, matching
// passages, and links back to the file in the tenant's own cloud.
import * as db from './db.js';
import { embedQuery } from './embed.js';
import { search } from './qdrant.js';

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
    description: 'List the documents indexed for this workspace (most recent first).',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'get_document_link',
    description: 'Get the shareable link to a specific document by its title (or id).',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
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
    const scopes = await db.readableScopes(ctx.tenantId, ctx.sub);
    const hits = await search(ctx.tenantId, vec, Math.min(Number(args.limit) || 6, 20), scopes);
    return {
      results: hits.map((h) => ({
        title: h.title,
        link: h.link,
        snippet: (h.snippet || '').slice(0, 400),
        score: Number((h.score ?? 0).toFixed(3)),
      })),
      note: hits.length ? undefined : 'No matching documents were found.',
    };
  }
  if (name === 'list_documents') {
    const docs = await db.listDocuments(ctx.tenantId, { limit: Math.min(Number(args.limit) || 30, 200) });
    return { documents: docs.filter((d) => d.state === 'indexed').map((d) => ({ title: d.title, link: d.link, indexedAt: d.indexedAt })) };
  }
  if (name === 'get_document_link') {
    const ref = String(args.title || args.ref || args.id || '').trim();
    const d = ref ? await db.findDocument(ctx.tenantId, ref) : null;
    if (!d) return { found: false, note: 'No matching document.' };
    return { found: true, title: d.title, link: d.link };
  }
  const err = new Error('Unknown tool: ' + name);
  err.code = -32601;
  throw err;
}
