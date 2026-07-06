import { describe, expect, it } from 'vitest';
import {
  capabilityBookmarkCandidates,
  dedupeBookmarkCandidates,
  filterBookmarkMentions,
  flattenBookmarkTree,
} from './bookmarkMentions';

describe('bookmark mention helpers', () => {
  it('flattens all bookmark tree URLs with folder context', () => {
    const items = flattenBookmarkTree([
      { title: 'root', children: [
        { title: 'SSC-SPC', children: [{ title: 'Portal', url: 'https://ssc.example/portal' }] },
        { title: 'Personal', children: [{ title: 'Recipes', url: 'https://food.example/' }] },
      ] },
    ]);
    expect(items.map((i) => i.url)).toEqual(['https://ssc.example/portal', 'https://food.example/']);
    expect(items[1].folder).toContain('Personal');
  });

  it('matches query text against folder path', () => {
    const items = filterBookmarkMentions(
      flattenBookmarkTree([{ title: 'root', children: [{ title: 'Travel', children: [{ title: 'Flights', url: 'https://air.example/' }] }] }]),
      'travel',
    );
    expect(items).toHaveLength(1);
    expect(items[0].insert).toBe('https://air.example/');
  });

  it('matches saved bookmark descriptions and tags', () => {
    const candidates = capabilityBookmarkCandidates([
      {
        id: 'c1',
        kind: 'bookmark',
        name: 'Internal Portal',
        description: 'Phoenix pay guidance and HR forms',
        url: 'https://internal.example/',
        tags: ['hr'],
        source: 'manual',
      },
    ], []);
    expect(filterBookmarkMentions(candidates, 'phoenix')[0].insert).toBe('https://internal.example/');
    expect(filterBookmarkMentions(candidates, 'hr')[0].insert).toBe('https://internal.example/');
  });

  it('dedupes by URL while preserving description context', () => {
    const deduped = dedupeBookmarkCandidates([
      { title: 'A', url: 'https://same.example/', order: 5 },
      { title: 'B', url: 'https://same.example/', description: 'important docs', order: 9 },
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].description).toBe('important docs');
    expect(deduped[0].order).toBe(5);
  });

  it('ranks title prefix matches before URL matches', () => {
    const items = filterBookmarkMentions([
      { title: 'Other', url: 'https://alpha.example/', order: 0 },
      { title: 'Alpha Guide', url: 'https://z.example/', order: 1 },
    ], 'alpha');
    expect(items.map((i) => i.primary)).toEqual(['Alpha Guide', 'Other']);
  });
});
