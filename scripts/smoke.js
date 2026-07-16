// Post-deploy smoke test — proves the risky dependencies actually work INSIDE
// this container, in isolation, before you debug anything through Eesa chat.
//
//   docker exec -it <container> node scripts/smoke.js      (or: npm run smoke)
//
// Checks, in dependency order: env → postgres/schema → FastEmbed → Qdrant
// (upsert+search+cleanup) → extraction/chunking. Exits non-zero on any failure.
import { randomUUID } from 'node:crypto';
import { embedQuery, EMBED_DIM } from '../src/embed.js';
import { ensureCollection, upsertDocumentChunks, search, deleteDocument } from '../src/qdrant.js';
import { extractText, chunkText } from '../src/extract.js';
import { pool } from '../src/db.js';

let failed = 0;
async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`  PASS  ${name} ${detail || ''}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}: ${(e && e.message) || e}`);
  }
}

console.log('\nEesa Documents — smoke test\n');

await step('env', () => {
  const need = [
    'DATABASE_URL', 'QDRANT_URL', 'EESA_JWKS_URL', 'PLUGIN_ENC_KEY',
    'PLUGIN_BASE_URL', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
  ];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error('missing → ' + missing.join(', '));
  if ((process.env.PLUGIN_ENC_KEY || '').length !== 64) {
    throw new Error('PLUGIN_ENC_KEY must be 32-byte hex (openssl rand -hex 32)');
  }
  return '(all present)';
});

await step('postgres + schema', async () => {
  const r = await pool.query(
    `select count(*)::int as n from information_schema.tables
      where table_name in ('connections','documents','members','ingest_jobs')`,
  );
  const n = r.rows[0].n;
  if (n < 4) throw new Error(`only ${n}/4 tables — apply db/schema.sql`);
  return '(4/4 tables)';
});

await step('embeddings (FastEmbed)', async () => {
  const v = await embedQuery('hello world');
  if (!Array.isArray(v) || v.length !== EMBED_DIM) {
    throw new Error(`expected ${EMBED_DIM} dims, got ${v && v.length}`);
  }
  return `(${v.length} dims)`;
});

const TID = 'smoke-' + randomUUID().slice(0, 8);
const DID = randomUUID();
await step('qdrant upsert + semantic search', async () => {
  await ensureCollection();
  const passage = 'The quarterly lease renewal agreement for the Anaheim premises.';
  await upsertDocumentChunks(TID, DID, [{
    vector: await embedQuery(passage), text: passage, chunkIx: 0,
    title: 'Smoke Doc', link: 'https://example.com/smoke',
  }]);
  const hits = await search(TID, await embedQuery('lease renewal'), 3);
  if (!hits.length) throw new Error('no hits returned');
  return `(top: "${hits[0].title}" score ${Number(hits[0].score).toFixed(3)})`;
});

await step('qdrant cleanup', async () => {
  await deleteDocument(TID, DID);
  return '(test vectors removed)';
});

await step('extract + chunk', async () => {
  const { text } = await extractText(Buffer.from('Hello world. '.repeat(300), 'utf8'), 'text/plain', 'smoke.txt');
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error('no chunks produced');
  return `(${chunks.length} chunks)`;
});

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nAll checks passed — the pipeline works in this container.\n');
await pool.end().catch(() => {});
process.exit(failed ? 1 : 0);
