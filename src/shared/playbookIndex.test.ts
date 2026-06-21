import { describe, expect, it } from 'vitest';
import { parsePlaybookIndex, resolvePlaybookUrl } from './playbookIndex';

const BASE = 'https://raw.githubusercontent.com/ScottSyms/CANAgent/main/skills/index.json';

describe('resolvePlaybookUrl', () => {
  it('resolves a relative file against the index URL', () => {
    expect(resolvePlaybookUrl({ file: 'search-mail.md' }, BASE)).toBe(
      'https://raw.githubusercontent.com/ScottSyms/CANAgent/main/skills/search-mail.md',
    );
  });

  it('passes an absolute url through', () => {
    expect(resolvePlaybookUrl({ url: 'https://x.test/a/SKILL.md' }, BASE)).toBe(
      'https://x.test/a/SKILL.md',
    );
  });

  it('returns null when neither is usable', () => {
    expect(resolvePlaybookUrl({}, BASE)).toBeNull();
    expect(resolvePlaybookUrl({ url: 'ftp://x' }, BASE)).toBeNull();
  });
});

describe('parsePlaybookIndex', () => {
  it('parses a { playbooks: [...] } document and resolves files', () => {
    const json = JSON.stringify({
      playbooks: [
        { name: 'search-sharepoint', description: 'SP', file: 'search-sharepoint.md' },
        { name: 'x', description: 'X', url: 'https://x.test/x.md', origin: 'x.com' },
      ],
    });
    expect(parsePlaybookIndex(json, BASE)).toEqual([
      {
        name: 'search-sharepoint',
        description: 'SP',
        origin: undefined,
        url: 'https://raw.githubusercontent.com/ScottSyms/CANAgent/main/skills/search-sharepoint.md',
      },
      { name: 'x', description: 'X', origin: 'x.com', url: 'https://x.test/x.md' },
    ]);
  });

  it('accepts a bare array', () => {
    const json = JSON.stringify([{ name: 'a', file: 'a.md' }]);
    expect(parsePlaybookIndex(json, BASE)).toHaveLength(1);
  });

  it('skips entries with no name or no resolvable location, and dedupes by name', () => {
    const json = JSON.stringify({
      playbooks: [
        { description: 'no name', file: 'x.md' },
        { name: 'b' },
        { name: 'c', file: 'c.md' },
        { name: 'C', file: 'c2.md' },
      ],
    });
    const out = parsePlaybookIndex(json, BASE);
    expect(out.map((p) => p.name)).toEqual(['c']);
  });

  it('returns [] on malformed JSON or non-list shapes', () => {
    expect(parsePlaybookIndex('not json', BASE)).toEqual([]);
    expect(parsePlaybookIndex('{"nope":1}', BASE)).toEqual([]);
  });
});
