/**
 * Local, dependency-free text vectorizer for hybrid retrieval.
 *
 * Design goal: semantic-ish similarity for short, informal, Spanish-heavy
 * chat messages WITHOUT downloading embedding models or native deps.
 * Technique: feature hashing ("hashing trick") over word unigrams + character
 * trigrams, L2-normalized. Character n-grams make it robust to typos, slang
 * and missing accents ("q onda" ~ "que onda"); word features keep topical
 * signal. 256 dims * float32 = 1KB per message — 100k messages ≈ 100MB max,
 * and in practice far less because we only index text messages.
 */

export const VECTOR_DIM = 256;

/** FNV-1a 32-bit — tiny, fast, good enough dispersion for feature hashing. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // strip accents: "qué" -> "que"
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function features(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const words = normalized.split(" ");
  const feats: string[] = [];
  for (const w of words) {
    feats.push(`w:${w}`);
    const padded = `_${w}_`;
    for (let i = 0; i <= padded.length - 3; i++) {
      feats.push(`c:${padded.slice(i, i + 3)}`);
    }
  }
  return feats;
}

/** Hash features into a fixed-size L2-normalized Float32 vector. */
export function vectorize(text: string): Float32Array {
  const vec = new Float32Array(VECTOR_DIM);
  const feats = features(text);
  if (feats.length === 0) return vec;
  for (const f of feats) {
    const h = fnv1a(f);
    const idx = h % VECTOR_DIM;
    // Second hash bit decides sign — the classic trick to keep E[dot]=0 for
    // unrelated texts and reduce hash-collision bias.
    const sign = (h & 0x80000000) !== 0 ? -1 : 1;
    // Words weigh more than char trigrams (topical > lexical).
    vec[idx]! += sign * (f.startsWith("w:") ? 2 : 1);
  }
  let norm = 0;
  for (let i = 0; i < VECTOR_DIM; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i++) vec[i]! /= norm;
  }
  return vec;
}

/** Cosine similarity of two L2-normalized vectors = dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < VECTOR_DIM; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function fromBlob(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}
