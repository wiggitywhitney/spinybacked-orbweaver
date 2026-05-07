# ts-morph Dependency Graph Performance

**Purpose**: Determine whether building a full dependency graph with ts-morph is acceptable as a synchronous pre-instrumentation step.

**Benchmark target**: taze fixture — 33 TypeScript source files in `src/`, 86 local import edges.

---

## Method

Script created a disk-backed `ts-morph` `Project` (not in-memory), added all 33 `.ts` files via `addSourceFileAtPath()`, iterated `getImportDeclarations()` on each source file, and used `getModuleSpecifierSourceFile()` to resolve local vs. external imports. Timed from project creation through edge collection.

## Results

| Run | Wall time |
|-----|-----------|
| 1 (cold start) | 46.92ms |
| 2 | 14.75ms |
| 3 | 9.66ms |
| **Median** | **14.75ms** |

## Conclusion

**Well within the 2-second threshold.** Even the cold-start (JIT warmup) cost of ~47ms is acceptable. In production, `buildDepGraph` is called once per `spiny-orb instrument` invocation as a pre-instrumentation step. The cost is negligible relative to the LLM API calls that follow.

**No caching needed.** The dep graph is computed once per run. ts-morph parses files synchronously, so the call can be placed before the async dispatch loop with no architectural complications.

---

## Key API Findings

**Prefer `getModuleSpecifierSourceFile()` over manual path resolution.**

```typescript
const project = new Project({
  compilerOptions: { skipLibCheck: true, noEmit: true },
  skipAddingFilesFromTsConfig: true,
});
for (const f of filePaths) project.addSourceFileAtPath(f);

const fileSet = new Set(filePaths);

for (const sf of project.getSourceFiles()) {
  for (const decl of sf.getImportDeclarations()) {
    const resolved = decl.getModuleSpecifierSourceFile();
    if (resolved && fileSet.has(resolved.getFilePath())) {
      // resolved.getFilePath() is an absolute path in filePaths
    }
  }
}
```

Why `getModuleSpecifierSourceFile()` over manual path manipulation:
- Handles directory imports (`./commands/check` → `.../commands/check/index.ts`) automatically
- Handles `.ts`-extension-less specifiers (TypeScript convention)
- External packages return `undefined` (no entry in the project, or resolves to `node_modules/*.d.ts` outside our set)
- `node:*` builtins return `undefined`
- `../package.json` returns `undefined` (not a TS file)

A `Set<string>` check on `resolved.getFilePath()` correctly filters to only the files in the instrumentation set — no additional filter on relative path prefix (`./`, `../`) needed.

**Constructor options that matter:**
- `skipAddingFilesFromTsConfig: true` — prevents ts-morph from auto-discovering files from a tsconfig.json in the directory tree; we control exactly which files are in the project
- `skipLibCheck: true` in compilerOptions — avoids type-checking library `.d.ts` files, which would add significant overhead

---

## Implications for M2

- Use a disk-backed `Project`, not `useInMemoryFileSystem: true` (the current pattern in `src/languages/typescript/ast.ts`)
- `useInMemoryFileSystem: true` is correct for single-file parsing (no cross-file resolution needed); disk-backed is required when `getModuleSpecifierSourceFile()` must resolve between files
- The M2 `buildDepGraph(filePaths)` function creates a new `Project` per call — no global project state needed
