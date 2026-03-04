// ABOUTME: Rubric check helpers for acceptance gate verification.
// ABOUTME: One function per rubric rule — verifies instrumented code meets quality criteria.

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from 'ts-morph';
import type { SourceFile, SyntaxKind as SyntaxKindType } from 'ts-morph';

/** Result of a rubric check. */
interface RubricCheckResult {
  passed: boolean;
  details?: string;
}

/**
 * NDS-001: Syntax validation — `node --check` exits 0.
 */
export function checkSyntaxValid(code: string): RubricCheckResult {
  const dir = mkdtempSync(join(tmpdir(), 'orb-nds001-'));
  const filePath = join(dir, 'check.js');
  try {
    writeFileSync(filePath, code, 'utf-8');
    execFileSync('node', ['--check', filePath], { timeout: 10000 });
    return { passed: true };
  } catch (error) {
    const message = error instanceof Error ? (error as any).stderr?.toString() ?? error.message : String(error);
    return { passed: false, details: `node --check failed: ${message}` };
  } finally {
    try { unlinkSync(filePath); } catch { /* ignore cleanup errors */ }
    try { rmdirSync(dir); } catch { /* ignore cleanup errors */ }
  }
}

/**
 * NDS-003: Non-instrumentation lines unchanged.
 * Every non-blank line from the original should appear in the instrumented output
 * (after trimming whitespace, to allow for indentation changes from wrapping).
 */
export function checkNonInstrumentationLinesUnchanged(
  original: string,
  instrumented: string,
): RubricCheckResult {
  const originalLines = original.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const instrumentedLines = new Set(
    instrumented.split('\n').map(l => l.trim()),
  );

  const missingLines: string[] = [];
  for (const line of originalLines) {
    // Skip ABOUTME comments — these may be legitimately modified
    if (line.startsWith('// ABOUTME:')) continue;
    if (!instrumentedLines.has(line)) {
      missingLines.push(line);
    }
  }

  if (missingLines.length === 0) {
    return { passed: true };
  }

  return {
    passed: false,
    details: `Original lines missing from instrumented output:\n${missingLines.map(l => `  - ${l}`).join('\n')}`,
  };
}

/**
 * NDS-004: Public API signatures preserved.
 * All exported function names from the original must exist in the instrumented output
 * with the same parameter count.
 */
export function checkPublicApiPreserved(
  original: string,
  instrumented: string,
): RubricCheckResult {
  const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
  const origFile = project.createSourceFile('original.js', original);
  const instFile = project.createSourceFile('instrumented.js', instrumented);

  const getExportedFunctions = (sf: SourceFile) => {
    const fns: Array<{ name: string; paramCount: number; isAsync: boolean }> = [];

    for (const fn of sf.getFunctions()) {
      if (fn.isExported()) {
        fns.push({
          name: fn.getName() ?? '<anonymous>',
          paramCount: fn.getParameters().length,
          isAsync: fn.isAsync(),
        });
      }
    }

    // Also check variable declarations with arrow functions
    for (const stmt of sf.getVariableStatements()) {
      if (!stmt.isExported()) continue;
      for (const decl of stmt.getDeclarations()) {
        const init = decl.getInitializer();
        if (init && (init.getKindName() === 'ArrowFunction' || init.getKindName() === 'FunctionExpression')) {
          fns.push({
            name: decl.getName(),
            paramCount: (init as any).getParameters?.()?.length ?? 0,
            isAsync: init.getText().startsWith('async'),
          });
        }
      }
    }

    return fns;
  };

  const origFns = getExportedFunctions(origFile);
  const instFns = getExportedFunctions(instFile);

  const differences: string[] = [];
  for (const origFn of origFns) {
    const instFn = instFns.find(f => f.name === origFn.name);
    if (!instFn) {
      differences.push(`Exported function '${origFn.name}' is missing from instrumented output`);
      continue;
    }
    if (instFn.paramCount !== origFn.paramCount) {
      differences.push(`'${origFn.name}' parameter count changed: ${origFn.paramCount} -> ${instFn.paramCount}`);
    }
    if (instFn.isAsync !== origFn.isAsync) {
      differences.push(`'${origFn.name}' async changed: ${origFn.isAsync} -> ${instFn.isAsync}`);
    }
  }

  if (differences.length === 0) {
    return { passed: true };
  }
  return { passed: false, details: differences.join('\n') };
}

/**
 * NDS-005: Error handling behavior preserved.
 * Pre-existing try/catch blocks should still be present. Catch clause bodies
 * (excluding OTel additions) should be unchanged.
 */
export function checkErrorHandlingPreserved(
  original: string,
  instrumented: string,
): RubricCheckResult {
  // Extract catch clause body content from original (trimmed, non-empty lines)
  const catchContentRegex = /catch\s*\([^)]*\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;

  const originalCatches: string[] = [];
  let match;
  while ((match = catchContentRegex.exec(original)) !== null) {
    const body = match[1].trim();
    if (body) originalCatches.push(body);
  }

  if (originalCatches.length === 0) {
    return { passed: true };
  }

  // Each original catch body's non-OTel lines should appear in the instrumented output
  const instrumentedText = instrumented;
  const missingContent: string[] = [];

  for (const catchBody of originalCatches) {
    const lines = catchBody.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .filter(l => !isOTelLine(l));

    for (const line of lines) {
      if (!instrumentedText.includes(line)) {
        missingContent.push(line);
      }
    }
  }

  if (missingContent.length === 0) {
    return { passed: true };
  }
  return {
    passed: false,
    details: `Original catch block content missing:\n${missingContent.map(l => `  - ${l}`).join('\n')}`,
  };
}

/**
 * API-001: All @opentelemetry imports must be from @opentelemetry/api only.
 */
export function checkOtelImportsApiOnly(code: string): RubricCheckResult {
  const importRegex = /from\s+['"](@opentelemetry\/[^'"]+)['"]/g;
  const invalidImports: string[] = [];

  let match;
  while ((match = importRegex.exec(code)) !== null) {
    if (match[1] !== '@opentelemetry/api') {
      invalidImports.push(match[1]);
    }
  }

  if (invalidImports.length === 0) {
    return { passed: true };
  }
  return {
    passed: false,
    details: `Invalid OTel imports (must be @opentelemetry/api only): ${invalidImports.join(', ')}`,
  };
}

/**
 * CDQ-001: Spans closed in all code paths.
 * Every startActiveSpan/startSpan call must have span.end() in a finally block.
 */
export function checkSpansClosed(code: string): RubricCheckResult {
  // Count span open patterns
  const spanOpenCount = (code.match(/\.startActiveSpan\s*\(/g) || []).length
    + (code.match(/\.startSpan\s*\(/g) || []).length;

  if (spanOpenCount === 0) {
    return { passed: true };
  }

  // Count span.end() in finally blocks
  const finallyEndRegex = /finally\s*\{[^}]*\.end\(\)/g;
  const finallyEndCount = (code.match(finallyEndRegex) || []).length;

  if (finallyEndCount >= spanOpenCount) {
    return { passed: true };
  }

  return {
    passed: false,
    details: `Found ${spanOpenCount} span opens but only ${finallyEndCount} span.end() calls in finally blocks`,
  };
}

/**
 * CDQ-002: Tracer acquired correctly with a string argument.
 */
export function checkTracerAcquired(code: string): RubricCheckResult {
  const tracerCalls = code.match(/trace\.getTracer\s*\(([^)]*)\)/g);
  if (!tracerCalls || tracerCalls.length === 0) {
    // If no tracer calls and no spans, that's fine (e.g., auto-instrumentation only)
    const hasSpans = /\.startActiveSpan|\.startSpan/.test(code);
    if (hasSpans) {
      return { passed: false, details: 'Spans found but no trace.getTracer() call' };
    }
    return { passed: true };
  }

  const issues: string[] = [];
  for (const call of tracerCalls) {
    const argMatch = call.match(/trace\.getTracer\s*\(\s*(['"][^'"]+['"])/);
    if (!argMatch) {
      issues.push(`trace.getTracer() call without string argument: ${call}`);
    }
  }

  if (issues.length === 0) {
    return { passed: true };
  }
  return { passed: false, details: issues.join('\n') };
}

/**
 * CDQ-003: Standard error recording pattern.
 * Catch blocks should use span.recordException() + span.setStatus({ code: SpanStatusCode.ERROR }).
 */
export function checkErrorRecording(code: string): RubricCheckResult {
  // Find catch blocks that contain span references
  const hasSpanInCatch = /catch\s*\([^)]*\)\s*\{[^}]*(?:span|otelSpan)\./;

  if (!hasSpanInCatch.test(code)) {
    // No span usage in catch blocks — check if there are spans at all
    const hasSpans = /\.startActiveSpan|\.startSpan/.test(code);
    if (!hasSpans) return { passed: true };
    // If there are spans but no error handling, that's a problem
    // but only if there are catch blocks
    const hasCatch = /catch\s*\(/.test(code);
    if (!hasCatch) {
      // Spans without catch blocks are acceptable — error recording is only required when catching
      return { passed: true };
    }
  }

  // Check that recordException and setStatus patterns exist
  const hasRecordException = /\.recordException\s*\(/.test(code);
  const hasSetStatus = /\.setStatus\s*\(\s*\{[^}]*code:\s*SpanStatusCode\.ERROR/.test(code);

  const issues: string[] = [];
  if (!hasRecordException) {
    issues.push('Missing span.recordException() in error handling');
  }
  if (!hasSetStatus) {
    issues.push('Missing span.setStatus({ code: SpanStatusCode.ERROR }) in error handling');
  }

  if (issues.length === 0) {
    return { passed: true };
  }
  return { passed: false, details: issues.join('\n') };
}

/**
 * CDQ-005: Async context maintained.
 * startActiveSpan callback auto-manages context — passes.
 * startSpan requires context.with() — checked here.
 */
export function checkAsyncContext(code: string): RubricCheckResult {
  // startActiveSpan auto-manages context — this is the expected pattern
  const hasStartActiveSpan = /\.startActiveSpan\s*\(/.test(code);

  // startSpan requires manual context management
  const startSpanMatches = code.match(/\.startSpan\s*\(/g);
  if (startSpanMatches && startSpanMatches.length > 0) {
    const hasContextWith = /context\.with\s*\(/.test(code);
    if (!hasContextWith) {
      return {
        passed: false,
        details: `Found ${startSpanMatches.length} startSpan() calls without context.with() for async context management`,
      };
    }
  }

  return { passed: true };
}

/**
 * CDQ-007: No unbounded or PII attributes.
 * Flag setAttribute calls with JSON.stringify, object spreads, or PII field patterns.
 */
export function checkAttributeSafety(code: string): RubricCheckResult {
  const issues: string[] = [];

  // Check for JSON.stringify in setAttribute
  if (/\.setAttribute\s*\([^)]*JSON\.stringify/.test(code)) {
    issues.push('setAttribute uses JSON.stringify — may produce unbounded attribute values');
  }

  // Check for object spread in setAttribute
  if (/\.setAttribute\s*\([^)]*\.\.\./.test(code)) {
    issues.push('setAttribute uses object spread — unbounded attribute values');
  }

  // Check for PII field patterns in attribute keys
  const piiPatterns = ['email', 'password', 'ssn', 'phone', 'creditCard', 'credit_card', 'address'];
  const setAttrRegex = /\.setAttribute\s*\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = setAttrRegex.exec(code)) !== null) {
    const attrKey = match[1].toLowerCase();
    for (const pii of piiPatterns) {
      if (attrKey.includes(pii)) {
        issues.push(`setAttribute key '${match[1]}' matches PII pattern '${pii}'`);
      }
    }
  }

  if (issues.length === 0) {
    return { passed: true };
  }
  return { passed: false, details: issues.join('\n') };
}

/** Helper: check if a line is an OTel instrumentation addition. */
function isOTelLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('span.') ||
    trimmed.startsWith('otelSpan.') ||
    trimmed.includes('recordException') ||
    trimmed.includes('setStatus') ||
    trimmed.includes('SpanStatusCode') ||
    trimmed.includes('startActiveSpan') ||
    trimmed.includes('startSpan') ||
    trimmed.includes('@opentelemetry') ||
    trimmed.includes('trace.getTracer') ||
    trimmed.startsWith('const tracer') ||
    trimmed.startsWith('const otelTracer')
  );
}
