// ABOUTME: Detects existing OpenTelemetry imports, tracer acquisitions, and span patterns in JS files.
// ABOUTME: Also identifies framework imports that have auto-instrumentation library counterparts.

import type { SourceFile } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

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
  'pg', 'mysql', 'mysql2', 'mongodb', 'redis', 'ioredis',
  // HTTP
  'express', 'fastify', 'koa', 'hapi', '@hapi/hapi',
  'node:http', 'node:https', 'http', 'https',
  'axios', 'got', 'node-fetch', 'undici',
  // gRPC
  '@grpc/grpc-js',
  // Message queues
  'amqplib', 'kafkajs',
  // GraphQL
  'graphql', '@apollo/server',
  // ORM
  'knex', 'sequelize', 'typeorm', 'prisma',
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
