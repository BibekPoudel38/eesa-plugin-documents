// Re-embed every stored chunk with the CURRENT embedding model and rewrite the
// tenant's collection at the new dimension.
//
// Why this exists: Qdrant collections are dimension-locked, so rotating
// EMBED_MODEL makes every write fail with the "holds N-dim vectors" error from
// ensureCollection(). The fix it names — "drop the collection and re-sync" —
// had no tooling, which in practice meant the model could never be changed.
//
// Nothing is re-downloaded from Drive. upsertDocumentChunks() stores the chunk
// text in the point payload, so the corpus needed to rebuild the vectors is
// already in Qdrant. That keeps this independent of Google credentials, token
// expiry and rate limits, and makes it safe to re-run.
//
// ORDER MATTERS. Chunks are read and re-embedded BEFORE the collection is
// dropped, so a model that fails to load or an embedding error leaves the
// existing index untouched. The destructive step only runs once the
// replacement vectors are in hand.
//
//   node scripts/reindex.js            # every collection
//   node scripts/reindex.js --dry-run  # report only, change nothing
//
import { QdrantClient } from '@qdrant/js-client-rest';
import { embedPassages, embedDim, MODEL_NAME } from '../src/embed.js';

const DRY = process.argv.includes('--dry-run');
const PREFIX = process.env.QDRANT_COLLECTION_PREFIX || 'eesa_docs';

function normaliseUrl(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return s;
  if (!s.includes('://')) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return s; }
  if (u.port || !u.hostname) return s;
  const port = u.protocol === 'https:' ? 443 : 6333;
  const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
  return `${u.protocol}//${u.hostname}:${port}${path}`;
}

const client = new QdrantClient({
  url: normaliseUrl(process.env.QDRANT_URL),
  apiKey: process.env.QDRANT_API_KEY || undefined,
  checkCompatibility: false,
});

async function scrollAll(name) {
  const points = [];
  let offset = null;
  do {
    const r = await client.scroll(name, {
      limit: 256, offset, with_payload: true, with_vector: false,
    });
    points.push(...r.points);
    offset = r.next_page_offset;
  } while (offset);
  return points;
}

async function reindex(name, dim) {
  const points = await scrollAll(name);
  if (!points.length) {
    console.log(`  ${name}: empty, nothing to do`);
    return { name, points: 0, skipped: true };
  }

  // A point whose payload lost its text cannot be rebuilt from here. Say so and
  // stop, rather than silently dropping it from the index — a chunk that
  // vanishes from search is far worse than a reindex that refuses to run.
  const missing = points.filter((p) => typeof p.payload?.text !== 'string' || !p.payload.text);
  if (missing.length) {
    throw new Error(
      `${name}: ${missing.length}/${points.length} points have no payload.text, ` +
      'so their vectors cannot be rebuilt without re-ingesting the source document. Aborting.',
    );
  }

  const existing = await client.getCollection(name);
  const oldDim = existing?.config?.params?.vectors?.size;
  console.log(`  ${name}: ${points.length} points, ${oldDim}-dim -> ${dim}-dim (${MODEL_NAME})`);
  if (oldDim === dim) {
    console.log('    already at the target dimension — re-embedding anyway to pick up the model');
  }
  if (DRY) return { name, points: points.length, dryRun: true };

  // Embed first. Everything below this line is destructive, and nothing below
  // runs if this throws.
  const vectors = await embedPassages(points.map((p) => p.payload.text));
  if (vectors.length !== points.length) {
    throw new Error(`${name}: embedded ${vectors.length} of ${points.length} chunks. Aborting.`);
  }
  if (vectors[0].length !== dim) {
    throw new Error(`${name}: model returned ${vectors[0].length}-dim, expected ${dim}. Aborting.`);
  }

  await client.deleteCollection(name);
  await client.createCollection(name, { vectors: { size: dim, distance: 'Cosine' } });
  // Recreated from scratch, so the payload indexes ensureCollection() adds are
  // gone with it and have to be put back here.
  for (const field of ['tenant_id', 'document_id']) {
    try { await client.createPayloadIndex(name, { field_name: field, field_schema: 'keyword' }); }
    catch { /* already present */ }
  }

  // Ids and payloads are carried over verbatim: only the vectors change, so
  // scopes, links and chunk order survive exactly as they were.
  await client.upsert(name, {
    wait: true,
    points: points.map((p, i) => ({ id: p.id, vector: vectors[i], payload: p.payload })),
  });

  const after = await client.getCollection(name);
  console.log(`    done: ${after.points_count} points at ${after.config.params.vectors.size}-dim`);
  return { name, points: points.length, after: after.points_count };
}

const dim = await embedDim();
console.log(`model ${MODEL_NAME} produces ${dim}-dim vectors${DRY ? ' (dry run)' : ''}`);

const { collections } = await client.getCollections();
const mine = collections.map((c) => c.name).filter((n) => n.startsWith(`${PREFIX}_`));
if (!mine.length) {
  console.log('no collections found for prefix', PREFIX);
  process.exit(0);
}

const results = [];
for (const name of mine) results.push(await reindex(name, dim));
const total = results.reduce((n, r) => n + (r.after ?? 0), 0);
console.log(`reindex complete: ${results.length} collection(s), ${total} points rewritten`);
