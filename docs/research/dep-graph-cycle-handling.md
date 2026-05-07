# Dependency Graph Cycle Handling

**Purpose**: Document the correct algorithm for Kahn's topological sort with cycle detection, and the cycle-breaking strategy for `buildDepGraph` / `topoSort`.

---

## ts-morph API for Import Resolution

`sf.getImportDeclarations()` returns all `ImportDeclaration` nodes in a source file. For each:

- `decl.getModuleSpecifierValue()` — raw string from the source (e.g., `"./io/resolves"`, `"ts-morph"`, `"node:path"`)
- `decl.getModuleSpecifierSourceFile()` — resolves to the `SourceFile` object if the module is loaded in the `Project`; returns `undefined` for external packages, builtins, and anything not in the project

**How local vs. external is determined**: Call `getModuleSpecifierSourceFile()`. If it returns a `SourceFile` whose `getFilePath()` is in the instrumentation set (a `Set<string>` of absolute paths), it is a local dependency edge. External packages, `node:*` builtins, and JSON files all return `undefined` or resolve to paths outside the set.

**Verified patterns** (from taze fixture, cli.ts):
```text
"cac"              → undefined (external npm package)
"node:process"     → undefined (Node.js builtin)
"./types"          → /path/to/src/types.ts (local — in set)
"./commands/check" → /path/to/src/commands/check/index.ts (directory import — resolved correctly)
"../package.json"  → undefined (not a TypeScript file)
```

---

## Kahn's Algorithm (BFS-based topological sort)

Kahn's algorithm processes nodes with in-degree 0 first (leaves), then removes them and their edges, repeating until all nodes are processed. This naturally produces a leaves-first order.

```text
Input:  graph.nodes (all file paths), graph.edges (source → [target, ...])
Output: ordered array, leaves first

1. Compute in-degree for every node:
   inDegree[node] = count of edges where node appears as a target

2. Initialize result = [], queue = all nodes with inDegree = 0
   Sort queue alphabetically (tiebreaker: files with no deps sort deterministically)

3. While queue is not empty:
   a. Dequeue the first node N (already in sorted order)
   b. Append N to result
   c. For each neighbor M in graph.edges[N]:
      - inDegree[M] -= 1
      - If inDegree[M] === 0: insert M into queue in alphabetical order

4. Return result
```

**Why BFS-based over DFS-based:**
- Cycle detection is natural: if `result.length < graph.nodes.length` after the algorithm, the remaining nodes (never dequeued) form cycles
- Alphabetical tiebreaker is easy to apply at each BFS step — sort before enqueueing, use `Array.prototype.sort` within each wave
- No recursion stack; handles large graphs without stack overflow risk

**Alphabetical tiebreaker detail**: Within each BFS "wave" (the set of nodes that become available when a previous node is removed), sort alphabetically before adding to the queue. In practice: when a node's in-degree reaches 0, insert it into a sorted position in the queue rather than appending. Since the queue starts sorted and each insertion maintains order, the output is deterministic.

---

## Cycle Detection and Breaking

**Detection**: After Kahn's algorithm completes, if `result.length < graph.nodes.length`, at least one cycle exists. The nodes that were never dequeued are in cycles.

**Breaking strategy (per PRD)**: Remove one edge, re-run Kahn's.

```text
1. Find any node N that is still in the graph (not in result)
2. Pick the first edge from graph.edges[N] — call it N → M
3. Remove this edge from graph.edges (mutate the map)
4. Log to stderr: "[dep-graph] cycle detected: removed edge <N> → <M>"
5. Restart Kahn's from scratch on the modified graph

Repeat until result.length === graph.nodes.length.

Guard: if restart iterations > total original edge count, throw:
  new Error("dep-graph cycle breaking exceeded edge count — this is a bug")
```

**Why restart from scratch**: After removing an edge, in-degrees must be recomputed because the removed edge changes the in-degree of M. Recomputing from scratch is correct and simple. Performance impact is negligible — cycles are rare and the graph is small (≤100 files for typical instrumentation targets).

**Why this strategy over minimum feedback arc set**: MAS is NP-hard; the simple "remove one edge, restart" approach is correct and auditable. The PRD prioritizes auditability (log each removed edge) over minimizing the number of edges removed.

---

## Invariants for topoSort

- Output contains every node in `graph.nodes` exactly once
- For every edge A → B in the original graph: B appears before A in the output (unless the edge was removed for cycle-breaking, in which case it is logged)
- Within a BFS wave, output order is alphabetical
- The function never loops infinitely (guard on restart iterations)

---

## Example Traces

**Linear chain: C → B → A (C imports B, B imports A)**
- Initial in-degrees: A=0, B=1, C=1
- Queue: [A] (only in-degree 0 node)
- Process A → result=[A], B in-degree → 0, queue=[B]
- Process B → result=[A,B], C in-degree → 0, queue=[C]
- Process C → result=[A,B,C]
- Output: [A, B, C] — leaves (A) first ✓

**Simple cycle: A → B → A**
- Initial in-degrees: A=1, B=1
- Queue: [] — nobody has in-degree 0
- Kahn's completes with result=[], which is < 2 nodes — cycle detected
- Find A (never dequeued), remove edge A → B, log it
- Restart Kahn's: in-degrees A=0 (no incoming now, since B→A still exists), B=0 (A→B removed)
  - Actually: remaining edges after removal = {B → A}
  - In-degrees: A=1, B=0
  - Queue: [B], process B → A in-degree → 0, process A
  - Output: [B, A] ✓

**Alphabetical tiebreaker: alpha.ts and beta.ts with no relationship**
- In-degrees: alpha=0, beta=0
- Initial queue sorted: [alpha, beta]
- Output: [alpha, beta] ✓
