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

