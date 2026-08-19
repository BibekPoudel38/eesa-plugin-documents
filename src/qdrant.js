// Vector index — points at the SAME Qdrant the platform's workflow and memory
// indexes use (copy QDRANT_URL / QDRANT_API_KEY from the super-admin's saved
// Qdrant settings, which is where the platform reads its own config from).
//
// One collection PER TENANT, created on first use: `eesa_docs_<tenant>`.
//
// Note the trade-off, so whoever reads this next has it: Qdrant recommends a
// single collection partitioned by a payload field, and caps a Cloud cluster at
// 1,000 collections — "not recommended to create hundreds and thousands of
// collections per cluster as it increases resource overhead unsustainably".
// The platform's own indexes follow that advice. This plugin does not, by
// deliberate choice: a per-tenant collection cannot leak across tenants even if
// a filter is forgotten. If workspace count ever approaches the low hundreds,
// revisit — the migration back is a re-index, not a schema change.
//
// The tenant_id payload + filter are KEPT anyway. They cost nothing and mean a
// bug in collection-name derivation still cannot return another tenant's rows.
import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'node:crypto';
import { embedDim, MODEL_NAME } from './embed.js';

const PREFIX = process.env.QDRANT_COLLECTION_PREFIX || 'eesa_docs';

/** qdrant-client defaults to :6333 when a URL carries no port, which is right
 *  for self-hosted and Qdrant Cloud but wrong behind a plain HTTPS proxy
 *  (Railway, Render, Fly). The symptom is not an error but a hang, so make the
 *  port explicit. Mirrors `_normalise_qdrant_url` in the platform backend. */
function normaliseUrl(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return s;
  if (!s.includes('://')) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return s; }
  if (u.port || !u.hostname) return s; // explicit, or unparseable — don't guess
  const port = u.protocol === 'https:' ? 443 : 6333;
  const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
  return `${u.protocol}//${u.hostname}:${port}${path}`;
}

/** Collection name for a tenant. The id comes from a verified token, but it
 *  still gets sanitised: it lands in a URL path, and an unexpected character
 *  would fail confusingly rather than safely. */
export function collectionFor(tenantId) {
  const safe = String(tenantId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!safe) throw new Error('collectionFor: empty tenant id');
  return `${PREFIX}_${safe}`;
}

let _client = null;
function client() {
  if (!_client) {
    _client = new QdrantClient({
      url: normaliseUrl(process.env.QDRANT_URL),
      apiKey: process.env.QDRANT_API_KEY || undefined,
      checkCompatibility: false,
    });
  }
  return _client;
}

/** Reachability check for boot and the smoke test. Collections are created
 *  lazily per tenant now, so there is nothing to provision at startup — but a
 *  wrong URL or key should still be loud immediately rather than surfacing as a
 *  failed search hours later. Returns the collection count on success. */
export async function ping() {
  const { collections } = await client().getCollections();
  return collections.length;
}

// One in-flight promise per tenant, so N concurrent searches on a cold tenant
// issue one create rather than N racing ones.
const _ready = new Map();

export async function ensureCollection(tenantId) {
  const name = collectionFor(tenantId);
  if (_ready.has(name)) return _ready.get(name);

  const p = (async () => {
    const c = client();
    const dim = await embedDim();
    let existing = null;
    try {
      existing = await c.getCollection(name);
    } catch {
      // Missing (or unreadable) — try to create. A concurrent creator winning
      // the race is success, not failure, so swallow "already exists".
      try {
        await c.createCollection(name, { vectors: { size: dim, distance: 'Cosine' } });
      } catch (e) {
        if (!/already exists|conflict/i.test(e?.message || '')) throw e;
      }
    }
    // Qdrant collections are dimension-locked. If the operator rotated
    // EMBED_MODEL after this tenant was indexed, every write would be rejected
    // with a vague dimension error — say what actually happened instead.
    const size = existing?.config?.params?.vectors?.size;
    if (size != null && size !== dim) {
      throw new Error(
        `collection ${name} holds ${size}-dim vectors but ${MODEL_NAME} produces ${dim}. ` +
        'Re-index this tenant (drop the collection and re-sync) or restore the previous EMBED_MODEL.',
      );
    }
    // Kept for defence in depth even though the collection is single-tenant.
    for (const field of ['tenant_id', 'document_id']) {
      try { await c.createPayloadIndex(name, { field_name: field, field_schema: 'keyword' }); }
      catch { /* index already exists */ }
    }
    return name;
  })();

  _ready.set(name, p);
  // Don't cache a failure: a transient outage would otherwise poison this
  // tenant's collection for the life of the process.
  p.catch(() => _ready.delete(name));
  return p;
}

// Replace ALL vectors for a document with a fresh set (idempotent re-index).
export async function upsertDocumentChunks(tenantId, documentId, chunks, scope = '') {
  const name = await ensureCollection(tenantId);
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
      // Stamped so download links do not depend on parsing the view URL
      // forever; the parser stays for chunks indexed before this existed.
      file_id: ch.fileId || fileIdFromLink(ch.link),
      // Who this chunk may answer for. See search(): an empty scope matches
      // nobody, so a document indexed before scoping existed stays invisible
      // until it is re-synced rather than silently becoming readable by all.
      scope: scope || '',
    },
  }));
  await client().upsert(name, { wait: true, points });
}

export async function deleteDocument(tenantId, documentId) {
  const name = await ensureCollection(tenantId);
  await client().delete(name, {
    wait: true,
    filter: { must: [
      { key: 'tenant_id', match: { value: tenantId } },
      { key: 'document_id', match: { value: documentId } },
    ] },
  });
}

/** Drop a tenant's index entirely. Used when a workspace disconnects its drive
 *  or is offboarded: with a collection per tenant, "forget everything about
 *  them" is one call rather than a filtered delete. */
export async function dropTenant(tenantId) {
  const name = collectionFor(tenantId);
  _ready.delete(name);
  try { await client().deleteCollection(name); }
  catch (e) { if (!/not found|doesn't exist|does not exist/i.test(e?.message || '')) throw e; }
}

// Semantic search, tenant-scoped. Returns one hit per document (best chunk).
/** The Drive file id behind an indexed chunk.
 *
 *  Chunks indexed before download links existed carry no file_id, and
 *  re-indexing every tenant to add one would be a lot of embedding spend for a
 *  field the link already contains. Prefer the payload when it is there, parse
 *  the link when it is not. */
export function fileIdFromLink(link) {
  const m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(String(link || ''))
    || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(String(link || ''));
  return m ? m[1] : '';
}

export async function search(tenantId, vector, limit = 6, scopes = null) {
  // A caller with NO readable scopes reads nothing — short-circuit before the
  // query. This is not an optimisation: Qdrant treats `should: []` as an empty
  // constraint, i.e. it matches EVERYTHING, so building the filter from an
  // empty array would turn "this person may read nothing" into "this person
  // may read the entire workspace". The one case that must never be a leak is
  // the one an empty list would produce.
  if (Array.isArray(scopes) && scopes.length === 0) return [];
  const name = await ensureCollection(tenantId);
  // `query`, not `search`: the client dropped .search() in 1.12 and the range
  // here (^1.11.0) had been resolving to a version without it, so semantic
  // search failed at runtime with "client(...).search is not a function".
  // `query` also returns {points:[...]} rather than a bare array.
  const res = await client().query(name, {
    query: vector,
    limit: Math.max(limit, limit * 3), // over-fetch, then dedupe by document
    // Scope is enforced INSIDE the query, never by filtering results
    // afterwards. Post-filtering leaks: the excluded chunks still compete for
    // rank, so a well-aimed question changes which allowed chunk surfaces, and
    // the over-fetch/dedupe below would quietly drop allowed hits in favour of
    // ones the caller may not read.
    //
    // `scopes === null` means "no scoping asked for" and preserves the old
    // behaviour for callers that have not been updated. An EMPTY array means
    // "this caller may read nothing" and must match nothing — not everything.
    filter: {
      must: [
        { key: 'tenant_id', match: { value: tenantId } },
        ...(scopes === null
          ? []
          : [{ should: scopes.map((sc) => ({ key: 'scope', match: { value: sc } })) }]),
      ],
    },
    with_payload: true,
  });
  // What the filter ACTUALLY was, and what came back under it. Identity was
  // already proven correct at the /mcp boundary while results still crossed
  // users, so the remaining question is whether this function received the
  // scopes at all — and a returned point whose payload scope is not in the
  // caller's list is the leak itself, printed.
  try {
    const got = (res.points || []).map((r) => r.payload?.scope ?? null);
    const bad = got.filter((sc) => scopes && !scopes.includes(sc));
    console.log('[qdrant.search] scopesArg=%s points=%d scopesReturned=%s%s',
      JSON.stringify(scopes), (res.points || []).length, JSON.stringify(got),
      bad.length ? ' *** OUT-OF-SCOPE=' + JSON.stringify(bad) + ' ***' : '');
  } catch (e) { /* logging must never break a search */ }

  const seen = new Set();
  const out = [];
  for (const r of (res.points || [])) {
    const docId = r.payload.document_id;
    if (seen.has(docId)) continue;
    seen.add(docId);
    out.push({
      score: r.score,
      documentId: docId,
      title: r.payload.title,
      link: r.payload.link,
      fileId: r.payload.file_id || fileIdFromLink(r.payload.link),
      snippet: r.payload.text,
    });
    if (out.length >= limit) break;
  }
  return out;
}
