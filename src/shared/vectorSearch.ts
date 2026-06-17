// Portable similarity-search math for the on-device RAG store. Pure functions,
// no chrome.* / OPFS / DOM — so both the extension's offscreen repo store
// (src/offscreen/repoStore.ts) and the Word add-in (word-addin/) share one
// implementation of how query vectors are normalized, quantized, and scored
// against the stored int8 vectors.

export const QUANT = 127;

export interface SearchHit {
  text: string;
  name: string;
  url: string;
  score: number;
}

/** L2-normalize a vector (zero vectors are left as-is via the `|| 1` guard). */
export function normalizeVector(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** Quantize a (normalized) vector to int8 using the repo's per-dimension scale. */
export function quantizeVector(v: number[], scale: number[]): Int8Array {
  const out = new Int8Array(v.length);
  for (let d = 0; d < v.length; d++) {
    const s = scale[d] || 1;
    out[d] = Math.max(-QUANT, Math.min(QUANT, Math.round((v[d] / s) * QUANT)));
  }
  return out;
}

export interface SearchParams {
  dim: number;
  perDimScale: number[];
  chunkCount: number;
  /** Packed int8 vectors: chunkCount × dim, row i at [i*dim, (i+1)*dim). */
  vectors: Int8Array;
  /** Chunk records aligned to the vector rows. */
  chunks: Array<{ name: string; url: string; text: string }>;
  queryVector: number[];
  k: number;
}

/**
 * Return the top-`k` chunks most similar to `queryVector`. Dot-product over the
 * int8 vectors, with the query-constant factors (the quantized query and the
 * per-dim scale²) folded into one weight vector so the hot loop is a single
 * multiply-add — identical to the extension's original repoSearch.
 */
export function searchVectors(params: SearchParams): SearchHit[] {
  const { dim, perDimScale, chunkCount, vectors, chunks, queryVector, k } = params;
  if (chunkCount === 0) return [];
  if (queryVector.length !== dim) {
    throw new Error(`Query embedding dimension ${queryVector.length} does not match repo dimension ${dim}.`);
  }
  const q = quantizeVector(normalizeVector(queryVector), perDimScale);
  const qw = new Float32Array(dim);
  for (let d = 0; d < dim; d++) qw[d] = q[d] * perDimScale[d] * perDimScale[d];

  const top: Array<{ i: number; score: number }> = [];
  for (let i = 0; i < chunkCount; i++) {
    const base = i * dim;
    let score = 0;
    for (let d = 0; d < dim; d++) score += vectors[base + d] * qw[d];
    if (top.length < k) {
      top.push({ i, score });
      if (top.length === k) top.sort((a, b) => a.score - b.score);
    } else if (score > top[0].score) {
      top[0] = { i, score };
      top.sort((a, b) => a.score - b.score);
    }
  }
  top.sort((a, b) => b.score - a.score);
  return top
    .map(({ i, score }) => {
      const c = chunks[i];
      return c ? { text: c.text, name: c.name, url: c.url, score } : null;
    })
    .filter((r): r is SearchHit => r !== null);
}
