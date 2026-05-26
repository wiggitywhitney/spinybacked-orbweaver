# NDS-003 AST Canonical Printing Research

**Date**: 2026-05-26
**Spike goal**: Determine whether ts-morph's printer can produce canonical, normalized output from structurally equivalent ASTs — so that NDS-003 can replace Prettier normalization with AST-level comparison.

---

## 1. Answer to the Research Question

**No. ts-morph's printer (and the underlying TypeScript compiler printer) cannot produce identical output from logically equivalent but differently-formatted source code.**

The printer is a *trivia-preserving re-emitter*, not a canonical normalizer. It preserves original source formatting through two mechanisms:

- **AST flags**: `ObjectLiteralExpression.multiLine` and `ArrayLiteralExpression.multiLine` are boolean flags set by the parser based on whether the source contains newlines inside the literal. The printer reads these flags directly and produces inline or multi-line output accordingly. Two syntactically identical object literals — one written inline, one written multi-line — produce different printed output.

- **Token trivia**: Leading and trailing whitespace (including newlines) on each token is stored as *trivia* in the AST and re-emitted verbatim by the printer. Method chains split across lines (`.filter()\n  .map()`) have leading newline trivia on the dot tokens, which the printer faithfully re-emits. Both the inline and multi-line forms have identical AST *kind* sequences but different trivia, producing different output.

Experimentally confirmed:

| Pattern | Example A | Example B | Same output? |
|---|---|---|---|
| Inline vs multi-line object literal | `{ a: 1, b: 2 }` | `{\n  a: 1,\n  b: 2\n}` | **No** |
| Inline vs multi-line array literal | `[1, 2, 3]` | `[\n  1,\n  2,\n  3,\n]` | **No** |
| Inline vs multi-line method chain | `a.b().c()` | `a\n  .b()\n  .c()` | **No** |
| Arrow param parens | `x => x` | `(x) => x` | **No** |
| Single vs double quotes | `'hello'` | `"hello"` | **No** |
| Multi-line return object | `return { a: 1 }` | `return {\n  a: 1\n}` | **No** |

The printer *does* normalize: indentation depth (all forms normalize to 4-space), missing semicolons, extra whitespace between tokens. It is also idempotent: `print(print(x)) === print(x)` for all tested inputs. But two stable printed forms of the same code can differ.

---

## 2. Prototype Code

The minimal invocation that demonstrates what the printer does and does not normalize:

```typescript
import { Project, ts } from 'ts-morph';

// ts-morph path
function tsMorphPrint(code: string): string {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sf = project.createSourceFile('test.js', code);
  return sf.print();
}

// Direct TS compiler path (does not change the result)
function tsPrint(code: string): string {
  const sf = ts.createSourceFile('test.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const emptySf = ts.createSourceFile('empty.js', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  return printer.printNode(ts.EmitHint.Unspecified, sf, emptySf);
}

// Demonstrating the problem:
tsMorphPrint(`const o = { a: 1 };`)    // → "const o = { a: 1 };\n"
tsMorphPrint(`const o = {\n  a: 1\n}`) // → "const o = {\n    a: 1\n};\n"  ← DIFFERENT
```

Alternative approaches investigated and ruled out:

- **Passing an empty source file as trivia source** (`printer.printNode(hint, node, emptySf)`): does not help because `ObjectLiteralExpression.multiLine` is an AST flag, not trivia. The flag drives the printer regardless of the trivia source.

- **`ts.transform` to rebuild nodes**: `ts.factory.updateObjectLiteralExpression` preserves the original `multiLine` flag. Using `ts.factory.createObjectLiteralExpression` with `multiLine=false` strips the flag but the children retain their original trivia from the parent source file's text positions, producing mixed results.

- **Two-round re-parse** (`print → re-parse → print`): the printer is idempotent within a round-trip, but two round-trips from differently-formatted source still converge to different stable forms. There is no shared convergence point.

---

## 3. The Proposed Comparison Algorithm

The proposed algorithm — strip OTel → print both ASTs via ts-morph → text compare — is not viable as stated. See section 4 for why.

A variant that *would* be theoretically viable would require a full normalization transform before printing:

1. Parse both the original and stripped-instrumented code into ASTs.
2. Apply a recursive transform that:
   - Sets `multiLine=false` on all `ObjectLiteralExpression` and `ArrayLiteralExpression` nodes using `ts.factory.createObjectLiteralExpression(properties, false)`.
   - Strips all leading trivia from all tokens (removes newlines that drive method chain formatting).
3. Print both normalized ASTs.
4. Text-compare.

However, this approach introduces new risks: trivia stripping can remove semantically meaningful leading whitespace (e.g., inside template literals), and recursive factory reconstruction must handle every node kind including ones that may not reconstruct cleanly. It would amount to writing a code formatter from scratch rather than leveraging an existing tool.

The Prettier normalization approach already in production is more correct and battle-tested for this use case.

---

## 4. Edge Cases Discovered

### The multiLine flag is set by character presence, not indentation consistency

A source file where an object literal spans multiple lines but has inconsistent indentation still gets `multiLine=true`. The printer will re-emit it with consistent 4-space indentation — but it will still be multi-line, not inline.

```javascript
const o = {
a: 1, b: 2 };  // parser sees newline → multiLine=true
// prints as: "const o = {\n    a: 1, b: 2\n};\n"
```

### updateObjectLiteralExpression preserves the multiLine flag

`ts.factory.updateObjectLiteralExpression(node, newProperties)` copies the original `node.multiLine` value. Only `ts.factory.createObjectLiteralExpression(properties, false)` forces the flag to false. But the latter does not re-parent the child properties — their trivia still refers to the original source file positions.

### Method chains: AST kind paths are identical, only trivia differs

Running `ts.SyntaxKind[node.kind]` recursively on an inline method chain and a multi-line method chain produces bit-for-bit identical kind sequences. The entire formatting difference lives in the leading trivia on the dot tokens — which the printer re-emits verbatim.

### Arrow function parentheses are AST structure, not trivia

Whether a single-parameter arrow function has parentheses around its parameter is captured in the AST (the presence or absence of a `(` token node). This means `x =>` and `(x) =>` produce different printed output and cannot be normalized without explicit manipulation.

### PrinterOptions do not provide a normalization escape hatch

`ts.createPrinter({ newLine, removeComments, omitTrailingSemicolon })` options control cosmetic aspects but do not affect the `multiLine` flag behavior or trivia emission. There is no `normalizeFormatting: true` option.

---

## 5. Go/No-Go Recommendation

**No-go. Do not replace `prettierNormalizeForComparison` with AST canonical printing in NDS-003.**

The TypeScript printer is not a canonical normalizer. It preserves source formatting through AST flags (`multiLine`) and trivia re-emission. The specific failure patterns that motivated this research — inline vs multi-line object literals, method chain reformatting, trailing comma removal — are exactly the cases the printer cannot normalize.

A correct normalization-from-AST approach would require a custom recursive AST transform to strip all formatting-bearing AST flags and trivia before printing. That transform would be complex, potentially fragile, and would need to handle every JavaScript/TypeScript construct. It would amount to writing a subset of Prettier from scratch.

The current Prettier-based normalization is the right tool: Prettier is a battle-tested code formatter that explicitly guarantees canonical output from structurally equivalent code. The two fixes already landed (trailingComma override, singleQuote inference) address the known failure modes without the complexity of AST reconstruction.

If new NDS-003 false positive patterns appear, the correct fix is to extend the Prettier configuration overrides or add targeted reconcilers in `nds003.ts` — not to replace the normalization foundation.

---

## Appendix: What the Printer Does Normalize

For completeness — these properties *are* normalized by ts-morph's printer:

| Property | Example in | Example out | Notes |
|---|---|---|---|
| Indentation style | `\t` or 2-space | 4-space | Always 4-space inside blocks |
| Extra token whitespace | `const  x  =  1` | `const x = 1` | Spaces between keywords/identifiers |
| Missing semicolons | `const x = 1` | `const x = 1;` | Always adds semicolons |
| Trailing file whitespace | `const x = 1;` | `const x = 1;\n` | Adds trailing newline |
| Multi-line call args (no obj/arr) | `f(\n  a,\n  b\n)` | `f(a, b)` | When no multiLine-flagged nodes inside |
| Arrow callback formatting | `arr.filter(\n  x => x\n)` | `arr.filter(x => x)` | Trivia stripped by reconstruction |
