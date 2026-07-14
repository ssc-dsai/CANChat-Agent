import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../shared/types';
import { MEMORY_REPO_NAME, type MemoryNode } from '../shared/memoryGraph';

const embedChunks = vi.fn();
const embedderId = vi.fn();
vi.mock('./llmProvider', () => ({
  embedChunks: (...a: unknown[]) => embedChunks(...a),
  embedderId: (...a: unknown[]) => embedderId(...a),
}));

const repoAdd = vi.fn();
const repoDelete = vi.fn();
const repoDeleteDoc = vi.fn();
const repoSearch = vi.fn();
vi.mock('./offscreenClient', () => ({
  repoAdd: (...a: unknown[]) => repoAdd(...a),
  repoDelete: (...a: unknown[]) => repoDelete(...a),
  repoDeleteDoc: (...a: unknown[]) => repoDeleteDoc(...a),
  repoSearch: (...a: unknown[]) => repoSearch(...a),
}));

import { memoryIndexRemove, memoryIndexSearch, memoryIndexUpsert, rebuildMemoryIndex } from './memoryIndex';

const settings: Settings = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt' };

function node(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'n1',
    kind: 'fact',
    label: 'Scott role',
    summary: 'Scott is a data scientist.',
    confidence: 0.9,
    durability: 0.7,
    status: 'active',
    createdAt: 't',
    updatedAt: 't',
    lastConfirmedAt: 't',
    provenance: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  embedChunks.mockReset();
  embedderId.mockReset();
  repoAdd.mockReset();
  repoDelete.mockReset();
  repoDeleteDoc.mockReset();
  repoSearch.mockReset();
});

describe('memoryIndexUpsert', () => {
  it('embeds label:summary text and upserts each node by delete-then-add with its own id', async () => {
    embedChunks.mockResolvedValue([[1, 2, 3]]);
    embedderId.mockReturnValue('local:minilm');
    repoDeleteDoc.mockResolvedValue({ ok: true });
    repoAdd.mockResolvedValue({ ok: true });

    await memoryIndexUpsert(settings, [node()]);

    expect(embedChunks).toHaveBeenCalledWith(settings, ['Scott role: Scott is a data scientist.']);
    expect(repoDeleteDoc).toHaveBeenCalledWith(MEMORY_REPO_NAME, 'n1');
    expect(repoAdd).toHaveBeenCalledWith(
      MEMORY_REPO_NAME,
      { name: 'Scott role', url: 'memory:n1' },
      ['Scott role: Scott is a data scientist.'],
      [[1, 2, 3]],
      { embedModel: 'local:minilm', kind: 'memory', docId: 'n1' },
    );
  });

  it('is a no-op for an empty node list', async () => {
    await memoryIndexUpsert(settings, []);
    expect(embedChunks).not.toHaveBeenCalled();
    expect(repoAdd).not.toHaveBeenCalled();
  });

  it('propagates a repo model-lock mismatch so the caller can rebuild', async () => {
    embedChunks.mockResolvedValue([[1]]);
    embedderId.mockReturnValue('external:te3');
    repoDeleteDoc.mockResolvedValue({ ok: true });
    repoAdd.mockRejectedValue(new Error('built with embedder "local:minilm" but this add uses "external:te3"'));
    await expect(memoryIndexUpsert(settings, [node()])).rejects.toThrow(/built with embedder/);
  });
});

describe('memoryIndexRemove', () => {
  it('deletes each node id from the repo', async () => {
    repoDeleteDoc.mockResolvedValue({ ok: true });
    await memoryIndexRemove(['a', 'b']);
    expect(repoDeleteDoc).toHaveBeenNthCalledWith(1, MEMORY_REPO_NAME, 'a');
    expect(repoDeleteDoc).toHaveBeenNthCalledWith(2, MEMORY_REPO_NAME, 'b');
  });
});

describe('memoryIndexSearch', () => {
  it('recovers node ids from memory: URLs in the search results', async () => {
    embedChunks.mockResolvedValue([[1, 2, 3]]);
    embedderId.mockReturnValue('local:minilm');
    repoSearch.mockResolvedValue({
      ok: true,
      result: [
        { url: 'memory:n1', score: 0.9, text: 't', name: 'Scott role' },
        { url: 'memory:n2', score: 0.4, text: 't', name: 'Other' },
      ],
    });
    const hits = await memoryIndexSearch(settings, 'what does Scott do', 5);
    expect(hits).toEqual([{ nodeId: 'n1', score: 0.9 }, { nodeId: 'n2', score: 0.4 }]);
  });

  it('returns null (degrade, not throw) when the repo search fails', async () => {
    embedChunks.mockResolvedValue([[1]]);
    embedderId.mockReturnValue('local:minilm');
    repoSearch.mockResolvedValue({ ok: false, error: 'boom' });
    expect(await memoryIndexSearch(settings, 'q', 5)).toBeNull();
  });

  it('returns null when embedding itself throws', async () => {
    embedChunks.mockRejectedValue(new Error('offscreen unavailable'));
    expect(await memoryIndexSearch(settings, 'q', 5)).toBeNull();
  });

  it('filters out any hit whose url is not a memory: url', async () => {
    embedChunks.mockResolvedValue([[1]]);
    embedderId.mockReturnValue('local:minilm');
    repoSearch.mockResolvedValue({ ok: true, result: [{ url: 'https://example.com/x', score: 0.5 }] });
    expect(await memoryIndexSearch(settings, 'q', 5)).toEqual([]);
  });
});

describe('rebuildMemoryIndex', () => {
  it('deletes the repo then re-upserts every node', async () => {
    repoDelete.mockResolvedValue({ ok: true });
    embedChunks.mockResolvedValue([[1]]);
    embedderId.mockReturnValue('local:minilm');
    repoDeleteDoc.mockResolvedValue({ ok: true });
    repoAdd.mockResolvedValue({ ok: true });

    await rebuildMemoryIndex(settings, [node()]);

    expect(repoDelete).toHaveBeenCalledWith(MEMORY_REPO_NAME);
    expect(repoAdd).toHaveBeenCalledTimes(1);
  });

  it('deletes the repo and does nothing else for an empty graph', async () => {
    repoDelete.mockResolvedValue({ ok: true });
    await rebuildMemoryIndex(settings, []);
    expect(repoDelete).toHaveBeenCalledWith(MEMORY_REPO_NAME);
    expect(embedChunks).not.toHaveBeenCalled();
    expect(repoAdd).not.toHaveBeenCalled();
  });
});
