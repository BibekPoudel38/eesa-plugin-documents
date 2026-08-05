// Local embeddings via FastEmbed (ONNX, on-box, no API key, $0).
//
// The model MATCHES the platform's workflow and memory indexes, which default
// to BAAI/bge-base-en-v1.5 (768-dim) via QdrantSettings.embedding_model. Using
// a different model here would not corrupt anything (this plugin writes its own
// collections), but it would mean two embedding models loaded on the same box
// and search behaving differently from the rest of Eesa for no good reason.
//
// If an operator rotates the platform's model, set EMBED_MODEL here to match.
// Changing it invalidates existing collections: Qdrant is dimension-locked, so
// ensureCollection() checks and refuses rather than writing mismatched vectors.
import { FlagEmbedding, EmbeddingModel } from 'fastembed';

// FastEmbed's own identifiers, keyed by the platform's HuggingFace-style name
// so .env can carry the same string the platform's settings row does.
const MODELS = {
  'BAAI/bge-base-en-v1.5': EmbeddingModel.BGEBaseENV15,
  'BAAI/bge-small-en-v1.5': EmbeddingModel.BGESmallENV15,
  'sentence-transformers/all-MiniLM-L6-v2': EmbeddingModel.AllMiniLML6V2,
  'intfloat/multilingual-e5-large': EmbeddingModel.MLE5Large,
};

export const MODEL_NAME = process.env.EMBED_MODEL || 'BAAI/bge-base-en-v1.5';

function resolveModel() {
  const m = MODELS[MODEL_NAME];
  if (!m) {
    throw new Error(
      `EMBED_MODEL "${MODEL_NAME}" is not supported. Use one of: ${Object.keys(MODELS).join(', ')}`,
    );
  }
  return m;
}

let _model = null;
async function model() {
  if (!_model) {
    _model = await FlagEmbedding.init({ model: resolveModel(), maxLength: 512 });
  }
  return _model;
}

// Probed once by embedding a throwaway token, never hard-coded — the platform
// does the same, so switching models is a config change rather than a code
// change plus a constant somebody forgets to update.
let _dim = null;
export async function embedDim() {
  if (_dim == null) _dim = (await embedQuery('dimension probe')).length;
  return _dim;
}

// Warm the model at boot so the first request isn't slow. Best-effort.
export async function warm() {
  try {
    await model();
    console.log(`embeddings ready: ${MODEL_NAME} (${await embedDim()} dims)`);
  } catch (e) {
    console.warn('embed warm failed:', e.message);
  }
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
