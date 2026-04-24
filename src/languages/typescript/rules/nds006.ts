// ABOUTME: NDS-006 TypeScript Tier 2 check — module system preservation.
// ABOUTME: TypeScript-specific version: uses TypeScript parsing for correct ESM/CJS detection.

import { Project, Node } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';

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
 * Detect module system signals in a TypeScript source file.
 * TypeScript files use ESM (import/export) natively. CJS patterns (require/module.exports)
 * are unusual in TypeScript but possible in .ts files targeting CommonJS output.
 */
function detectModuleSignals(sourceFile: SourceFile): ModuleSignals {
  const signals: ModuleSignals = {
    hasEsmImport: false,
    hasEsmExport: false,
    hasCjsRequire: false,
    hasCjsExports: false,
  };

  // ESM imports (includes `import type { }` declarations)
  if (sourceFile.getImportDeclarations().length > 0) {
    signals.hasEsmImport = true;
  }

  // ESM exports: explicit export declarations, export assignments, and
  // functions/classes/variables with the export keyword.
  if (
    sourceFile.getExportDeclarations().length > 0 ||
    sourceFile.getExportAssignments().length > 0
  ) {
    signals.hasEsmExport = true;
  }

  sourceFile.forEachChild((node) => {
    if (Node.isExportable(node) && node.isExported()) {
      signals.hasEsmExport = true;
    }
  });

  // CJS require() and module.exports / exports.prop
  sourceFile.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const expr = node.getExpression();
      if (Node.isIdentifier(expr) && expr.getText() === 'require') {
        const args = node.getArguments();
        if (args.length > 0 && Node.isStringLiteral(args[0])) {
          signals.hasCjsRequire = true;
        }
      }
    }

    if (Node.isPropertyAccessExpression(node)) {
      const text = node.getText();
      if (text.startsWith('module.exports') || text.startsWith('exports.')) {
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
 */
function findNewCjsPatterns(
  originalSource: SourceFile,
  instrumentedSource: SourceFile,
): number[] {
  const originalRequireLines = new Set<string>();
  const originalExportLines = new Set<string>();

  originalSource.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const expr = node.getExpression();
      if (Node.isIdentifier(expr) && expr.getText() === 'require') {
        const args = node.getArguments();
        if (args.length > 0 && Node.isStringLiteral(args[0])) {
          originalRequireLines.add(node.getText());
        }
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
 * NDS-006 TypeScript: Verify instrumented code uses the same module system as the original.
 *
 * @param originalCode - The original TypeScript code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 */
export function checkModuleSystemMatchTs(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const project = new Project({
    compilerOptions: {
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    useInMemoryFileSystem: true,
  });

  const originalSource = project.createSourceFile('original.tsx', originalCode);
  const instrumentedSource = project.createSourceFile('instrumented.tsx', instrumentedCode);

  const originalSignals = detectModuleSignals(originalSource);
  const instrumentedSignals = detectModuleSignals(instrumentedSource);

  const originalSystem = classifyModuleSystem(originalSignals);
  const instrumentedSystem = classifyModuleSystem(instrumentedSignals);

  if (originalSystem === 'mixed' || originalSystem === 'unknown') {
    return [passingResult(filePath)];
  }

  if (instrumentedSystem === originalSystem) {
    return [passingResult(filePath)];
  }

  if (instrumentedSystem === 'unknown') {
    return [{
      ruleId: 'NDS-006',
      passed: false as const,
      filePath,
      lineNumber: null,
      message:
        `NDS-006: Module system signal lost — original uses ${originalSystem.toUpperCase()}, ` +
        `but instrumented code has no module system signals. ` +
        `Instrumentation may have removed exports or imports. ` +
        `Preserve the original file's ${originalSystem === 'esm' ? 'import/export' : 'require/module.exports'} patterns.`,
      tier: 2 as const,
      blocking: false,
    }];
  }

  const violations: Array<{ line: number | null; description: string }> = [];

  if (originalSystem === 'esm') {
    const newCjsLines = findNewCjsPatterns(originalSource, instrumentedSource);
    for (const line of newCjsLines) {
      violations.push({ line, description: 'CJS require() or module.exports in ESM file' });
    }
    if (violations.length === 0) {
      violations.push({ line: null, description: 'CJS patterns introduced in ESM file' });
    }
  } else if (originalSystem === 'cjs') {
    const newEsmLines = findNewEsmPatterns(originalSource, instrumentedSource);
    for (const line of newEsmLines) {
      violations.push({ line, description: 'ESM import or export in CJS file' });
    }
    if (violations.length === 0) {
      violations.push({ line: null, description: 'ESM patterns introduced in CJS file' });
    }
  }

  return violations.map((v) => ({
    ruleId: 'NDS-006',
    passed: false as const,
    filePath,
    lineNumber: v.line != null && v.line > 0 ? v.line : null,
    message:
      `NDS-006: Module system mismatch — original uses ${originalSystem.toUpperCase()}, ` +
      `but instrumented code introduces ${originalSystem === 'esm' ? 'CJS' : 'ESM'} patterns. ` +
      `${v.description}${v.line != null && v.line > 0 ? ` at line ${v.line}` : ''}. ` +
      `Instrumented code must use the same module system as the original file. ` +
      `Use ${originalSystem === 'esm' ? 'import/export' : 'require/module.exports'} for instrumentation additions.`,
    tier: 2 as const,
    blocking: false,
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
    blocking: false,
  };
}

/** NDS-006 TypeScript ValidationRule — instrumented code must use the same module system as the original. */
export const nds006TsRule: ValidationRule = {
  ruleId: 'NDS-006',
  dimension: 'Non-destructive',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'typescript';
  },
  check(input) {
    return checkModuleSystemMatchTs(input.originalCode, input.instrumentedCode, input.filePath);
  },
};
