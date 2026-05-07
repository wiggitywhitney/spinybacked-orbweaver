// ABOUTME: Unit tests for buildDepGraph — dependency graph construction from real .ts fixture files.
// ABOUTME: Covers happy-path chain, external import exclusion, and empty-edges for leaf nodes.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { buildDepGraph } from '../../src/coordinator/dep-graph.ts';

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
