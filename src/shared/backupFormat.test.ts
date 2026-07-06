import { describe, expect, it } from 'vitest';
import { bytesFromBase64, parseBackup } from './backupFormat';
import { normalizeVector, quantizeVector, searchVectors } from './vectorSearch';

// Build the int8 vectors exactly as the extension stores them, then base64 them
// the way repoStore.u8ToB64 does, so the fixture matches a real backup.
function b64FromBytes(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

const dim = 2;
const perDimScale = [1, 1];
const raw = [
  [1, 0],
  [1, 1],
];
const packed = new Int8Array(raw.length * dim);
raw.forEach((v, i) => packed.set(quantizeVector(normalizeVector(v), perDimScale), i * dim));

const backup = {
  app: 'CANChat Agent',
  kind: 'backup',
  version: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  storage: {
    ba_settings: { baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm' },
    ba_skills: [{ id: 's1', name: 'research', description: 'research', body: '1. do it' }],
    ba_sites: [{ id: 'site1', name: 'Wiki', url: 'https://w', description: 'docs' }],
    ba_memory: [{ id: 'm1', text: 'likes metric', createdAt: '', updatedAt: '' }],
    ba_lessons: [{ id: 'l1', text: 'Use endpoint tools first.', triggers: ['mail'], uses: 1, createdAt: '', updatedAt: '' }],
  },
  repos: [
    {
      name: 'Research',
      meta: { name: 'Research', dim, bits: 8, perDimScale, docs: [], chunkCount: raw.length },
      chunks: [
        { name: 'A', url: 'http://a', text: 'alpha' },
        { name: 'C', url: 'http://c', text: 'gamma' },
      ],
      vectorsB64: b64FromBytes(new Uint8Array(packed.buffer)),
    },
  ],
};

describe('parseBackup', () => {
  it('extracts settings, skills, sites, memory, lessons, and repos', () => {
    const parsed = parseBackup(backup);
    expect(parsed.settings?.model).toBe('m');
    expect(parsed.skills.map((s) => s.name)).toEqual(['research']);
    expect(parsed.sites).toHaveLength(1);
    expect(parsed.memory).toHaveLength(1);
    expect(parsed.lessons.map((l) => l.text)).toEqual(['Use endpoint tools first.']);
    expect(parsed.repos).toHaveLength(1);
  });

  it('decodes repo vectors so similarity search works end-to-end', () => {
    const { repos } = parseBackup(backup);
    const repo = repos[0];
    expect(repo.vectors).toBeInstanceOf(Int8Array);
    expect(repo.vectors.length).toBe(raw.length * dim);
    const hits = searchVectors({
      dim: repo.meta.dim,
      perDimScale: repo.meta.perDimScale,
      chunkCount: repo.meta.chunkCount,
      vectors: repo.vectors,
      chunks: repo.chunks,
      queryVector: [1, 0],
      k: 1,
    });
    expect(hits[0].name).toBe('A');
    expect(hits[0].text).toBe('alpha');
  });

  it('rejects files that are not a CANChat Agent backup', () => {
    expect(() => parseBackup({ app: 'Something', kind: 'backup' })).toThrow(/backup/i);
    expect(() => parseBackup({ app: 'CANChat Agent', kind: 'other' })).toThrow(/backup/i);
    expect(() => parseBackup(null)).toThrow();
  });

  it('round-trips base64 bytes', () => {
    expect(Array.from(bytesFromBase64(b64FromBytes(new Uint8Array([0, 1, 254, 255]))))).toEqual([0, 1, 254, 255]);
  });
});
