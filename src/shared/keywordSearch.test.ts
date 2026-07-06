import { describe, expect, it } from 'vitest';
import { bm25Rank, bm25RankIndexed, buildKeywordIndex, extendKeywordIndex, tokenize } from './keywordSearch';

describe('tokenize', () => {
  it('lowercases and splits on whitespace/punctuation', () => {
    expect(tokenize('Hello, World!  Foo')).toEqual(['hello', 'world', 'foo']);
  });

  it('keeps identifiers with internal . _ - intact', () => {
    expect(tokenize('See AB-1234 and v2.3 plus foo_bar (CVE-2024-1234).')).toEqual([
      'see',
      'ab-1234',
      'and',
      'v2.3',
      'plus',
      'foo_bar',
      'cve-2024-1234',
    ]);
  });

  it('returns [] for empty / symbol-only text (tokens must start with a letter or digit)', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('--- !!! ___')).toEqual([]);
  });
});

describe('bm25Rank', () => {
  const chunks = [
    { text: 'The quarterly budget exceeded projected costs significantly.' },
    { text: 'Invoice AB-1234 was approved by finance last week.' },
    { text: 'A general note about meetings and scheduling.' },
  ];

  it('ranks the chunk containing an exact token first', () => {
    const hits = bm25Rank({ chunks, query: 'AB-1234' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].i).toBe(1);
  });

  it('only returns chunks that share a query term, sorted by score', () => {
    const hits = bm25Rank({ chunks, query: 'budget costs' });
    expect(hits.map((h) => h.i)).toEqual([0]); // only chunk 0 mentions budget/costs
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('returns [] when no term matches or query is empty', () => {
    expect(bm25Rank({ chunks, query: 'zzznonexistent' })).toEqual([]);
    expect(bm25Rank({ chunks, query: '   ' })).toEqual([]);
    expect(bm25Rank({ chunks: [], query: 'anything' })).toEqual([]);
  });

  it('rewards rarer terms more (IDF)', () => {
    const corpus = [
      { text: 'common common common rare' },
      { text: 'common common common' },
      { text: 'common common common' },
    ];
    // "rare" appears in 1 of 3 docs; "common" in all 3 → rare should drive ranking.
    const hits = bm25Rank({ chunks: corpus, query: 'rare common' });
    expect(hits[0].i).toBe(0);
  });

  it('matches the precomputed keyword index ranking', () => {
    const direct = bm25Rank({ chunks, query: 'budget costs invoice' });
    const indexed = bm25RankIndexed({ index: buildKeywordIndex(chunks), query: 'budget costs invoice' });
    expect(indexed).toEqual(direct);
  });

  it('extends a keyword index without changing rankings', () => {
    const extended = extendKeywordIndex(buildKeywordIndex(chunks.slice(0, 1)), chunks.slice(1));
    expect(bm25RankIndexed({ index: extended, query: 'budget costs invoice' })).toEqual(
      bm25Rank({ chunks, query: 'budget costs invoice' }),
    );
  });
});
