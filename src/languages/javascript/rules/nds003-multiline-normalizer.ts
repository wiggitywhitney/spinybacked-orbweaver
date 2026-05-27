// ABOUTME: NDS-003 pre-processing step — resets multiLine flags on object/array literal AST nodes.
// ABOUTME: Applied before Prettier normalization so both sides of the diff normalize identically.

import { ts } from 'ts-morph';

/**
 * Reset the multiLine flag on all ObjectLiteralExpression and ArrayLiteralExpression
 * nodes in the given JavaScript/TypeScript source code to false (inline form).
 *
 * This is a pre-processing step for NDS-003 comparison. After this transform,
 * both the original code and the OTel-stripped instrumented code are Prettier-
 * normalized — the multiLine=false flags ensure Prettier sees inline intent on
 * both sides and produces consistent output regardless of how the agent formatted
 * object/array literals.
 *
 * Uses the TypeScript compiler transformer API (ts.transform + ts.factory).
 * Does NOT use ts-morph node.replaceWithText() — mutation-during-walk produces
 * undefined behavior when iterating descendants.
 *
 * Method chain trivia normalization is explicitly out of scope: method chain
 * reformatting comes from leading trivia on dot tokens, a different mechanism
 * not addressed here. See docs/architecture/nds003-ast-printing-research.md §4.
 *
 * @param code - JavaScript or TypeScript source code
 * @returns Source code with all object/array literal multiLine flags reset to false
 */
export function normalizeMultiLineFlags(code: string): string {
  const sourceFile = ts.createSourceFile(
    'f.js',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit: ts.Visitor = (node) => {
      // Bottom-up: visit children first so nested literals are normalized before their parent.
      const visited = ts.visitEachChild(node, visit, context);

      if (ts.isObjectLiteralExpression(visited)) {
        return ts.factory.createObjectLiteralExpression(
          (visited as ts.ObjectLiteralExpression).properties,
          false,
        );
      }
      if (ts.isArrayLiteralExpression(visited)) {
        return ts.factory.createArrayLiteralExpression(
          (visited as ts.ArrayLiteralExpression).elements,
          false,
        );
      }
      return visited;
    };
    return (sf) => ts.visitNode(sf, visit) as ts.SourceFile;
  };

  const result = ts.transform(sourceFile, [transformer]);
  try {
    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    return printer.printFile(result.transformed[0]);
  } finally {
    result.dispose();
  }
}
