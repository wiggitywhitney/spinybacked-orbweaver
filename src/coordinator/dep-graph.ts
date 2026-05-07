// ABOUTME: Dependency graph builder for file instrumentation ordering.
// ABOUTME: Builds a graph of local import relationships using ts-morph, then topologically sorts it (leaves first).

import { Project } from 'ts-morph';

export type DepGraph = {
  nodes: string[];
  edges: Map<string, string[]>;
};

/**
 * Build a dependency graph from a list of absolute file paths.
 *
 * Parses each file with ts-morph and collects local import edges — imports that
 * resolve to another file in `filePaths`. External package imports, Node.js
 * builtins, and JSON files are excluded (they return undefined from
 * getModuleSpecifierSourceFile when not in the project).
 *
 * The graph is not sorted. Use topoSort() to obtain a leaves-first ordering.
 */
export function buildDepGraph(filePaths: string[]): DepGraph {
  const fileSet = new Set(filePaths);

  const project = new Project({
    compilerOptions: {
      skipLibCheck: true,
      noEmit: true,
      allowJs: true,
    },
    skipAddingFilesFromTsConfig: true,
  });

  for (const f of filePaths) {
    project.addSourceFileAtPath(f);
  }

  const edges = new Map<string, string[]>();

  for (const sf of project.getSourceFiles()) {
    const srcPath = sf.getFilePath();
    const localImports: string[] = [];

    for (const decl of sf.getImportDeclarations()) {
      const resolved = decl.getModuleSpecifierSourceFile();
      if (resolved !== undefined && fileSet.has(resolved.getFilePath())) {
        localImports.push(resolved.getFilePath());
      }
    }

    edges.set(srcPath, localImports);
  }

  return { nodes: filePaths, edges };
}

/**
 * Topologically sort a dependency graph, leaves first.
 *
 * Uses Kahn's algorithm on the transposed graph: tracks how many local imports
 * each file still has unprocessed (out-degree in the original graph). Files
 * with zero remaining imports (leaves) are processed first; as each leaf is
 * emitted, callers that depended only on it become ready next.
 *
 * Within each BFS wave, files are sorted alphabetically for determinism.
 *
 * Cycle detection: if the result set is smaller than graph.nodes.length after
 * the BFS, a cycle exists. One edge is removed (logged to stderr) and Kahn's
 * restarts. Throws if restarts exceed the original edge count.
 */
export function topoSort(graph: DepGraph): string[] {
  // Deep-copy edges so cycle-breaking mutations don't affect the original graph
  let workingEdges = new Map<string, string[]>(
    [...graph.edges].map(([k, v]) => [k, [...v]]),
  );
  const originalEdgeCount = [...graph.edges.values()].reduce((sum, v) => sum + v.length, 0);
  let restartCount = 0;

  while (true) {
    const result = kahnLeavesFirst(graph.nodes, workingEdges);

    if (result.length === graph.nodes.length) {
      return result;
    }

    if (restartCount > originalEdgeCount) {
      throw new Error('dep-graph cycle breaking exceeded edge count — this is a bug');
    }

    // Find a node still in the cycle (never emitted), remove its first edge
    const resultSet = new Set(result);
    const cycleNode = graph.nodes.find(n => !resultSet.has(n));
    if (cycleNode === undefined) break; // unreachable; satisfies type checker

    const cycleEdges = workingEdges.get(cycleNode);
    if (cycleEdges === undefined || cycleEdges.length === 0) break;

    const target = cycleEdges[0]!;
    workingEdges.set(cycleNode, cycleEdges.slice(1));
    process.stderr.write(`[dep-graph] cycle detected: removed edge ${cycleNode} → ${target}\n`);
    restartCount++;
  }

  return kahnLeavesFirst(graph.nodes, workingEdges);
}

/**
 * One pass of Kahn's algorithm, configured for leaves-first ordering.
 *
 * Tracks `remainingImports[N]` = number of local imports N still has. Nodes
 * with remainingImports === 0 are leaves (enqueued first, alphabetically).
 * When a leaf is dequeued, all files that import it have their count decremented;
 * any that reach 0 join the queue (sorted alphabetically within each wave).
 *
 * Returns a partial result if the graph contains cycles — the caller detects
 * this by comparing result.length to nodes.length.
 */
function kahnLeavesFirst(nodes: string[], edges: Map<string, string[]>): string[] {
  // Build reverse map: importedBy[B] = list of files that import B
  const importedBy = new Map<string, string[]>();
  for (const n of nodes) importedBy.set(n, []);
  for (const [src, targets] of edges) {
    for (const t of targets) {
      importedBy.get(t)?.push(src);
    }
  }

  // remainingImports[N] = count of local imports N has left to process
  const remainingImports = new Map<string, number>();
  for (const n of nodes) {
    remainingImports.set(n, (edges.get(n) ?? []).length);
  }

  // Start with leaves (nodes that import nothing), sorted alphabetically
  const queue: string[] = nodes
    .filter(n => (remainingImports.get(n) ?? 0) === 0)
    .sort();
  const result: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);

    const newlyReady: string[] = [];
    for (const caller of (importedBy.get(node) ?? [])) {
      const count = (remainingImports.get(caller) ?? 0) - 1;
      remainingImports.set(caller, count);
      if (count === 0) newlyReady.push(caller);
    }

    newlyReady.sort();
    queue.push(...newlyReady);
    queue.sort();
  }

  return result;
}
