import { describe, expect, it } from 'vitest';
import {
  applyDecay,
  effectiveConfidence,
  emptyMemoryGraph,
  filterByMinConfidence,
  MEMORY_EDGE_CAP,
  MEMORY_NODE_CAP,
  MEMORY_STALE_THRESHOLD,
  memoryNodeChunkText,
  memoryNodeUrl,
  mergeNodes,
  migrateFlatEntries,
  nodeIdFromMemoryUrl,
  nodeSimilarity,
  parseReflection,
  parseSupersedeVerdict,
  pruneGraph,
  rankCoreMemoryNodes,
  renderCoreMemoryBlock,
  renderRelevantMemoryBlock,
  shouldAdjudicate,
  visibleToProject,
  type MemoryEdge,
  type MemoryGraph,
  type MemoryNode,
} from './memoryGraph';
import type { MemoryEntry } from './types';

function node(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: 'n1',
    kind: 'fact',
    label: 'Test node',
    summary: 'A test node summary.',
    confidence: 0.9,
    durability: 0.7,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastConfirmedAt: '2026-01-01T00:00:00.000Z',
    provenance: [],
    ...overrides,
  };
}

function edge(overrides: Partial<MemoryEdge> = {}): MemoryEdge {
  return {
    id: 'e1',
    from: 'n1',
    to: 'n2',
    relation: 'relates_to',
    confidence: 0.8,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastConfirmedAt: '2026-01-01T00:00:00.000Z',
    provenance: [],
    ...overrides,
  };
}

describe('parseReflection', () => {
  it('parses a well-formed memories array', () => {
    const raw = JSON.stringify({
      memories: [
        {
          kind: 'preference',
          subject: 'Scott',
          label: 'Prefers terse commits',
          summary: 'Scott wants commit messages under two sentences.',
          relations: [{ to: 'Git workflow', relation: 'applies_to' }],
          confidence: 0.85,
          durability: 0.9,
          evidence: 'stop summarizing what you just did',
        },
      ],
    });
    const out = parseReflection(raw);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('Prefers terse commits');
    expect(out[0].kind).toBe('preference');
    expect(out[0].relations).toEqual([{ to: 'Git workflow', relation: 'applies_to' }]);
    expect(out[0].confidence).toBe(0.85);
  });

  it('strips a markdown code fence', () => {
    const raw = '```json\n{"memories":[{"label":"L","summary":"S"}]}\n```';
    expect(parseReflection(raw)).toHaveLength(1);
  });

  it('returns [] for empty, malformed, or non-object input', () => {
    expect(parseReflection('')).toEqual([]);
    expect(parseReflection('not json')).toEqual([]);
    expect(parseReflection('[]')).toEqual([]);
    expect(parseReflection('{"memories":"nope"}')).toEqual([]);
  });

  it('drops candidates missing a label or summary', () => {
    const raw = JSON.stringify({ memories: [{ label: 'Only label' }, { summary: 'Only summary' }] });
    expect(parseReflection(raw)).toEqual([]);
  });

  it('defaults kind to fact for an invalid kind, and clamps confidence/durability', () => {
    const raw = JSON.stringify({
      memories: [{ kind: 'bogus', label: 'L', summary: 'S', confidence: 5, durability: -2 }],
    });
    const out = parseReflection(raw);
    expect(out[0].kind).toBe('fact');
    expect(out[0].confidence).toBe(1);
    expect(out[0].durability).toBe(0);
  });

  it('caps evidence length and relation/candidate counts', () => {
    const longEvidence = 'x'.repeat(500);
    const manyRelations = Array.from({ length: 20 }, (_, i) => ({ to: `T${i}`, relation: 'r' }));
    const manyCandidates = Array.from({ length: 20 }, (_, i) => ({
      label: `L${i}`,
      summary: `S${i}`,
      evidence: longEvidence,
      relations: manyRelations,
    }));
    const out = parseReflection(JSON.stringify({ memories: manyCandidates }));
    expect(out.length).toBe(12);
    expect(out[0].evidence.length).toBe(200);
    expect(out[0].relations.length).toBe(8);
  });
});

describe('filterByMinConfidence', () => {
  const candidate = (confidence: number) => ({
    kind: 'fact' as const,
    subject: '',
    label: 'L',
    summary: 'S',
    relations: [],
    confidence,
    durability: 0.5,
    evidence: '',
  });

  it('keeps candidates at or above the threshold, drops those below', () => {
    const out = filterByMinConfidence([candidate(0.3), candidate(0.6), candidate(0.6001)], 0.6);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.confidence)).toEqual([0.6, 0.6001]);
  });

  it('a zero threshold keeps everything (default, unfiltered behavior)', () => {
    expect(filterByMinConfidence([candidate(0), candidate(1)], 0)).toHaveLength(2);
  });
});

describe('nodeSimilarity', () => {
  it('scores identical text as fully similar', () => {
    const a = { label: 'Scott role', summary: 'Scott is a data scientist' };
    expect(nodeSimilarity(a, a)).toBe(1);
  });

  it('scores unrelated text as zero', () => {
    expect(nodeSimilarity({ label: 'Foo bar', summary: 'unrelated text here' }, { label: 'Baz qux', summary: 'nothing shared' })).toBe(0);
  });
});

describe('mergeNodes', () => {
  it('unions provenance, takes max confidence/durability, prefers the longer summary', () => {
    const existing = node({ confidence: 0.6, durability: 0.5, summary: 'Short.', provenance: [{ conversationId: 'c1', excerpt: 'e1', at: 't1' }] });
    const incoming = { kind: 'fact' as const, subject: '', label: 'Test node', summary: 'A much longer, more specific summary.', relations: [], confidence: 0.8, durability: 0.9, evidence: '' };
    const prov = { conversationId: 'c2', excerpt: 'e2', at: 't2' };
    const merged = mergeNodes(existing, incoming, prov, '2026-02-01T00:00:00.000Z');
    expect(merged.confidence).toBe(0.8);
    expect(merged.durability).toBe(0.9);
    expect(merged.summary).toBe(incoming.summary);
    expect(merged.status).toBe('active');
    expect(merged.provenance).toEqual([existing.provenance[0], prov]);
    expect(merged.lastConfirmedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('carries an optional source citation through provenance', () => {
    const existing = node({ provenance: [] });
    const incoming = { kind: 'entity' as const, subject: 'Acme Corp', label: 'Acme Corp', summary: 'Acme Corp announced a merger.', relations: [], confidence: 0.7, durability: 0.6, evidence: '' };
    const prov = { conversationId: 'c1', excerpt: 'Acme Corp announced a merger.', at: 't1', sourceUrl: 'https://example.com/article', sourceTitle: 'Acme merges with Globex' };
    const merged = mergeNodes(existing, incoming, prov, 'now');
    expect(merged.provenance[0].sourceUrl).toBe('https://example.com/article');
    expect(merged.provenance[0].sourceTitle).toBe('Acme merges with Globex');
  });

  it('caps provenance at the last 10 entries', () => {
    const existing = node({ provenance: Array.from({ length: 10 }, (_, i) => ({ conversationId: `c${i}`, excerpt: 'e', at: 't' })) });
    const incoming = { kind: 'fact' as const, subject: '', label: 'x', summary: 'y', relations: [], confidence: 0.5, durability: 0.5, evidence: '' };
    const merged = mergeNodes(existing, incoming, { conversationId: 'new', excerpt: 'e', at: 't' }, 'now');
    expect(merged.provenance).toHaveLength(10);
    expect(merged.provenance[9].conversationId).toBe('new');
  });
});

describe('effectiveConfidence / applyDecay', () => {
  it('does not decay at day zero', () => {
    const n = node({ confidence: 0.9, durability: 0.8, lastConfirmedAt: '2026-01-01T00:00:00.000Z' });
    expect(effectiveConfidence(n, new Date('2026-01-01T00:00:00.000Z'))).toBeCloseTo(0.9, 5);
  });

  it('decays faster for low durability than high durability over the same interval', () => {
    const now = new Date('2026-04-01T00:00:00.000Z');
    const low = node({ confidence: 0.9, durability: 0.1, lastConfirmedAt: '2026-01-01T00:00:00.000Z' });
    const high = node({ confidence: 0.9, durability: 0.9, lastConfirmedAt: '2026-01-01T00:00:00.000Z' });
    expect(effectiveConfidence(low, now)).toBeLessThan(effectiveConfidence(high, now));
  });

  it('marks a long-unconfirmed low-durability node as stale, leaves a fresh high-durability node active', () => {
    const now = new Date('2027-01-01T00:00:00.000Z');
    const graph: MemoryGraph = {
      nodes: [
        node({ id: 'stale-me', confidence: 0.9, durability: 0.05, lastConfirmedAt: '2026-01-01T00:00:00.000Z' }),
        node({ id: 'stay-active', confidence: 0.9, durability: 0.9, lastConfirmedAt: '2026-12-30T00:00:00.000Z' }),
      ],
      edges: [],
      version: 1,
    };
    const out = applyDecay(graph, now);
    expect(out.nodes.find((n) => n.id === 'stale-me')?.status).toBe('stale');
    expect(out.nodes.find((n) => n.id === 'stay-active')?.status).toBe('active');
  });

  it('never touches superseded or already-stale records', () => {
    const graph: MemoryGraph = {
      nodes: [node({ id: 'superseded', status: 'superseded', confidence: 0.9, durability: 0.9 })],
      edges: [edge({ status: 'stale' })],
      version: 1,
    };
    const out = applyDecay(graph, new Date('2030-01-01T00:00:00.000Z'));
    expect(out.nodes[0].status).toBe('superseded');
    expect(out.edges[0].status).toBe('stale');
  });
});

describe('pruneGraph', () => {
  it('leaves a graph under the caps untouched', () => {
    const graph: MemoryGraph = { nodes: [node()], edges: [], version: 1 };
    expect(pruneGraph(graph)).toEqual(graph);
  });

  it('drops superseded nodes first when over the node cap', () => {
    const supersededCount = 5;
    const activeCount = MEMORY_NODE_CAP;
    const nodes: MemoryNode[] = [
      ...Array.from({ length: supersededCount }, (_, i) => node({ id: `sup${i}`, status: 'superseded', updatedAt: `2026-01-0${(i % 9) + 1}T00:00:00.000Z` })),
      ...Array.from({ length: activeCount }, (_, i) => node({ id: `act${i}`, durability: 0.9, lastConfirmedAt: '2026-06-01T00:00:00.000Z' })),
    ];
    const out = pruneGraph({ nodes, edges: [], version: 1 });
    expect(out.nodes.length).toBe(MEMORY_NODE_CAP);
    expect(out.nodes.some((n) => n.status === 'superseded')).toBe(false);
  });

  it('evicts lowest-durability, longest-unconfirmed active nodes when superseded alone is not enough', () => {
    const nodes: MemoryNode[] = Array.from({ length: MEMORY_NODE_CAP + 3 }, (_, i) =>
      node({ id: `n${i}`, durability: i === 0 ? 0.01 : 0.9, lastConfirmedAt: '2026-06-01T00:00:00.000Z' }),
    );
    const out = pruneGraph({ nodes, edges: [], version: 1 });
    expect(out.nodes.length).toBe(MEMORY_NODE_CAP);
    expect(out.nodes.some((n) => n.id === 'n0')).toBe(false);
  });

  it('drops edges whose endpoints no longer exist, and caps edge count', () => {
    const graph: MemoryGraph = {
      nodes: [node({ id: 'n1' })],
      edges: [edge({ id: 'e1', from: 'n1', to: 'ghost' })],
      version: 1,
    };
    expect(pruneGraph(graph).edges).toHaveLength(0);
  });

  it('caps edges at MEMORY_EDGE_CAP, keeping the most recently confirmed', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })];
    const edges = Array.from({ length: MEMORY_EDGE_CAP + 5 }, (_, i) =>
      edge({ id: `e${i}`, from: 'a', to: 'b', lastConfirmedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z` }),
    );
    const out = pruneGraph({ nodes, edges, version: 1 });
    expect(out.edges.length).toBe(MEMORY_EDGE_CAP);
  });
});

describe('renderCoreMemoryBlock', () => {
  it('reports an empty graph', () => {
    expect(renderCoreMemoryBlock(emptyMemoryGraph())).toContain('Memory is currently empty.');
  });

  it('ranks by durability × effective confidence and marks stale nodes', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const graph: MemoryGraph = {
      nodes: [
        node({ id: 'top', label: 'Top fact', summary: 'High durability, fresh.', durability: 0.9, confidence: 0.9, lastConfirmedAt: '2026-05-30T00:00:00.000Z' }),
        node({ id: 'low', label: 'Low fact', summary: 'Low durability, old.', durability: 0.05, confidence: 0.9, lastConfirmedAt: '2025-01-01T00:00:00.000Z', status: 'stale' }),
        node({ id: 'hidden', status: 'superseded' }),
      ],
      edges: [],
      version: 1,
    };
    const block = renderCoreMemoryBlock(graph, null, 15, now);
    expect(block).toContain('Top fact');
    expect(block.indexOf('Top fact')).toBeLessThan(block.indexOf('Low fact'));
    expect(block).toContain('Low fact — Low durability, old. (stale)');
    expect(block).not.toContain('hidden');
  });

  it('renders relationships between ranked nodes only', () => {
    const graph: MemoryGraph = {
      nodes: [node({ id: 'n1', label: 'Alice' }), node({ id: 'n2', label: 'Bob' })],
      edges: [edge({ from: 'n1', to: 'n2', relation: 'manages' })],
      version: 1,
    };
    const block = renderCoreMemoryBlock(graph);
    expect(block).toContain('Alice —manages→ Bob');
  });

  it('includes the memory-first answering guidance', () => {
    const block = renderCoreMemoryBlock(emptyMemoryGraph());
    expect(block).toContain('answer directly from them');
    expect(block).toContain('could plausibly be stale');
  });
});

describe('shouldAdjudicate', () => {
  it('is false for a near-identical match (reinforcement, not contradiction)', () => {
    const existing = { label: 'Scott role', summary: 'Scott is a data scientist' };
    expect(shouldAdjudicate(existing, existing)).toBe(false);
  });

  it('is true when a matched node has little text overlap (possible drift/contradiction)', () => {
    const existing = { label: 'Scott role', summary: 'Scott is a data scientist' };
    const candidate = { label: 'Scott job', summary: 'currently a product manager at Acme' };
    expect(shouldAdjudicate(existing, candidate)).toBe(true);
  });
});

describe('parseSupersedeVerdict', () => {
  it('parses a true verdict', () => {
    expect(parseSupersedeVerdict('{"supersedes": true}')).toBe(true);
  });

  it('fails closed (false) on false, malformed, or empty input', () => {
    expect(parseSupersedeVerdict('{"supersedes": false}')).toBe(false);
    expect(parseSupersedeVerdict('not json')).toBe(false);
    expect(parseSupersedeVerdict('')).toBe(false);
    expect(parseSupersedeVerdict('{}')).toBe(false);
  });

  it('strips a markdown code fence', () => {
    expect(parseSupersedeVerdict('```json\n{"supersedes": true}\n```')).toBe(true);
  });
});

describe('rankCoreMemoryNodes', () => {
  it('excludes superseded nodes and ranks by durability × effective confidence', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const graph: MemoryGraph = {
      nodes: [
        node({ id: 'top', durability: 0.9, confidence: 0.9, lastConfirmedAt: '2026-05-30T00:00:00.000Z' }),
        node({ id: 'low', durability: 0.1, confidence: 0.9, lastConfirmedAt: '2025-01-01T00:00:00.000Z' }),
        node({ id: 'hidden', status: 'superseded' }),
      ],
      edges: [],
      version: 1,
    };
    const ranked = rankCoreMemoryNodes(graph, null, 15, now);
    expect(ranked.map((n) => n.id)).toEqual(['top', 'low']);
  });

  it('respects the limit', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => node({ id: `n${i}` }));
    expect(rankCoreMemoryNodes({ nodes, edges: [], version: 1 }, null, 5).length).toBe(5);
  });

  it('excludes nodes scoped to a different project but keeps global and same-project ones', () => {
    const graph: MemoryGraph = {
      nodes: [
        node({ id: 'global', durability: 0.5 }),
        node({ id: 'proj-a', durability: 0.9, projectId: 'a' }),
        node({ id: 'proj-b', durability: 0.9, projectId: 'b' }),
      ],
      edges: [],
      version: 1,
    };
    expect(rankCoreMemoryNodes(graph, 'a').map((n) => n.id).sort()).toEqual(['global', 'proj-a']);
    expect(rankCoreMemoryNodes(graph, null).map((n) => n.id)).toEqual(['global']);
  });
});

describe('visibleToProject', () => {
  it('a global record (no projectId) is visible under any active project', () => {
    expect(visibleToProject(undefined, 'a')).toBe(true);
    expect(visibleToProject(undefined, null)).toBe(true);
  });

  it('a scoped record is visible only under its own project', () => {
    expect(visibleToProject('a', 'a')).toBe(true);
    expect(visibleToProject('a', 'b')).toBe(false);
    expect(visibleToProject('a', null)).toBe(false);
  });
});

describe('renderRelevantMemoryBlock', () => {
  it('returns an empty string for no nodes', () => {
    expect(renderRelevantMemoryBlock([])).toBe('');
  });

  it('renders each node with a stale marker where applicable', () => {
    const out = renderRelevantMemoryBlock([
      node({ id: 'a', label: 'A', summary: 'Fact A' }),
      node({ id: 'b', label: 'B', summary: 'Fact B', status: 'stale' }),
    ]);
    expect(out).toContain('[a] A — Fact A');
    expect(out).toContain('[b] B — Fact B (stale)');
    expect(out).toContain('Memories relevant to this message');
  });
});

describe('memory index url helpers', () => {
  it('builds and recovers a node id round-trip', () => {
    const url = memoryNodeUrl('abc123');
    expect(url).toBe('memory:abc123');
    expect(nodeIdFromMemoryUrl(url)).toBe('abc123');
  });

  it('returns null for a non-memory url', () => {
    expect(nodeIdFromMemoryUrl('https://example.com')).toBeNull();
  });

  it('builds the embeddable chunk text as label: summary', () => {
    expect(memoryNodeChunkText({ label: 'Scott role', summary: 'Data scientist.' })).toBe('Scott role: Data scientist.');
  });
});

describe('migrateFlatEntries', () => {
  it('converts each flat entry into a fact node with sensible defaults', () => {
    const entries: MemoryEntry[] = [
      { id: 'm1', text: 'Scott prefers terse commit messages without trailing summaries', createdAt: 'c1', updatedAt: 'u1' },
    ];
    const [n] = migrateFlatEntries(entries);
    expect(n.id).toBe('m1');
    expect(n.kind).toBe('fact');
    expect(n.summary).toBe(entries[0].text);
    expect(n.label.startsWith('Scott prefers terse commit messages')).toBe(true);
    expect(n.confidence).toBe(0.9);
    expect(n.durability).toBe(0.7);
    expect(n.status).toBe('active');
    expect(n.provenance).toEqual([]);
    expect(n.lastConfirmedAt).toBe('u1');
  });

  it('truncates a long first line into the label with an ellipsis', () => {
    const [n] = migrateFlatEntries([{ id: 'm1', text: 'one two three four five six seven eight', createdAt: 'c', updatedAt: 'u' }]);
    expect(n.label).toBe('one two three four five six…');
  });
});

describe('MEMORY_STALE_THRESHOLD sanity', () => {
  it('is between 0 and 1', () => {
    expect(MEMORY_STALE_THRESHOLD).toBeGreaterThan(0);
    expect(MEMORY_STALE_THRESHOLD).toBeLessThan(1);
  });
});
