// Lexical (keyword) ranking for the on-device RAG store — the BM25 half of
// hybrid search. Pure functions, no chrome.* / OPFS / DOM, mirroring
// vectorSearch.ts so the offscreen repo store and the Word add-in can share it.
//
// Semantic (dense vector) search excels at meaning but can miss exact tokens —
// part numbers, identifiers, surnames, codes. BM25 over the same chunk text
// recovers that exact-token recall; the two rankings are then fused (RRF) in
// hybridSearch.ts.

/**
 * Tokenize for lexical matching. Lowercased, and crucially **keeps identifiers
 * intact**: internal `.`/`_`/`-` are preserved so `AB-1234`, `v2.3`,
 * `CVE-2024-1234`, `foo_bar` stay single tokens (the whole point of adding a
 * keyword layer is exact-token lookup). Leading/trailing punctuation is dropped.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
}

export interface KeywordHit {
  i: number;
  score: number;
}

export interface Bm25Params {
  /** Chunk records aligned to the vector rows (only `text` is read). */
  chunks: Array<{ text: string }>;
  query: string;
  /** Term-frequency saturation. Default 1.5 (standard). */
  k1?: number;
  /** Length-normalization strength, 0..1. Default 0.75 (standard). */
  b?: number;
}

/**
 * Rank chunks by BM25 against the query. Returns only chunks with a non-zero
 * score (i.e. that share at least one query term), sorted by score descending.
 * IDF and average document length are computed across the supplied chunks at
 * query time — no persisted inverted index, which keeps the stored repo format
 * unchanged and is sub-millisecond for the corpus sizes here (hundreds–thousands
 * of chunks).
 */
export function bm25Rank(params: Bm25Params): KeywordHit[] {
  const { chunks, query } = params;
  const k1 = params.k1 ?? 1.5;
  const b = params.b ?? 0.75;
  const N = chunks.length;
  if (N === 0) return [];
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0) return [];

  // Per-chunk term frequencies + lengths (single tokenize pass over the corpus).
  const termFreqs: Array<Map<string, number>> = new Array(N);
  const docLen = new Array<number>(N);
  let totalLen = 0;
  for (let i = 0; i < N; i++) {
    const toks = tokenize(chunks[i].text);
    docLen[i] = toks.length;
    totalLen += toks.length;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    termFreqs[i] = tf;
  }
  const avgdl = totalLen / N || 1;

  // Document frequency + IDF per query term.
  const idf = new Map<string, number>();
  for (const term of qTerms) {
    let df = 0;
    for (let i = 0; i < N; i++) if (termFreqs[i].has(term)) df++;
    // BM25 idf with the +1 inside log to keep it non-negative for common terms.
    idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }

  const hits: KeywordHit[] = [];
  for (let i = 0; i < N; i++) {
    const tf = termFreqs[i];
    let score = 0;
    const norm = k1 * (1 - b + b * (docLen[i] / avgdl));
    for (const term of qTerms) {
      const f = tf.get(term);
      if (!f) continue;
      score += (idf.get(term) as number) * ((f * (k1 + 1)) / (f + norm));
    }
    if (score > 0) hits.push({ i, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}
