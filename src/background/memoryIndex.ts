// =============================================================================
// Embedding index for graph memory — a thin wrapper over the existing OPFS
// repo store (`offscreenClient.ts`), reusing its hybrid BM25+vector search
// rather than building a parallel index. One `MemoryNode` is one repo "doc"
// (and one chunk): its embeddable text is `label: summary`, and its `url` is
// `memory:<nodeId>` so a search hit maps straight back to the node id. The
// graph itself (`storage.ts` / `ba_memory_graph`) remains the source of
// truth — this index exists only to retrieve, never to store memory content.
// =============================================================================

import { embedChunks, embedderId } from './llmProvider';
import { repoAdd, repoDelete, repoDeleteDoc, repoSearch } from './offscreenClient';
import { MEMORY_REPO_NAME, memoryNodeChunkText, memoryNodeUrl, nodeIdFromMemoryUrl, type MemoryNode } from '../shared/memoryGraph';
import type { Settings } from '../shared/types';

/**
 * Upsert one or more nodes into the memory index (delete-then-add by node id,
 * so re-embedding a node replaces its old vector). Throws if the index was
 * built with a different embedder than `settings` currently uses (the repo
 * store's model lock) — callers should catch that and call
 * `rebuildMemoryIndex(settings, allNodes)` with the full graph, then retry.
 */
export async function memoryIndexUpsert(settings: Settings, nodes: MemoryNode[]): Promise<void> {
  if (nodes.length === 0) return;
  const vectors = await embedChunks(settings, nodes.map(memoryNodeChunkText));
  const embedModel = embedderId(settings);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    await repoDeleteDoc(MEMORY_REPO_NAME, node.id); // no-op if not present yet
    await repoAdd(
      MEMORY_REPO_NAME,
      { name: node.label, url: memoryNodeUrl(node.id) },
      [memoryNodeChunkText(node)],
      [vectors[i]],
      { embedModel, kind: 'memory', docId: node.id },
    );
  }
}

/** Remove nodes from the memory index by id (e.g. on delete_memory or a supersede). */
export async function memoryIndexRemove(nodeIds: string[]): Promise<void> {
  for (const id of nodeIds) await repoDeleteDoc(MEMORY_REPO_NAME, id);
}

export interface MemoryIndexHit {
  nodeId: string;
  score: number;
}

/**
 * Hybrid-search the memory index for nodes relevant to `queryText`. Returns
 * null (rather than throwing) when the index is unavailable or built with a
 * different embedder than `settings` — callers degrade to a durability-sorted
 * fallback over the graph itself rather than surfacing an error mid-turn.
 */
export async function memoryIndexSearch(settings: Settings, queryText: string, k: number): Promise<MemoryIndexHit[] | null> {
  try {
    const [queryVector] = await embedChunks(settings, [queryText]);
    const res = await repoSearch(MEMORY_REPO_NAME, queryVector, k, embedderId(settings), { query: queryText, hybrid: true });
    if (!res.ok || !Array.isArray(res.result)) return null;
    const hits = res.result as Array<{ url: string; score: number }>;
    return hits
      .map((h) => ({ nodeId: nodeIdFromMemoryUrl(h.url), score: h.score }))
      .filter((h): h is MemoryIndexHit => h.nodeId !== null);
  } catch {
    return null;
  }
}

/**
 * Rebuild the whole memory index from the graph (source of truth) — used when
 * the embed-model lock trips (the user switched embedders) or the index is
 * otherwise out of sync. Cheap: node summaries are small and few.
 */
export async function rebuildMemoryIndex(settings: Settings, nodes: MemoryNode[]): Promise<void> {
  await repoDelete(MEMORY_REPO_NAME);
  if (nodes.length === 0) return;
  await memoryIndexUpsert(settings, nodes);
}
