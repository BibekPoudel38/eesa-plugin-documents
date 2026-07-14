// Local embeddings via FastEmbed (ONNX, on-box, no API key, $0). BGE-small-en-v1.5
// is 384-dim — light enough to run inside the plugin container on Coolify. The
// model downloads once on first use and is cached to disk.
import { FlagEmbedding, EmbeddingModel } from 'fastembed';

export const EMBED_DIM = 384; // BAAI/bge-small-en-v1.5

let _model = null;
async function model() {
  if (!_model) {
    _model = await FlagEmbedding.init({
      model: EmbeddingModel.BGESmallENV15,
      maxLength: 512,
    });
  }
  return _model;
}

// Warm the model at boot so the first request isn't slow. Best-effort.
export async function warm() {
  try { await model(); } catch (e) { console.warn('embed warm failed:', e.message); }
}

// Embed passages (documents). Uses passageEmbed so BGE gets the retrieval prefix.
export async function embedPassages(texts) {
  if (!texts || !texts.length) return [];
  const m = await model();
  const out = [];
  for await (const batch of m.passageEmbed(texts, 32)) {
    for (const v of batch) out.push(Array.from(v));
  }
  return out;
}

// Embed a single query with the matching query prefix.
export async function embedQuery(text) {
  const m = await model();
  const v = await m.queryEmbed(String(text || ''));
  return Array.from(v);
}
