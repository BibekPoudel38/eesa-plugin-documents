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
  // Stamp the scope from the folder the file actually lives in. Derived here,
  // at index time, rather than at query time: a document's permission should
  // not depend on who happens to be asking, and re-deriving it per search would
  // be a Drive round trip on every question.
  //
  // An unrecognised folder yields '' — indexed, but readable by nobody. That is
  // the safe direction for a misfiled document: invisible beats public.
  const sharedId = await db.getSharedFolderId(tenantId).catch(() => '');
  const scope = await db.scopeForFolder(tenantId, doc.folder || '', sharedId);
  await upsertDocumentChunks(tenantId, doc.id, points, scope);
  await db.setDocumentScope(doc.id, scope);
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
        // The folder the file actually sits in, which is what the scope is
        // derived from. Omitting it did not merely skip the field: upsert
        // writes `folder = excluded.folder` on conflict, so every sync
        // overwrote the stored folder with '' and un-scoped the file. A
        // correctly-scoped document became readable by nobody the next time
        // anything triggered a sync, with nothing in its state to show why.
        folder: f.folderId || '',
      });
      // Re-index when the CONTENT changed or when the file MOVED. `changed`
      // only compares the content hash, so a file dragged from a member's
      // folder into Shared (or out of it) would keep its old scope for ever —
      // the permission changed even though not a byte did.
      const prev = await db.getDocumentByFile(tenantId, providerKey, f.id);
      const moved = !!prev && (prev.folder || '') !== (f.folderId || '');
      if (changed || moved) { await db.enqueue(tenantId, providerKey, f.id); queued++; }
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
    // The folder ID, not its name. scopeForFolder() matches on the Drive folder
    // id; a human-readable name here matched nothing, so every uploaded file
    // came out unscoped.
    folder: file.folderId || '',
  });
  await db.enqueue(tenantId, providerKey, file.id);
  drainQueue().catch(() => {});
  return { id, title: file.name, link: file.link };
}
