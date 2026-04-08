// ABOUTME: NDS-004 Tier 2 check — exported function signature preservation.
// ABOUTME: Detects when instrumented code adds, removes, or renames parameters on exported functions.

import { Project, Node } from 'ts-morph';
import type { SourceFile, FunctionDeclaration, VariableStatement } from 'ts-morph';
import type { CheckResult } from '../types.ts';

/**
 * Signature info extracted from an exported function.
 */
interface ExportedSignature {
  name: string;
  params: string[];
  lineNumber: number;
}

/**
 * Extract exported function signatures from a source file.
 *
 * Covers:
 * - `export function foo(a, b) {}`
 * - `export default function foo(a, b) {}`
 * - `export const foo = (a, b) => ...`
 * - `export const foo = function(a, b) {}`
 * - `exports.foo = function(a, b) {}`
 * - `module.exports = { foo }` where foo is a function declaration
 * - `module.exports.foo = function(a, b) {}`
 */
function extractExportedSignatures(sourceFile: SourceFile): ExportedSignature[] {
  const signatures: ExportedSignature[] = [];
  const seen = new Set<string>();

  // ESM: export function declarations (named and default)
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    const name = fn.getName() ?? '<default>';
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

  // CJS: exports.foo = function(a, b) {} or module.exports.foo = function(a, b) {}
  sourceFile.forEachDescendant((node) => {
    if (!Node.isBinaryExpression(node)) return;

    const left = node.getLeft();
    if (!Node.isPropertyAccessExpression(left)) return;

    const leftText = left.getText();
    let exportName: string | undefined;

    // exports.foo = ... or module.exports.foo = ...
    // Use AST property name to avoid misparse of nested paths like exports.foo.bar
    const receiver = left.getExpression();
    const propName = left.getName();
    if (receiver.getText() === 'exports' && propName !== 'default') {
      exportName = propName;
    } else if (receiver.getText() === 'module.exports') {
      exportName = propName;
    }

    if (!exportName || seen.has(exportName)) return;

    const right = node.getRight();
    let params: string[] | undefined;

    if (Node.isFunctionExpression(right)) {
      params = right.getParameters().map(p => p.getName());
    } else if (Node.isArrowFunction(right)) {
      params = right.getParameters().map(p => p.getName());
    }

    if (params !== undefined) {
      seen.add(exportName);
      signatures.push({
        name: exportName,
        params,
        lineNumber: node.getStartLineNumber(),
      });
    }
  });

  // CJS: module.exports = { foo } — resolve foo to its function declaration
  sourceFile.forEachDescendant((node) => {
    if (!Node.isBinaryExpression(node)) return;

    const left = node.getLeft();
    if (!Node.isPropertyAccessExpression(left)) return;
    if (left.getText() !== 'module.exports') return;

    const right = node.getRight();
    if (!Node.isObjectLiteralExpression(right)) return;

    for (const prop of right.getProperties()) {
      if (Node.isShorthandPropertyAssignment(prop)) {
        const name = prop.getName();
        if (seen.has(name)) continue;

        // Find the corresponding function declaration or variable-assigned function
        const fn = sourceFile.getFunction(name);
        if (fn) {
          seen.add(name);
          signatures.push({
            name,
            params: fn.getParameters().map(p => p.getName()),
            lineNumber: fn.getStartLineNumber(),
          });
        } else {
          const varDecl = sourceFile.getVariableDeclaration(name);
          if (varDecl) {
            const varInit = varDecl.getInitializer();
            if (varInit && (Node.isArrowFunction(varInit) || Node.isFunctionExpression(varInit))) {
              seen.add(name);
              signatures.push({
                name,
                params: varInit.getParameters().map(p => p.getName()),
                lineNumber: varDecl.getStartLineNumber(),
              });
            }
          }
        }
      } else if (Node.isPropertyAssignment(prop)) {
        const name = prop.getName();
        if (seen.has(name)) continue;

        const init = prop.getInitializer();
        if (!init) continue;

        let params: string[] | undefined;
        if (Node.isFunctionExpression(init)) {
          params = init.getParameters().map(p => p.getName());
        } else if (Node.isArrowFunction(init)) {
          params = init.getParameters().map(p => p.getName());
        } else if (Node.isIdentifier(init)) {
          // module.exports = { foo: foo } — resolve to function declaration or variable-assigned function
          const fn = sourceFile.getFunction(init.getText());
          if (fn) {
            params = fn.getParameters().map(p => p.getName());
          } else {
            const varDecl = sourceFile.getVariableDeclaration(init.getText());
            if (varDecl) {
              const varInit = varDecl.getInitializer();
              if (varInit && (Node.isArrowFunction(varInit) || Node.isFunctionExpression(varInit))) {
                params = varInit.getParameters().map(p => p.getName());
              }
            }
          }
        }

        if (params !== undefined) {
          seen.add(name);
          signatures.push({
            name,
            params,
            lineNumber: prop.getStartLineNumber(),
          });
        }
      }
    }
  });

  // ESM: export default () => {} or export default function() {} (ExportAssignment)
  for (const ea of sourceFile.getExportAssignments()) {
    if (ea.isExportEquals()) continue; // skip module.exports = ... handled above
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
 * NDS-004: Verify exported function signatures are preserved after instrumentation.
 *
 * Compares the parameter lists of all exported functions in the original code
 * against the instrumented output. Flags:
 * - Parameters added (e.g., span injected into signature)
 * - Parameters removed
 * - Parameters renamed
 * - Exported functions removed entirely
 *
 * Advisory-only (blocking: false) — AST diffing may produce false positives
 * when instrumentation legitimately restructures code.
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per mismatch, or a single passing result
 */
export function checkExportedSignaturePreservation(
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

  const originalSigs = extractExportedSignatures(originalSource);
  const instrumentedSigs = extractExportedSignatures(instrumentedSource);

  // No exported functions in original — nothing to violate
  if (originalSigs.length === 0) {
    return [passingResult(filePath)];
  }

  // Build a map of instrumented signatures by name for lookup
  const instrumentedByName = new Map<string, ExportedSignature>();
  for (const sig of instrumentedSigs) {
    instrumentedByName.set(sig.name, sig);
  }

  const violations: CheckResult[] = [];

  for (const origSig of originalSigs) {
    const instrSig = instrumentedByName.get(origSig.name);

    if (!instrSig) {
      // Exported function removed entirely
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

    // Compare parameter lists
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
