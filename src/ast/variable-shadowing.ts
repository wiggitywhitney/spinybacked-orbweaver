// ABOUTME: Scope-based variable shadowing detection for OTel variable names.
// ABOUTME: Uses compiler node locals access to check for naming conflicts before instrumentation.

import type { Node, FunctionDeclaration, FunctionExpression, ArrowFunction } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

/** A single naming conflict found in scope. */
export interface ShadowingConflict {
  requestedName: string;
  suggestedName: string;
  lineNumber: number;
}

/** Result of checking variable shadowing for a function. */
export interface ShadowingResult {
  hasConflicts: boolean;
  conflicts: ShadowingConflict[];
  /**
   * Map of requested name → safe name to use.
   * If no conflict, the safe name is the original. If conflict, it's the otel-prefixed alternative.
   */
  safeNames: Map<string, string>;
}

/** OTel-prefixed alternatives for common variable names. */
const OTEL_ALTERNATIVES: Record<string, string> = {
  span: 'otelSpan',
  tracer: 'otelTracer',
  SpanStatusCode: 'otelSpanStatusCode',
};

/**
 * Check if introducing variables with the given names would cause shadowing conflicts
 * within the scope of a function.
 *
 * Uses ts-morph's compiler node `locals` access at the target scope level, wrapped
 * in an abstraction to isolate the compiler-internal dependency.
 *
 * @param functionNode - The function to check variable scopes within
 * @param variableNames - Names to check for conflicts (e.g., ['span', 'tracer'])
 * @returns Shadowing result with conflicts and safe name recommendations
 */
export function checkVariableShadowing(
  functionNode: FunctionDeclaration | FunctionExpression | ArrowFunction,
  variableNames: string[],
): ShadowingResult {
  const allLocals = collectLocalsInScope(functionNode);
  const conflicts: ShadowingConflict[] = [];
  const safeNames = new Map<string, string>();

  for (const name of variableNames) {
    const existing = allLocals.get(name);
    if (existing) {
      const suggestedName = OTEL_ALTERNATIVES[name] ?? `otel${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      conflicts.push({
        requestedName: name,
        suggestedName,
        lineNumber: existing.lineNumber,
      });
      safeNames.set(name, suggestedName);
    } else {
      safeNames.set(name, name);
    }
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
    safeNames,
  };
}

interface LocalInfo {
  name: string;
  lineNumber: number;
}

/**
 * Collect all local variable names declared within a function scope, including nested blocks.
 * Uses compiler node `locals` access wrapped in a helper to isolate the internal API.
 *
 * This checks the function body and all descendant scopes (for-loops, if-blocks, etc.)
 * because a variable declared in any nested scope would still conflict with an OTel variable
 * introduced at the function level.
 */
function collectLocalsInScope(node: Node): Map<string, LocalInfo> {
  const locals = new Map<string, LocalInfo>();

  // Try compiler node locals first (the preferred approach per spec)
  const compilerLocals = getCompilerNodeLocals(node);
  if (compilerLocals) {
    for (const [name, symbol] of compilerLocals) {
      const declarations = symbol.declarations;
      const lineNumber = declarations?.[0]
        ? node.getSourceFile().compilerNode.getLineAndCharacterOfPosition(declarations[0].pos).line + 1
        : node.getStartLineNumber();
      locals.set(name as string, { name: name as string, lineNumber });
    }
  }

  // Also scan descendant variable declarations to catch nested block-scoped variables
  // that compiler locals at the function level might not include
  node.forEachDescendant((descendant) => {
    if (descendant.getKind() === SyntaxKind.VariableDeclaration) {
      const varDecl = descendant as import('ts-morph').VariableDeclaration;
      const name = varDecl.getName();
      if (!locals.has(name)) {
        locals.set(name, { name, lineNumber: varDecl.getStartLineNumber() });
      }
    }
  });

  // Also check function parameters
  if ('getParameters' in node && typeof node.getParameters === 'function') {
    for (const param of (node as FunctionDeclaration).getParameters()) {
      const name = param.getName();
      if (!locals.has(name)) {
        locals.set(name, { name, lineNumber: param.getStartLineNumber() });
      }
    }
  }

  return locals;
}

/**
 * Access compiler node `locals` map. This is a compiler-internal API that ts-morph
 * exposes but warns may change between TypeScript versions.
 *
 * Wrapped in isolation per spec recommendation to minimize blast radius if the
 * internal API changes.
 */
function getCompilerNodeLocals(node: Node): Map<string, { declarations?: { pos: number }[] }> | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const compilerNode = node.compilerNode as any;
    if (compilerNode.locals && compilerNode.locals instanceof Map) {
      return compilerNode.locals;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
