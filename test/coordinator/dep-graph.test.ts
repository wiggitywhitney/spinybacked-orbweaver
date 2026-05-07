// ABOUTME: Unit tests for buildDepGraph and topoSort — dep graph construction and topological ordering.
// ABOUTME: Covers happy-path chain, external import exclusion, leaf nodes, cycle breaking, and alphabetical tiebreaker.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { buildDepGraph, topoSort } from '../../src/coordinator/dep-graph.ts';
import type { DepGraph } from '../../src/coordinator/dep-graph.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'dep-graph');

const pathA = join(FIXTURES, 'a.ts');
const pathB = join(FIXTURES, 'b.ts');
const pathC = join(FIXTURES, 'c.ts');

describe('buildDepGraph', () => {
  it('includes all provided file paths as nodes', () => {
    const graph = buildDepGraph([pathA, pathB, pathC]);
    expect(graph.nodes).toEqual([pathA, pathB, pathC]);
  });

  it('captures local import edges: a→b and b→c', () => {
    const graph = buildDepGraph([pathA, pathB, pathC]);
    expect(graph.edges.get(pathA)).toEqual([pathB]);
    expect(graph.edges.get(pathB)).toEqual([pathC]);
  });

  it('leaf node (c.ts) has empty edges array', () => {
    const graph = buildDepGraph([pathA, pathB, pathC]);
    expect(graph.edges.get(pathC)).toEqual([]);
  });

  it('excludes external imports (node:path, node:fs, ts-morph) from edges', () => {
    const graph = buildDepGraph([pathA, pathB, pathC]);
    for (const [, targets] of graph.edges) {
      for (const target of targets) {
        expect([pathA, pathB, pathC]).toContain(target);
      }
    }
  });

  it('returns empty edges for a single file with no local imports', () => {
    const graph = buildDepGraph([pathC]);
    expect(graph.nodes).toEqual([pathC]);
    expect(graph.edges.get(pathC)).toEqual([]);
  });

  it('ignores imports that resolve outside the provided filePaths set', () => {
    // Only pass a and c — b is not in the set. a imports b, but b is not in filePaths.
    const graph = buildDepGraph([pathA, pathC]);
    expect(graph.edges.get(pathA)).toEqual([]);
    expect(graph.edges.get(pathC)).toEqual([]);
  });
});

describe('topoSort', () => {
  it('linear chain A→B→C: leaf C is first, caller A is last', () => {
    const graph = buildDepGraph([pathA, pathB, pathC]);
    const order = topoSort(graph);
    expect(order).toEqual([pathC, pathB, pathA]);
  });

  it('simple cycle A→B→A: does not loop indefinitely, returns all nodes', () => {
    const cycleA = '/virtual/a.ts';
    const cycleB = '/virtual/b.ts';
    const graph: DepGraph = {
      nodes: [cycleA, cycleB],
      edges: new Map([
        [cycleA, [cycleB]],
        [cycleB, [cycleA]],
      ]),
    };
    const order = topoSort(graph);
    expect(order).toHaveLength(2);
    expect(order).toContain(cycleA);
    expect(order).toContain(cycleB);
  });

  it('alphabetical tiebreaker: two unrelated files are sorted alphabetically', () => {
    const alpha = '/virtual/alpha.ts';
    const beta = '/virtual/beta.ts';
    const graph: DepGraph = {
      nodes: [beta, alpha], // intentionally reversed to confirm sort is applied
      edges: new Map([[alpha, []], [beta, []]]),
    };
    const order = topoSort(graph);
    expect(order[0]).toBe(alpha);
    expect(order[1]).toBe(beta);
  });
});
