// ABOUTME: JavaScript-specific AST helpers: function classification, OTel import detection, and variable shadowing.
// ABOUTME: Merged from src/ast/function-classification.ts, import-detection.ts, and variable-shadowing.ts.

import type { SourceFile, FunctionDeclaration, VariableStatement, ArrowFunction, FunctionExpression, Node } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

// ─── function-classification ─────────────────────────────────────────────────

/** Classification data for a single function. */
export interface FunctionInfo {
  /** Function name (or variable name for arrow functions). */
  name: string;
  /** Whether the function is exported from the module. */
  isExported: boolean;
  /** Whether the function is async. */
  isAsync: boolean;
  /** Number of lines in the function body (inclusive of opening/closing braces). */
  lineCount: number;
  /** Starting line number in the source file. */
  startLine: number;
}

/**
 * Classify all functions in a source file.
 *
 * Finds both function declarations and arrow/function expressions assigned to
 * top-level const/let/var. Returns classification data used by the instrumentation
 * agent to decide what to instrument.
 *
 * @param sourceFile - A ts-morph SourceFile (JavaScript or TypeScript)
 * @returns Array of FunctionInfo for every function found in the file
 */
export function classifyFunctions(sourceFile: SourceFile): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  // Function declarations: `function foo()` and `export function foo()`
  for (const fn of sourceFile.getFunctions()) {
    functions.push(classifyFunctionDeclaration(fn));
  }

  // Variable-assigned functions: `const foo = async () => {}` or `const foo = function() {}`
  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      const kind = initializer.getKind();
      if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) {
        functions.push(classifyVariableFunction(
          decl.getName(),
          initializer as ArrowFunction | FunctionExpression,
          varStatement,
        ));
      }
    }
  }

  return functions;
}

function classifyFunctionDeclaration(fn: FunctionDeclaration): FunctionInfo {
  const name = fn.getName() ?? '<anonymous>';
  const isExported = fn.isExported();
  const isAsync = fn.isAsync();
  const startLine = fn.getStartLineNumber();
  const endLine = fn.getEndLineNumber();
  const lineCount = endLine - startLine + 1;

  return { name, isExported, isAsync, lineCount, startLine };
}

function classifyVariableFunction(
  name: string,
  initializer: ArrowFunction | FunctionExpression,
  varStatement: VariableStatement,
): FunctionInfo {
  const isExported = varStatement.isExported();
  const isAsync = initializer.isAsync();
  const startLine = initializer.getStartLineNumber();
  const endLine = initializer.getEndLineNumber();
  const lineCount = endLine - startLine + 1;

  return { name, isExported, isAsync, lineCount, startLine };
}

// ─── import-detection ────────────────────────────────────────────────────────

/** Information about an import declaration. */
export interface ImportInfo {
  moduleSpecifier: string;
  namedImports: string[];
  defaultImport: string | undefined;
  namespaceImport: string | undefined;
  lineNumber: number;
}

/** A tracer variable acquired via trace.getTracer(). */
export interface TracerAcquisition {
  variableName: string;
  lineNumber: number;
}

/** An existing span creation pattern in the source. */
export interface ExistingSpanPattern {
  pattern: 'startActiveSpan' | 'startSpan';
  lineNumber: number;
  /** Name of the enclosing function, if identifiable. */
  enclosingFunction: string | undefined;
}

/** Full result of OTel import detection for a source file. */
export interface OTelImportDetectionResult {
  hasOTelImports: boolean;
  otelImports: ImportInfo[];
  frameworkImports: ImportInfo[];
  tracerAcquisitions: TracerAcquisition[];
  existingSpanPatterns: ExistingSpanPattern[];
}

/**
 * Known framework packages that have OpenTelemetry auto-instrumentation libraries.
 * Used to identify which imports in a file could benefit from auto-instrumentation.
 */
const KNOWN_FRAMEWORK_PACKAGES = new Set([
  // Database
  'pg', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'redis', 'ioredis',
  'cassandra-driver', 'tedious', 'oracledb', 'memcached',
  // HTTP
  'express', 'fastify', 'koa', 'hapi', '@hapi/hapi', 'restify', 'connect',
  '@nestjs/core',
  'node:http', 'node:https', 'node:net', 'node:dns', 'http', 'https',
  'axios', 'got', 'node-fetch', 'undici',
  // gRPC
  '@grpc/grpc-js',
  // Message queues
  'amqplib', 'kafkajs',
  // GraphQL
  'graphql', '@apollo/server',
  // ORM
  'knex', 'sequelize', 'typeorm', '@prisma/client',
  // Logging
  'winston', 'pino', 'bunyan',
  // Other instrumented packages
  'socket.io', 'openai', 'dataloader', 'aws-sdk', '@aws-sdk/client-s3',
]);

/**
 * Detect existing OpenTelemetry imports, tracer patterns, and framework imports in a source file.
 *
 * @param sourceFile - A ts-morph SourceFile (JavaScript or TypeScript)
 * @returns Detection result with OTel imports, framework imports, tracer acquisitions, and span patterns
 */
export function detectOTelImports(sourceFile: SourceFile): OTelImportDetectionResult {
  const otelImports: ImportInfo[] = [];
  const frameworkImports: ImportInfo[] = [];

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpecifier = importDecl.getModuleSpecifierValue();
    const info = extractImportInfo(importDecl, moduleSpecifier);

    if (moduleSpecifier.startsWith('@opentelemetry/')) {
      otelImports.push(info);
    } else if (KNOWN_FRAMEWORK_PACKAGES.has(moduleSpecifier)) {
      frameworkImports.push(info);
    }
  }

  const tracerAcquisitions = detectTracerAcquisitions(sourceFile);
  const existingSpanPatterns = detectSpanPatterns(sourceFile);

  return {
    hasOTelImports: otelImports.length > 0,
    otelImports,
    frameworkImports,
    tracerAcquisitions,
    existingSpanPatterns,
  };
}

function extractImportInfo(
  importDecl: import('ts-morph').ImportDeclaration,
  moduleSpecifier: string,
): ImportInfo {
  const namedImports = importDecl.getNamedImports().map(n => n.getName());
  const defaultImport = importDecl.getDefaultImport()?.getText();
  const namespaceImport = importDecl.getNamespaceImport()?.getText();
  const lineNumber = importDecl.getStartLineNumber();

  return { moduleSpecifier, namedImports, defaultImport, namespaceImport, lineNumber };
}

/**
 * Detect `const tracer = trace.getTracer(...)` patterns.
 */
function detectTracerAcquisitions(sourceFile: SourceFile): TracerAcquisition[] {
  const acquisitions: TracerAcquisition[] = [];

  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      const text = initializer.getText();
      if (text.includes('getTracer(')) {
        acquisitions.push({
          variableName: decl.getName(),
          lineNumber: decl.getStartLineNumber(),
        });
      }
    }
  }

  return acquisitions;
}

/**
 * Detect existing span creation patterns: tracer.startActiveSpan(...) and tracer.startSpan(...).
 */
function detectSpanPatterns(sourceFile: SourceFile): ExistingSpanPattern[] {
  const patterns: ExistingSpanPattern[] = [];

  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;

    const text = node.getText();
    let pattern: 'startActiveSpan' | 'startSpan' | undefined;

    if (text.includes('.startActiveSpan(')) {
      pattern = 'startActiveSpan';
    } else if (text.includes('.startSpan(')) {
      pattern = 'startSpan';
    }

    if (!pattern) return;

    // Walk up to find enclosing function
    let enclosingFunction: string | undefined;
    let ancestor = node.getParent();
    while (ancestor) {
      const kind = ancestor.getKind();
      if (kind === SyntaxKind.FunctionDeclaration) {
        enclosingFunction = (ancestor as import('ts-morph').FunctionDeclaration).getName();
        break;
      }
      if (kind === SyntaxKind.MethodDeclaration) {
        enclosingFunction = (ancestor as import('ts-morph').MethodDeclaration).getName();
        break;
      }
      if (kind === SyntaxKind.VariableDeclaration) {
        enclosingFunction = (ancestor as import('ts-morph').VariableDeclaration).getName();
        break;
      }
      ancestor = ancestor.getParent();
    }

    patterns.push({
      pattern,
      lineNumber: node.getStartLineNumber(),
      enclosingFunction,
    });
  });

  return patterns;
}

// ─── variable-shadowing ───────────────────────────────────────────────────────

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
