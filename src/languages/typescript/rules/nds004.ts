// ABOUTME: NDS-004 TypeScript Tier 2 check — exported function signature preservation.
// ABOUTME: TypeScript-specific version: parses code as TypeScript so type annotations are handled correctly.

import { Project, Node } from 'ts-morph';
import type { SourceFile, FunctionDeclaration, VariableStatement } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';

/**
 * Signature info extracted from an exported function.
 * Parameter names only (type annotations stripped by ts-morph's getName()).
 */
interface ExportedSignature {
  name: string;
  params: string[];
  lineNumber: number;
}

/**
 * Extract exported function signatures from a TypeScript source file.
 * Uses ts-morph's getParameters()[].getName() which strips type annotations,
 * so (req: Request, res: Response) correctly yields ['req', 'res'].
 */
function extractExportedSignatures(sourceFile: SourceFile): ExportedSignature[] {
  const signatures: ExportedSignature[] = [];
  const seen = new Set<string>();

  // ESM: export function declarations (named and default)
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    const name = fn.getName() ?? 'default';
    if (seen.has(name)) continue;
    seen.add(name);
    signatures.push({
      name,
      params: fn.getParameters().map(p => p.getName()),
      lineNumber: fn.getStartLineNumber(),
    });
  }

  // ESM: export const foo = (arrow) => ... or export const foo = function() {}
  for (const stmt of sourceFile.getVariableStatements()) {
    if (!stmt.isExported()) continue;
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;

      const name = decl.getName();
      if (seen.has(name)) continue;

      let params: string[] | undefined;

      if (Node.isArrowFunction(init)) {
        params = init.getParameters().map(p => p.getName());
      } else if (Node.isFunctionExpression(init)) {
        params = init.getParameters().map(p => p.getName());
      }

      if (params !== undefined) {
        seen.add(name);
        signatures.push({
          name,
          params,
          lineNumber: stmt.getStartLineNumber(),
        });
      }
    }
  }

  // ESM: export default () => {} or export default function() {} (ExportAssignment)
  for (const ea of sourceFile.getExportAssignments()) {
    if (ea.isExportEquals()) continue;
    const expr = ea.getExpression();
    let params: string[] | undefined;
    if (Node.isArrowFunction(expr) || Node.isFunctionExpression(expr)) {
      params = expr.getParameters().map(p => p.getName());
    }
    if (params !== undefined && !seen.has('default')) {
      seen.add('default');
      signatures.push({
        name: 'default',
        params,
        lineNumber: expr.getStartLineNumber(),
      });
    }
  }

  return signatures;
}

/**
 * NDS-004 TypeScript: Verify exported function signatures are preserved after instrumentation.
 *
 * TypeScript-specific: uses TypeScript parsing so that type-annotated parameters
 * like `(req: Request, res: Response)` are correctly compared by name only
 * (getName() strips the type annotation). Prevents false positives from
 * instrumented code that preserves parameter names but strips/changes type annotations.
 *
 * @param originalCode - The original TypeScript code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per mismatch, or a single passing result
 */
export function checkExportedSignaturePreservationTs(
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

  const originalSigs = extractExportedSignatures(originalSource);
  const instrumentedSigs = extractExportedSignatures(instrumentedSource);

  if (originalSigs.length === 0) {
    return [passingResult(filePath)];
  }

  const instrumentedByName = new Map<string, ExportedSignature>();
  for (const sig of instrumentedSigs) {
    instrumentedByName.set(sig.name, sig);
  }

  const violations: CheckResult[] = [];

  for (const origSig of originalSigs) {
    const instrSig = instrumentedByName.get(origSig.name);

    if (!instrSig) {
      violations.push({
        ruleId: 'NDS-004',
        passed: false,
        filePath,
        lineNumber: null,
        message:
          `NDS-004: Exported function "${origSig.name}" is missing from instrumented output. ` +
          `Original signature: ${origSig.name}(${origSig.params.join(', ')}). ` +
          `Instrumentation must preserve all exported functions and their signatures.`,
        tier: 2,
        blocking: false,
      });
      continue;
    }

    const origParams = origSig.params;
    const instrParams = instrSig.params;

    if (origParams.length !== instrParams.length ||
        origParams.some((p, i) => p !== instrParams[i])) {
      violations.push({
        ruleId: 'NDS-004',
        passed: false,
        filePath,
        lineNumber: instrSig.lineNumber,
        message:
          `NDS-004: Exported function "${origSig.name}" signature changed. ` +
          `Original: ${origSig.name}(${origParams.join(', ')}), ` +
          `instrumented: ${origSig.name}(${instrParams.join(', ')}). ` +
          `Instrumentation must not add, remove, or rename parameters on exported functions.`,
        tier: 2,
        blocking: false,
      });
    }
  }

  if (violations.length === 0) {
    return [passingResult(filePath)];
  }

  return violations;
}

function passingResult(filePath: string): CheckResult {
  return {
    ruleId: 'NDS-004',
    passed: true,
    filePath,
    lineNumber: null,
    message: 'Exported function signatures preserved. All exported functions maintain their original parameter lists.',
    tier: 2,
    blocking: false,
  };
}

/** NDS-004 TypeScript ValidationRule — exported function signatures must be preserved. */
export const nds004TsRule: ValidationRule = {
  ruleId: 'NDS-004',
  dimension: 'Non-destructive',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'typescript';
  },
  check(input) {
    return checkExportedSignaturePreservationTs(input.originalCode, input.instrumentedCode, input.filePath);
  },
};
