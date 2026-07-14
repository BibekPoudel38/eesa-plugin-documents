// Ingestion pipeline: fetch (transient) -> extract text -> chunk -> embed
// (FastEmbed) -> upsert to Qdrant -> stamp metadata. The file BYTES are never
// persisted anywhere — only embeddings + a snippet + the link survive.
// Provider-agnostic: works for any storage backend in ./providers.
import crypto from 'node:crypto';
import * as db from './db.js';
import { getProvider } from './providers/index.js';
import { extractText, chunkText } from './extract.js';
import { embedPassages } from './embed.js';
import { upsertDocumentChunks, deleteDocument } from './qdrant.js';

const MAX_BYTES = Number(process.env.INGEST_MAX_FILE_MB || 25) * 1024 * 1024;

async function processJob(job) {
  const { tenant_id: tenantId, provider: providerKey, file_id: fileId } = job;
  const doc = await db.getDocumentByFile(tenantId, providerKey, fileId);
  if (!doc) return; // metadata vanished between enqueue and run

  if (doc.sizeBytes && doc.sizeBytes > MAX_BYTES) {
    await deleteDocument(tenantId, doc.id);
    await db.markDocumentState(doc.id, 'skipped', `over ${Math.round(MAX_BYTES / 1024 / 1024)}MB`);
    return;
  }

  const provider = getProvider(providerKey);
  const { buffer, mime } = await provider.downloadContent(tenantId, { id: fileId, mimeType: doc.mime });
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const { text } = await extractText(buffer, mime, doc.title);

  const chunks = chunkText(text);
  if (!chunks.length) {
    await deleteDocument(tenantId, doc.id);
    await db.markDocumentState(doc.id, 'skipped', 'no extractable text');
    return;
  }

  const vectors = await embedPassages(chunks);
  const points = chunks.map((c, i) => ({
    vector: vectors[i], text: c.slice(0, 1500), chunkIx: i, title: doc.title, link: doc.link,
  }));
  await upsertDocumentChunks(tenantId, doc.id, points);
  await db.markDocumentIndexed(doc.id, { chunkCount: chunks.length, contentHash: hash });
}

// Drain the durable queue. Single-flight per process; jobs are claimed with
// SKIP LOCKED so more than one process/container is safe too.
let _draining = false;
export async function drainQueue() {
  if (_draining) return;
  _draining = true;
  try {
    for (;;) {
      const job = await db.claimJob();
      if (!job) break;
      try {
        await processJob(job);
        await db.finishJob(job.id, true);
      } catch (e) {
        console.warn('ingest job failed', job.file_id, '-', e.message);
        await db.finishJob(job.id, false, e.message);
        try {
          const d = await db.getDocumentByFile(job.tenant_id, job.provider, job.file_id);
          if (d) await db.markDocumentState(d.id, 'error', e.message);
        } catch { /* best effort */ }
      }
    }
  } finally {
    _draining = false;
  }
}

// Full sync of one connected provider for a tenant: list -> upsert metadata ->
// enqueue changed files -> drain in the background. Returns how many were queued.
export async function syncTenant(tenantId, providerKey = 'google_drive') {
  const provider = getProvider(providerKey);
  await db.setConnectionMeta(tenantId, providerKey, { status: 'syncing', lastError: '' });
  try {
    if (typeof provider.ensureFolder === 'function') await provider.ensureFolder(tenantId);
    let queued = 0;
    await provider.listAllFiles(tenantId, async (f) => {
      const { changed } = await db.upsertDocument(tenantId, {
        provider: providerKey, fileId: f.id, title: f.name, mime: f.mimeType,
        link: f.link || '', sizeBytes: f.size ?? null, contentHash: f.hash ?? null,
      });
      if (changed) { await db.enqueue(tenantId, providerKey, f.id); queued++; }
    });
    await db.setConnectionMeta(tenantId, providerKey, { status: 'connected' });
    drainQueue().catch((e) => console.warn('drain failed:', e.message)); // fire-and-forget
    return { queued };
  } catch (e) {
    await db.setConnectionMeta(tenantId, providerKey, { status: 'error', lastError: e.message });
    throw e;
  }
}

// Index a single freshly-uploaded file immediately (used by the upload path).
export async function indexUploaded(tenantId, providerKey, file) {
  const { id } = await db.upsertDocument(tenantId, {
    provider: providerKey, fileId: file.id, title: file.name, mime: file.mimeType,
    link: file.link || '', sizeBytes: file.size ?? null, contentHash: file.hash ?? null,
    folder: 'Eesa Documents',
  });
  await db.enqueue(tenantId, providerKey, file.id);
  drainQueue().catch(() => {});
  return { id, title: file.name, link: file.link };
}
