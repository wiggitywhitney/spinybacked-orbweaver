// ABOUTME: NDS-006 Tier 2 check — module system preservation.
// ABOUTME: Detects when instrumented code uses a different module system (ESM vs CJS) than the original.

import { Project, Node } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import type { CheckResult } from '../types.ts';

/**
 * Module system signals detected in a source file.
 */
interface ModuleSignals {
  hasEsmImport: boolean;
  hasEsmExport: boolean;
  hasCjsRequire: boolean;
  hasCjsExports: boolean;
}

/**
 * Detect module system signals in a source file using AST analysis.
 *
 * ESM signals: import declarations, export declarations/assignments.
 * CJS signals: require() calls, module.exports, exports.prop assignments.
 */
function detectModuleSignals(sourceFile: SourceFile): ModuleSignals {
  const signals: ModuleSignals = {
    hasEsmImport: false,
    hasEsmExport: false,
    hasCjsRequire: false,
    hasCjsExports: false,
  };

  // ESM imports
  if (sourceFile.getImportDeclarations().length > 0) {
    signals.hasEsmImport = true;
  }

  // ESM exports: explicit export declarations, export assignments, and
  // functions/classes/variables with the export keyword.
  // Do NOT use getExportedDeclarations() — it also picks up CJS exports.prop.
  if (
    sourceFile.getExportDeclarations().length > 0 ||
    sourceFile.getExportAssignments().length > 0
  ) {
    signals.hasEsmExport = true;
  }

  // Check for `export function`, `export class`, `export const`, `export default`
  sourceFile.forEachChild((node) => {
    if (Node.isExportable(node) && node.isExported()) {
      signals.hasEsmExport = true;
    }
  });

  // CJS require() and module.exports / exports.prop
  sourceFile.forEachDescendant((node) => {
    // require() calls
    if (Node.isCallExpression(node)) {
      const expr = node.getExpression();
      if (Node.isIdentifier(expr) && expr.getText() === 'require') {
        const args = node.getArguments();
        if (args.length > 0 && Node.isStringLiteral(args[0])) {
          signals.hasCjsRequire = true;
        }
      }
    }

    // module.exports or exports.prop
    if (Node.isPropertyAccessExpression(node)) {
      const text = node.getText();
      if (text.startsWith('module.exports') || text.startsWith('exports.')) {
        // Only count as CJS if it's an assignment target (left side of =)
        const parent = node.getParent();
        if (
          parent &&
          Node.isBinaryExpression(parent) &&
          parent.getLeft() === node
        ) {
          signals.hasCjsExports = true;
        }
      }
    }
  });

  return signals;
}

/**
 * Classify a file's module system based on its signals.
 * Returns 'esm', 'cjs', 'mixed', or 'unknown'.
 */
function classifyModuleSystem(signals: ModuleSignals): 'esm' | 'cjs' | 'mixed' | 'unknown' {
  const hasEsm = signals.hasEsmImport || signals.hasEsmExport;
  const hasCjs = signals.hasCjsRequire || signals.hasCjsExports;

  if (hasEsm && hasCjs) return 'mixed';
  if (hasEsm) return 'esm';
  if (hasCjs) return 'cjs';
  return 'unknown';
}

/**
 * Find CJS-style nodes in instrumented code that weren't in the original.
 * Returns line numbers of newly introduced CJS patterns.
 */
function findNewCjsPatterns(
  originalSource: SourceFile,
  instrumentedSource: SourceFile,
): number[] {
  const originalRequireLines = new Set<string>();
  const originalExportLines = new Set<string>();

  // Collect original CJS patterns (by text content for comparison)
  originalSource.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const expr = node.getExpression();
      if (Node.isIdentifier(expr) && expr.getText() === 'require') {
        originalRequireLines.add(node.getText());
      }
    }

    if (Node.isPropertyAccessExpression(node)) {
      const text = node.getText();
      if (text.startsWith('module.exports') || text.startsWith('exports.')) {
        const parent = node.getParent();
        if (parent && Node.isBinaryExpression(parent) && parent.getLeft() === node) {
          originalExportLines.add(text);
        }
      }
    }
  });

  const newCjsLines: number[] = [];

  instrumentedSource.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const expr = node.getExpression();
      if (Node.isIdentifier(expr) && expr.getText() === 'require') {
        const args = node.getArguments();
        if (args.length > 0 && Node.isStringLiteral(args[0])) {
          if (!originalRequireLines.has(node.getText())) {
            newCjsLines.push(node.getStartLineNumber());
          }
        }
      }
    }

    if (Node.isPropertyAccessExpression(node)) {
      const text = node.getText();
      if (text.startsWith('module.exports') || text.startsWith('exports.')) {
        const parent = node.getParent();
        if (parent && Node.isBinaryExpression(parent) && parent.getLeft() === node) {
          if (!originalExportLines.has(text)) {
            newCjsLines.push(node.getStartLineNumber());
          }
        }
      }
    }
  });

  return newCjsLines;
}

/**
 * Find ESM-style nodes in instrumented code that weren't in the original.
 * Returns line numbers of newly introduced ESM patterns.
 */
function findNewEsmPatterns(
  originalSource: SourceFile,
  instrumentedSource: SourceFile,
): number[] {
  const originalImports = new Set(
    originalSource.getImportDeclarations().map(d => d.getModuleSpecifierValue()),
  );

  const newEsmLines: number[] = [];

  for (const imp of instrumentedSource.getImportDeclarations()) {
    if (!originalImports.has(imp.getModuleSpecifierValue())) {
      newEsmLines.push(imp.getStartLineNumber());
    }
  }

  // Check for new export declarations (by text content)
  const originalExportTexts = new Set([
    ...originalSource.getExportDeclarations().map(e => e.getText()),
    ...originalSource.getExportAssignments().map(e => e.getText()),
  ]);

  for (const exp of instrumentedSource.getExportDeclarations()) {
    if (!originalExportTexts.has(exp.getText())) {
      newEsmLines.push(exp.getStartLineNumber());
    }
  }
  for (const exp of instrumentedSource.getExportAssignments()) {
    if (!originalExportTexts.has(exp.getText())) {
      newEsmLines.push(exp.getStartLineNumber());
    }
  }

  // Check for new exported declarations (export function, export class, export const)
  const originalExportedNames = new Set<string>();
  originalSource.forEachChild((node) => {
    if (Node.isExportable(node) && node.isExported()) {
      if ('getName' in node && typeof node.getName === 'function') {
        const name = node.getName();
        if (name) originalExportedNames.add(name);
      }
    }
  });

  instrumentedSource.forEachChild((node) => {
    if (Node.isExportable(node) && node.isExported()) {
      if ('getName' in node && typeof node.getName === 'function') {
        const name = node.getName();
        if (name && !originalExportedNames.has(name)) {
          newEsmLines.push(node.getStartLineNumber());
        }
      }
    }
  });

  return newEsmLines;
}

/**
 * NDS-006: Verify instrumented code uses the same module system as the original.
 *
 * Detects ESM (import/export) vs CJS (require/module.exports) in both the
 * original and instrumented code. Flags when the instrumented output introduces
 * the wrong module system.
 *
 * Cases:
 * - Original is ESM, instrumented adds CJS → failure
 * - Original is CJS, instrumented adds ESM → failure
 * - Original is mixed or unknown → pass (can't enforce)
 * - Same module system → pass
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per mismatch, or a single passing result
 */
export function checkModuleSystemMatch(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });

  const originalSource = project.createSourceFile('original.js', originalCode);
  const instrumentedSource = project.createSourceFile('instrumented.js', instrumentedCode);

  const originalSignals = detectModuleSignals(originalSource);
  const instrumentedSignals = detectModuleSignals(instrumentedSource);

  const originalSystem = classifyModuleSystem(originalSignals);
  const instrumentedSystem = classifyModuleSystem(instrumentedSignals);

  // If original is mixed or unknown, we can't enforce — pass
  if (originalSystem === 'mixed' || originalSystem === 'unknown') {
    return [passingResult(filePath)];
  }

  // If instrumented matches original system (or is unknown/same), pass
  if (
    instrumentedSystem === originalSystem ||
    instrumentedSystem === 'unknown'
  ) {
    return [passingResult(filePath)];
  }

  // Mismatch detected — find the specific offending lines
  const violations: Array<{ line: number; description: string }> = [];

  if (originalSystem === 'esm') {
    // Original is ESM but instrumented introduced CJS
    const newCjsLines = findNewCjsPatterns(originalSource, instrumentedSource);
    for (const line of newCjsLines) {
      violations.push({ line, description: 'CJS require() or module.exports in ESM file' });
    }
    // If we couldn't find specific lines, report file-level
    if (violations.length === 0) {
      violations.push({ line: 0, description: 'CJS patterns introduced in ESM file' });
    }
  } else if (originalSystem === 'cjs') {
    // Original is CJS but instrumented introduced ESM
    const newEsmLines = findNewEsmPatterns(originalSource, instrumentedSource);
    for (const line of newEsmLines) {
      violations.push({ line, description: 'ESM import or export in CJS file' });
    }
    if (violations.length === 0) {
      violations.push({ line: 0, description: 'ESM patterns introduced in CJS file' });
    }
  }

  return violations.map((v) => ({
    ruleId: 'NDS-006',
    passed: false as const,
    filePath,
    lineNumber: v.line > 0 ? v.line : null,
    message:
      `NDS-006: Module system mismatch — original uses ${originalSystem.toUpperCase()}, ` +
      `but instrumented code introduces ${originalSystem === 'esm' ? 'CJS' : 'ESM'} patterns. ` +
      `${v.description}${v.line > 0 ? ` at line ${v.line}` : ''}. ` +
      `Instrumented code must use the same module system as the original file. ` +
      `Use ${originalSystem === 'esm' ? 'import/export' : 'require/module.exports'} for instrumentation additions.`,
    tier: 2 as const,
    blocking: true,
  }));
}

function passingResult(filePath: string): CheckResult {
  return {
    ruleId: 'NDS-006',
    passed: true,
    filePath,
    lineNumber: null,
    message: 'Module system preserved. Instrumented code uses the same module system as the original.',
    tier: 2,
    blocking: true,
  };
}
