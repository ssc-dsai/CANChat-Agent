import { describe, expect, it } from 'vitest';
import { deriveTitle, derivePreview, pruneIndex } from './conversationMeta';
import type { ConversationSummary } from './types';

describe('deriveTitle', () => {
  it('collapses whitespace to a single line', () => {
    expect(deriveTitle('  summarize\n  this   page ')).toBe('summarize this page');
  });

  it('clips long text with an ellipsis at the 60-char budget', () => {
    const title = deriveTitle('a'.repeat(100));
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBe(60);
  });

  it('returns empty string for blank input (caller localizes the fallback)', () => {
    expect(deriveTitle('   \n  ')).toBe('');
  });
});

describe('derivePreview', () => {
  it('clips at the 120-char budget', () => {
    const preview = derivePreview('x'.repeat(200));
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBe(120);
  });
});

describe('pruneIndex', () => {
  const make = (id: string, updatedAt: string): ConversationSummary => ({
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    preview: '',
  });

  it('returns everything sorted newest-first when under the cap', () => {
    const index = [make('a', '2026-01-01T00:00:00Z'), make('b', '2026-02-01T00:00:00Z')];
    const { kept, evicted } = pruneIndex(index, 10);
    expect(kept.map((c) => c.id)).toEqual(['b', 'a']);
    expect(evicted).toEqual([]);
  });

  it('evicts the oldest entries beyond the cap', () => {
    const index = [
      make('old', '2026-01-01T00:00:00Z'),
      make('mid', '2026-02-01T00:00:00Z'),
      make('new', '2026-03-01T00:00:00Z'),
    ];
    const { kept, evicted } = pruneIndex(index, 2);
    expect(kept.map((c) => c.id)).toEqual(['new', 'mid']);
    expect(evicted).toEqual(['old']);
  });

  it('does not mutate the input array', () => {
    const index = [make('a', '2026-01-01T00:00:00Z'), make('b', '2026-02-01T00:00:00Z')];
    const snapshot = index.map((c) => c.id);
    pruneIndex(index, 1);
    expect(index.map((c) => c.id)).toEqual(snapshot);
  });
});
