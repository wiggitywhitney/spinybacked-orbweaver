// ABOUTME: COV-005 Tier 2 check — domain-specific attributes present.
// ABOUTME: Compares setAttribute calls against registry-defined required/recommended attributes per span.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../types.ts';

/**
 * Registry definition for a single span — what attributes it should have.
 * Populated from the Weaver telemetry registry (Phase 5 provides the resolver).
 */
export interface RegistrySpanDefinition {
  spanName: string;
  requiredAttributes: string[];
  recommendedAttributes: string[];
}

interface SpanAttributeGap {
  spanName: string;
  line: number;
  missingRequired: string[];
  missingRecommended: string[];
}

/**
 * COV-005: Verify that spans have domain-specific attributes from the registry.
 *
 * For each span in the code that has a matching registry definition, checks
 * whether all required and recommended attributes are present via setAttribute calls.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param registry - Registry span definitions with required/recommended attributes
 * @returns CheckResult with ruleId "COV-005", tier 2, blocking false
 */
export function checkDomainAttributes(
  code: string,
  filePath: string,
  registry: RegistrySpanDefinition[],
): CheckResult {
  if (registry.length === 0) {
    return {
      ruleId: 'COV-005',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No registry definitions to check against.',
      tier: 2,
      blocking: false,
    };
  }

  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  // Build a lookup from span name to registry definition
  const registryByName = new Map<string, RegistrySpanDefinition>();
  for (const def of registry) {
    registryByName.set(def.spanName, def);
  }

  const gaps: SpanAttributeGap[] = [];

  // Find all startActiveSpan/startSpan calls
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    const text = expr.getText();

    if (!text.endsWith('.startActiveSpan') && !text.endsWith('.startSpan')) return;

    const spanName = getSpanNameLiteral(node);
    if (!spanName) return;

    const def = registryByName.get(spanName);
    if (!def) return;

    // Collect setAttribute calls within this span's scope
    const setAttributes = collectSetAttributes(node);

    const missingRequired = def.requiredAttributes.filter(
      (attr) => !setAttributes.has(attr),
    );
    const missingRecommended = def.recommendedAttributes.filter(
      (attr) => !setAttributes.has(attr),
    );

    if (missingRequired.length > 0 || missingRecommended.length > 0) {
      gaps.push({
        spanName,
        line: node.getStartLineNumber(),
        missingRequired,
        missingRecommended,
      });
    }
  });

  if (gaps.length === 0) {
    return {
      ruleId: 'COV-005',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All spans have required domain-specific attributes from the registry.',
      tier: 2,
      blocking: false,
    };
  }

  const firstGap = gaps[0];
  const details = gaps
    .map((g) => {
      const parts: string[] = [];
      if (g.missingRequired.length > 0) {
        parts.push(`required: ${g.missingRequired.join(', ')}`);
      }
      if (g.missingRecommended.length > 0) {
        parts.push(`recommended: ${g.missingRecommended.join(', ')}`);
      }
      return `  - "${g.spanName}" at line ${g.line}: missing ${parts.join('; ')}`;
    })
    .join('\n');

  return {
    ruleId: 'COV-005',
    passed: false,
    filePath,
    lineNumber: firstGap.line,
    message:
      `COV-005 advisory: ${gaps.length} span(s) missing domain-specific attributes from the registry.\n` +
      `${details}\n` +
      `The telemetry registry defines required and recommended attributes for these spans. ` +
      `Add the missing setAttribute() calls to improve trace quality.`,
    tier: 2,
    blocking: false,
  };
}

/**
 * Extract the span name as a string literal from a startActiveSpan/startSpan call.
 * Returns null if the first argument is not a string literal.
 */
function getSpanNameLiteral(callExpr: CallExpression): string | null {
  const args = callExpr.getArguments();
  if (args.length === 0) return null;

  const firstArg = args[0];
  if (Node.isStringLiteral(firstArg)) {
    return firstArg.getLiteralValue();
  }
  return null;
}

/**
 * Collect all setAttribute attribute name arguments within a span's scope.
 * For startActiveSpan, searches the callback body.
 * For startSpan, searches sibling statements in the same block.
 */
function collectSetAttributes(spanCall: CallExpression): Set<string> {
  const attributes = new Set<string>();

  const exprText = spanCall.getExpression().getText();

  if (exprText.endsWith('.startActiveSpan')) {
    // Search within callback arguments
    for (const arg of spanCall.getArguments()) {
      if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
        arg.forEachDescendant((desc) => {
          if (Node.isCallExpression(desc)) {
            const attrName = extractSetAttributeName(desc);
            if (attrName) attributes.add(attrName);
          }
        });
      }
    }
  } else if (exprText.endsWith('.startSpan')) {
    // Walk up to the nearest containing block or source file
    let containingBlock: Node | undefined;
    let ancestorStatement: Node | undefined;
    let current: Node | undefined = spanCall;
    while (current) {
      const parent = current.getParent();
      if (parent && (Node.isBlock(parent) || Node.isSourceFile(parent))) {
        containingBlock = parent;
        ancestorStatement = current;
        break;
      }
      current = parent;
    }

    if (containingBlock && ancestorStatement && (Node.isBlock(containingBlock) || Node.isSourceFile(containingBlock))) {
      const statements = containingBlock.getStatements();
      const declIndex = statements.findIndex(s => s === ancestorStatement);
      if (declIndex >= 0) {
        for (let i = declIndex + 1; i < statements.length; i++) {
          statements[i].forEachDescendant((desc) => {
            if (Node.isCallExpression(desc)) {
              const attrName = extractSetAttributeName(desc);
              if (attrName) attributes.add(attrName);
            }
          });
        }
      }
    }
  }

  return attributes;
}

/**
 * Extract the attribute name from a span.setAttribute("name", value) call.
 * Returns null if this is not a setAttribute call or the first arg is not a string literal.
 */
function extractSetAttributeName(callExpr: CallExpression): string | null {
  const expr = callExpr.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return null;
  if (expr.getName() !== 'setAttribute') return null;

  const args = callExpr.getArguments();
  if (args.length < 2) return null;

  const firstArg = args[0];
  if (Node.isStringLiteral(firstArg)) {
    return firstArg.getLiteralValue();
  }
  return null;
}
