// Vector index — the plugin's OWN Qdrant (self-hosted on Coolify). One shared
// collection, hard-partitioned by tenant_id on every write and read. Stores the
// embedding + a snippet of text + the link back to the file; never the bytes.
import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'node:crypto';
import { EMBED_DIM } from './embed.js';

const COLLECTION = 'eesa_docs';

let _client = null;
function client() {
  if (!_client) {
    _client = new QdrantClient({
      url: process.env.QDRANT_URL,
      apiKey: process.env.QDRANT_API_KEY || undefined,
      checkCompatibility: false,
    });
  }
  return _client;
}

let _ready = null;
export async function ensureCollection() {
  if (_ready) return _ready;
  _ready = (async () => {
    const c = client();
    const { collections } = await c.getCollections();
    if (!collections.some((x) => x.name === COLLECTION)) {
      await c.createCollection(COLLECTION, { vectors: { size: EMBED_DIM, distance: 'Cosine' } });
    }
    for (const field of ['tenant_id', 'document_id']) {
      try { await c.createPayloadIndex(COLLECTION, { field_name: field, field_schema: 'keyword' }); }
      catch { /* index already exists */ }
    }
    return true;
  })();
  return _ready;
}

// Replace ALL vectors for a document with a fresh set (idempotent re-index).
export async function upsertDocumentChunks(tenantId, documentId, chunks) {
  await ensureCollection();
  await deleteDocument(tenantId, documentId);
  if (!chunks.length) return;
  const points = chunks.map((ch) => ({
    id: randomUUID(),
    vector: ch.vector,
    payload: {
      tenant_id: tenantId,
      document_id: documentId,
      chunk_ix: ch.chunkIx,
      text: ch.text,
      title: ch.title,
      link: ch.link,
    },
  }));
  await client().upsert(COLLECTION, { wait: true, points });
}

export async function deleteDocument(tenantId, documentId) {
  await ensureCollection();
  await client().delete(COLLECTION, {
    wait: true,
    filter: { must: [
      { key: 'tenant_id', match: { value: tenantId } },
      { key: 'document_id', match: { value: documentId } },
    ] },
  });
}

// Semantic search, tenant-scoped. Returns one hit per document (best chunk).
export async function search(tenantId, vector, limit = 6) {
  await ensureCollection();
  const res = await client().search(COLLECTION, {
    vector,
    limit: Math.max(limit, limit * 3), // over-fetch, then dedupe by document
    filter: { must: [{ key: 'tenant_id', match: { value: tenantId } }] },
    with_payload: true,
  });
  const seen = new Set();
  const out = [];
  for (const r of res) {
    const docId = r.payload.document_id;
    if (seen.has(docId)) continue;
    seen.add(docId);
    out.push({
      score: r.score,
      documentId: docId,
      title: r.payload.title,
      link: r.payload.link,
      snippet: r.payload.text,
    });
    if (out.length >= limit) break;
  }
  return out;
}
