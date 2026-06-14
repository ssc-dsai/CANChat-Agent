import { describe, expect, it } from 'vitest';
import { chunkText, normalizeUrl } from './repoChunk';

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual(['hello world']);
  });
  it('returns no chunks for empty/whitespace input', () => {
    expect(chunkText('   \n\t ')).toEqual([]);
  });
  it('collapses runs of spaces/tabs', () => {
    expect(chunkText('a\t\t  b')).toEqual(['a b']);
  });
  it('splits long text into multiple overlapping chunks', () => {
    const text = 'sentence. '.repeat(300); // ~3000 chars, > CHUNK_CHARS
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk exceeds the chunk size by much (boundary-aware cut <= 800).
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(800);
  });
  it('produces overlapping content between consecutive chunks', () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(text);
    if (chunks.length >= 2) {
      const tail = chunks[0].slice(-40);
      // Some of the first chunk's tail words reappear at the start of the next.
      expect(chunks[1].includes(tail.split(' ').slice(-1)[0])).toBe(true);
    }
  });
});

describe('normalizeUrl', () => {
  it('drops query and hash', () => {
    expect(normalizeUrl('https://example.com/page?a=1&b=2#frag')).toBe('https://example.com/page');
  });
  it('lowercases the host but not the path', () => {
    expect(normalizeUrl('https://Example.COM/Path')).toBe('https://example.com/Path');
  });
  it('strips a trailing slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });
  it('treats query-only differences as the same canonical URL', () => {
    expect(normalizeUrl('https://x.com/a?ref=1')).toBe(normalizeUrl('https://x.com/a?ref=2'));
  });
  it('falls back to a trimmed string for non-URL input', () => {
    expect(normalizeUrl('  not a url  ')).toBe('not a url');
  });
});
