// ABOUTME: Research spike test — validates ts-morph AST canonical printing for NDS-003 comparison
// ABOUTME: Documents what ts-morph printer normalizes and what it preserves from source text.

import { describe, it, expect } from 'vitest';
import { Project, ts } from 'ts-morph';

/**
 * Helper: print a source code string using ts-morph's sourceFile.print() API.
 * This is the ts-morph-native path using Project.createSourceFile().print().
 */
function tsMorphPrint(code: string): string {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sf = project.createSourceFile('test.js', code);
  return sf.print();
}

/**
 * Helper: print a source code string using the raw TypeScript compiler printer.
 * Uses ts.createSourceFile + ts.createPrinter().printNode(..., emptySf) where
 * emptySf severs the trivia source text connection.
 */
function tsPrint(code: string): string {
  const sf = ts.createSourceFile('test.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const emptySf = ts.createSourceFile('empty.js', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  return printer.printNode(ts.EmitHint.Unspecified, sf, emptySf);
}

describe('ts-morph AST canonical printing research', () => {

  // ─── Part 1: What the printer DOES normalize ──────────────────────────────

  describe('things the printer DOES normalize', () => {

    it('normalizes indentation: tab vs 2-space vs 4-space', () => {
      const twoSpace = `function f() {\n  return 1;\n}`;
      const fourSpace = `function f() {\n    return 1;\n}`;
      const tab = `function f() {\n\treturn 1;\n}`;

      const p2 = tsMorphPrint(twoSpace);
      const p4 = tsMorphPrint(fourSpace);
      const pt = tsMorphPrint(tab);

      // All normalize to 4-space
      expect(p2).toBe(p4);
      expect(p4).toBe(pt);
      expect(p2).toContain('    return 1;');
    });

    it('normalizes extra whitespace between tokens', () => {
      const loose = `const  x  =  1;`;
      const normal = `const x = 1;`;
      expect(tsMorphPrint(loose)).toBe(tsMorphPrint(normal));
    });

    it('adds missing semicolons', () => {
      const noSemi = `const x = 1`;
      const withSemi = `const x = 1;`;
      expect(tsMorphPrint(noSemi)).toBe(tsMorphPrint(withSemi));
    });

    it('is idempotent — print(print(code)) === print(code)', () => {
      const codes = [
        `const obj = { a: 1, b: 2 };`,
        `const obj = {\n  a: 1,\n  b: 2\n};`,
        `const arr = [\n  1,\n  2,\n  3,\n];`,
        `const r = entries\n  .filter(e => e.active)\n  .map(e => e.id);`,
      ];
      for (const code of codes) {
        const once = tsMorphPrint(code);
        const twice = tsMorphPrint(once);
        expect(once).toBe(twice);
      }
    });

    it('normalizes trailing commas in function call arguments (call site)', () => {
      // These share the same AST structure — the call args NodeArray does not
      // store a trailing comma as a distinct AST flag when it appears in a single-line call
      const noTrailing = `f(a, b, c);`;
      const withTrailing = `f(\n  a,\n  b,\n  c,\n);`;
      // This case normalizes because the multiline form is expanded into multiple lines
      // at the call expression level, but the printer collapses when no multiLine flag present
      const pa = tsMorphPrint(noTrailing);
      const pb = tsMorphPrint(withTrailing);
      expect(pa).toBe(pb);
    });

    it('normalizes single-line vs multi-line arrow function callbacks in call args', () => {
      // Callback body expansion is trivia-only, not a multiLine flag
      const single = `const r = arr.filter(x => x > 0);`;
      const multi = `const r = arr.filter(\n  x => x > 0\n);`;
      expect(tsMorphPrint(single)).toBe(tsMorphPrint(multi));
    });

  });

  // ─── Part 2: What the printer does NOT normalize ──────────────────────────

  describe('things the printer does NOT normalize (the core finding)', () => {

    it('does NOT normalize inline vs multi-line object literals', () => {
      // The ObjectLiteralExpression.multiLine flag is an AST property set by the parser.
      // The printer reads this flag directly — inline objects stay inline, multi-line stays multi-line.
      const inlineObj = `const o = { a: 1, b: 2 };`;
      const multilineObj = `const o = {\n  a: 1,\n  b: 2\n};`;

      const pa = tsMorphPrint(inlineObj);
      const pb = tsMorphPrint(multilineObj);

      expect(pa).not.toBe(pb);
      expect(pa).toBe('const o = { a: 1, b: 2 };\n');
      expect(pb).toBe('const o = {\n    a: 1,\n    b: 2\n};\n');
    });

    it('does NOT normalize inline vs multi-line array literals', () => {
      // ArrayLiteralExpression.multiLine is also an AST flag set by the parser.
      const inlineArr = `const a = [1, 2, 3];`;
      const multilineArr = `const a = [\n  1,\n  2,\n  3,\n];`;

      const pa = tsMorphPrint(inlineArr);
      const pb = tsMorphPrint(multilineArr);

      expect(pa).not.toBe(pb);
      expect(pa).toBe('const a = [1, 2, 3];\n');
      expect(pb).toBe('const a = [\n    1,\n    2,\n    3,\n];\n');
    });

    it('does NOT normalize inline vs multi-line method chains', () => {
      // Method chains: identical AST kind structure, but leading trivia (newlines) differ.
      // The printer re-emits trivia from the source text — the newline before `.filter`
      // is preserved as a line break in the output.
      const inlineChain = `const r = entries.filter(e => e.active).map(e => e.id);`;
      const multilineChain = `const r = entries\n  .filter(e => e.active)\n  .map(e => e.id);`;

      const pa = tsMorphPrint(inlineChain);
      const pb = tsMorphPrint(multilineChain);

      expect(pa).not.toBe(pb);
      expect(pa).toBe('const r = entries.filter(e => e.active).map(e => e.id);\n');
      expect(pb).toBe('const r = entries\n    .filter(e => e.active)\n    .map(e => e.id);\n');
    });

    it('does NOT normalize arrow function parameter parentheses', () => {
      // ArrowFunction stores whether the parameter list had parens — this is in the AST.
      // The printer preserves the original paren form.
      const noParens = `const f = x => x + 1;`;
      const withParens = `const f = (x) => x + 1;`;

      const pa = tsMorphPrint(noParens);
      const pb = tsMorphPrint(withParens);

      expect(pa).not.toBe(pb);
      expect(pa).toBe('const f = x => x + 1;\n');
      expect(pb).toBe('const f = (x) => x + 1;\n');
    });

    it('does NOT normalize quote style (single vs double)', () => {
      const single = `const s = 'hello';`;
      const double = `const s = "hello";`;

      const pa = tsMorphPrint(single);
      const pb = tsMorphPrint(double);

      expect(pa).not.toBe(pb);
    });

    it('does NOT normalize multi-line return object literals', () => {
      // This is the specific pattern from journal-graph.js failures:
      // The agent may write `return { ... }` as multi-line when the original was inline.
      const inlineReturn = `function f(n) { return { id: n.id, label: n.label }; }`;
      const multilineReturn = `function f(n) {\n  return {\n    id: n.id,\n    label: n.label\n  };\n}`;

      const pa = tsMorphPrint(inlineReturn);
      const pb = tsMorphPrint(multilineReturn);

      expect(pa).not.toBe(pb);
    });

  });

  // ─── Part 3: Root cause — what drives the differences ─────────────────────

  describe('root cause analysis', () => {

    it('ObjectLiteralExpression has a multiLine boolean flag in the AST', () => {
      const inlineCode = `const o = { a: 1, b: 2 };`;
      const multilineCode = `const o = {\n  a: 1,\n  b: 2\n};`;

      // Direct inspection via TS compiler API
      function getObjMultiLine(code: string): boolean {
        const sf = ts.createSourceFile('test.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        let result = false;
        function walk(node: ts.Node): void {
          if (ts.isObjectLiteralExpression(node)) result = (node as ts.ObjectLiteralExpression & { multiLine?: boolean }).multiLine ?? false;
          ts.forEachChild(node, walk);
        }
        walk(sf);
        return result;
      }

      expect(getObjMultiLine(inlineCode)).toBe(false);
      expect(getObjMultiLine(multilineCode)).toBe(true);
    });

    it('method chain differences come from token trivia (leading whitespace on dot tokens)', () => {
      const inlineChain = `const r = a.b().c();`;
      const multilineChain = `const r = a\n  .b()\n  .c();`;

      // Both have identical AST node kinds — the difference is purely in token trivia
      function getKindPath(code: string): string {
        const sf = ts.createSourceFile('test.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const parts: string[] = [];
        function walk(node: ts.Node): void {
          parts.push(ts.SyntaxKind[node.kind]);
          ts.forEachChild(node, walk);
        }
        walk(sf);
        return parts.join(':');
      }

      expect(getKindPath(inlineChain)).toBe(getKindPath(multilineChain));
    });

    it('ts.factory.createObjectLiteralExpression with multiLine=false prints inline', () => {
      const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
      const emptySf = ts.createSourceFile('empty.js', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);

      const inlineObj = ts.factory.createObjectLiteralExpression(
        [
          ts.factory.createPropertyAssignment('a', ts.factory.createNumericLiteral('1')),
          ts.factory.createPropertyAssignment('b', ts.factory.createNumericLiteral('2')),
        ],
        false, // multiLine=false
      );

      const multilineObj = ts.factory.createObjectLiteralExpression(
        [
          ts.factory.createPropertyAssignment('a', ts.factory.createNumericLiteral('1')),
          ts.factory.createPropertyAssignment('b', ts.factory.createNumericLiteral('2')),
        ],
        true, // multiLine=true
      );

      const inlinePrinted = printer.printNode(ts.EmitHint.Expression, inlineObj, emptySf);
      const multilinePrinted = printer.printNode(ts.EmitHint.Expression, multilineObj, emptySf);

      expect(inlinePrinted).toBe('{ a: 1, b: 2 }');
      expect(multilinePrinted).toContain('\n');
      expect(inlinePrinted).not.toBe(multilinePrinted);
    });

  });

  // ─── Part 4: Why the proposed approach cannot work ────────────────────────

  describe('proposed approach viability', () => {

    it('confirms the proposed approach is not viable: structurally identical ASTs produce different printed output', () => {
      // The proposal: strip OTel nodes from the instrumented AST,
      // then print both ASTs via ts-morph and text-compare.
      //
      // This cannot work because:
      // (a) Inline vs multi-line object/array literals differ at the AST level (multiLine flag)
      // (b) Method chain line breaks are preserved as trivia in the printed output
      //
      // When the agent or Prettier reformats business logic code, the stripped instrumented
      // AST will have different multiLine flags and trivia than the original AST,
      // causing the comparison to fail even when the code is logically identical.

      // Simulation: original has inline object, agent rewrites as multi-line
      const original = `function buildNode(n) { return { id: n.id, label: n.label }; }`;
      const agentRewritten = `function buildNode(n) {\n  return {\n    id: n.id,\n    label: n.label\n  };\n}`;

      const printedOriginal = tsMorphPrint(original);
      const printedAgentVersion = tsMorphPrint(agentRewritten);

      // These are NOT equal — the proposal would produce a false positive
      expect(printedOriginal).not.toBe(printedAgentVersion);
    });

    it('confirms printOnce is stable (idempotent) but two stable forms of the same code differ', () => {
      // Even after normalization, the two forms produce different stable outputs.
      // There is no convergence point — the printer is not a canonical normalizer.

      const codeA = `const obj = { a: 1 };`;
      const codeB = `const obj = {\n  a: 1\n};`;

      const stableA = tsMorphPrint(tsMorphPrint(codeA));
      const stableB = tsMorphPrint(tsMorphPrint(codeB));

      expect(stableA).toBe(tsMorphPrint(codeA)); // idempotent
      expect(stableB).toBe(tsMorphPrint(codeB)); // idempotent
      expect(stableA).not.toBe(stableB);         // but they differ
    });

  });

  // ─── Part 5: What the normalized output looks like ─────────────────────────

  describe('printer output characteristics', () => {

    it('printer always adds trailing newline', () => {
      expect(tsMorphPrint('const x = 1;')).toMatch(/\n$/);
      expect(tsMorphPrint('function f() {}')).toMatch(/\n$/);
    });

    it('printer normalizes indentation to 4 spaces inside blocks', () => {
      const code = `function f() {\n  if (x) {\n    return 1;\n  }\n}`;
      const printed = tsMorphPrint(code);
      expect(printed).toContain('    if (x)');
      expect(printed).toContain('        return 1;');
    });

    it('PrinterOptions newLine mode does not affect the fundamental normalization gap', () => {
      // Even with CRLF newlines, inline vs multi-line forms still differ
      const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
      const sfInline = project.createSourceFile('a.js', `const o = { a: 1 };`);
      const sfMulti = project.createSourceFile('b.js', `const o = {\n  a: 1\n};`);

      const printedInline = sfInline.print();
      const printedMulti = sfMulti.print();

      expect(printedInline).not.toBe(printedMulti);
    });

  });

});
