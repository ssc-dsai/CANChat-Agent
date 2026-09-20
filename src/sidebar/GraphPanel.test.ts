import { describe, expect, it } from 'vitest';
import type { DocGraph, GraphEdge, GraphNode } from '../shared/docGraph';
import { layout } from './GraphPanel';

function node(id: string): GraphNode {
  return { id, type: 'entity', label: id, aliases: [], summary: '', evidenceSentenceIds: [], docIds: [] };
}
function edge(from: string, to: string): GraphEdge {
  return { id: `${from}-${to}`, from, to, relation: 'related', evidenceSentenceIds: [] };
}

// A hub connected to several leaves, a separate tightly-connected pair, and one
// fully isolated node — enough structural variety that a layout ignoring the
// graph's actual shape (e.g. the old "every node at a fixed angle on a circle"
// bug) would be distinguishable from one that responds to it.
function buildGraph(): DocGraph {
  const leaves = ['leaf1', 'leaf2', 'leaf3', 'leaf4'];
  const nodes = [node('hub'), ...leaves.map(node), node('pairA'), node('pairB'), node('isolated')];
  const edges = [...leaves.map((l) => edge('hub', l)), edge('pairA', 'pairB')];
  return { nodes, edges, version: 3, processedDocIds: [], updatedAt: new Date(0).toISOString() };
}

describe('layout', () => {
  it('is deterministic for the same graph', () => {
    const graph = buildGraph();
    const a = layout(graph);
    const b = layout(graph);
    for (const n of a.nodes) {
      expect(b.pos.get(n.id)).toEqual(a.pos.get(n.id));
    }
  });

  it('does not place every node on a perfect circle around the center', () => {
    // Regression test: the previous layout placed every node at
    // `(i / n) * 2π` regardless of the graph's structure, so every node was
    // exactly the same distance from the centroid. A structure-aware layout
    // should not reproduce that — connected clusters and isolated nodes
    // settle at different distances from center.
    const { nodes, pos } = layout(buildGraph());
    const cx = [...pos.values()].reduce((s, p) => s + p.x, 0) / pos.size;
    const cy = [...pos.values()].reduce((s, p) => s + p.y, 0) / pos.size;
    const distances = nodes.map((n) => {
      const p = pos.get(n.id)!;
      return Math.hypot(p.x - cx, p.y - cy);
    });
    const allEqual = distances.every((d) => Math.abs(d - distances[0]) < 0.5);
    expect(allEqual).toBe(false);
  });

  it('pulls directly connected nodes closer together than the average pairwise distance', () => {
    const { edges, pos } = layout(buildGraph());
    const dist = (a: string, b: string) => {
      const pa = pos.get(a)!;
      const pb = pos.get(b)!;
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    };
    const edgeDistances = edges.map((e) => dist(e.from, e.to));
    const avgEdgeDist = edgeDistances.reduce((s, d) => s + d, 0) / edgeDistances.length;

    const allIds = [...pos.keys()];
    let allPairSum = 0;
    let allPairCount = 0;
    for (let i = 0; i < allIds.length; i++) {
      for (let j = i + 1; j < allIds.length; j++) {
        allPairSum += dist(allIds[i], allIds[j]);
        allPairCount++;
      }
    }
    const avgAllPairDist = allPairSum / allPairCount;

    expect(avgEdgeDist).toBeLessThan(avgAllPairDist);
  });

  it('never collapses two distinct nodes onto the same point', () => {
    const { nodes, pos } = layout(buildGraph());
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const pa = pos.get(nodes[i].id)!;
        const pb = pos.get(nodes[j].id)!;
        expect(Math.hypot(pa.x - pb.x, pa.y - pb.y)).toBeGreaterThan(0.5);
      }
    }
  });

  it('positions every shown node within the canvas bounds', () => {
    const { pos } = layout(buildGraph());
    for (const p of pos.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(320);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(320);
    }
  });

  it('handles an empty graph without throwing', () => {
    const graph: DocGraph = { nodes: [], edges: [], version: 3, processedDocIds: [], updatedAt: new Date(0).toISOString() };
    const { nodes, edges, pos } = layout(graph);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
    expect(pos.size).toBe(0);
  });
});
