# NDS-003 AST Patterns Catalog

Source: commit-story-v2 eval runs 17–19 debug dumps and spiny-orb output logs.
This catalog is the authoritative input for the M1 OTel node stripper (PRD #875).

For each pattern: **(1) pattern name**, **(2) ts-morph node type(s)**, **(3) transformation rule**, **(4) real example** from eval output.

---

## Instrumentation Patterns

### P1: startActiveSpan callback — return form, async

**ts-morph node type**: `ReturnStatement` whose expression is a `CallExpression` where the callee is a `PropertyAccessExpression` with name `startActiveSpan`.

**Transformation rule**: Find the `ArrowFunction` (or `FunctionExpression`) argument. Extract its `Block` body statements. Replace the `ReturnStatement` with those statements. The span parameter (`span`, `otelSpan`, etc.) becomes a dangling reference — all `span.*` calls are removed in subsequent passes.

**Real example** — `src/generators/journal-graph.js`, run-17:
```js
async function summaryNode(state) {
  return tracer.startActiveSpan('commit_story.journal.generate_summary', async (span) => {
    try {
      // body
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

---

### P2: startActiveSpan callback — return form, sync

**ts-morph node type**: Same as P1. The second argument is an `ArrowFunction` without `async`.

**Transformation rule**: Same as P1.

**Real example** — nds003.test.ts fixture (run-17 equivalent):
```js
function greet(name) {
  return tracer.startActiveSpan('greet', (span) => {
    try {
      console.log('Hello ' + name);
    } finally {
      span.end();
    }
  });
}
```

---

### P3: startActiveSpan callback — expression statement form

**ts-morph node type**: `ExpressionStatement` whose expression is a `CallExpression` matching `*.startActiveSpan(...)`. The function has no return value.

**Transformation rule**: Same callback body extraction as P1. Replace the `ExpressionStatement` with the callback body statements.

**Real example**: Less common. Occurs when the function returns void and the agent wraps the body without preserving a return value.

---

### P4: Outer OTel lifecycle try/catch/finally

**ts-morph node type**: `TryStatement` with all three clauses — `tryBlock`, `catchClause`, `finallyBlock`.

**Context**: Appears inside the `startActiveSpan` callback body (P1/P2/P3). After P1 unwrapping, this becomes a top-level statement in the function body.

**Transformation rule**: 
- The `catchClause` is OTel if its body contains only `span.recordException(...)`, `span.setStatus(...)`, and `throw` — remove the entire catch.
- The `finallyBlock` is OTel if it contains only `span.end()` — remove the entire finally.
- After removing both, if the `TryStatement` has only the `tryBlock` left (no catch or finally), unwrap to its statements.
- **Conservatism**: if the catch block contains non-OTel statements (user code), leave the `TryStatement` intact and only remove the OTel statements within it.

**Real example** — `src/generators/journal-graph.js`, run-17:
```js
// After startActiveSpan unwrap, the following is what remains at function level:
try {
  span.setAttribute('commit_story.ai.section_type', 'summary');
  // ... more setAttribute calls ...
  try {
    // inner user try (see P6)
  } catch (error) {
    // user graceful-degradation catch (no rethrow)
  }
} catch (error) {
  span.recordException(error);        // OTel only
  span.setStatus({ code: SpanStatusCode.ERROR }); // OTel only
  throw error;                        // throw — OTel boilerplate
} finally {
  span.end();                         // OTel only
}
```

---

### P5: Simple OTel lifecycle try/finally (NDS-007 Pattern A)

**ts-morph node type**: `TryStatement` with `tryBlock` and `finallyBlock` but no `catchClause`. Appears as the result of NDS-007 Pattern A graceful-degradation instrumentation.

**Transformation rule**: If `finallyBlock` contains only `span.end()` — remove the finally and unwrap `tryBlock` to its statements.

**Real example** — nds003.test.ts fixture:
```js
return tracer.startActiveSpan('greet', (span) => {
  try {
    console.log('Hello ' + name);
  } finally {
    span.end();
  }
});
```
After P1 unwrapping and P5 unwrapping, leaves `console.log('Hello ' + name)`.

---

### P6: Inner user try/catch (NDS-007 graceful degradation — PRESERVE)

**ts-morph node type**: `TryStatement` with `catchClause` that does NOT rethrow and does NOT contain OTel calls.

**Transformation rule**: **Do NOT modify.** This is original user code. The agent added the outer OTel try/catch/finally (P4) around the user's existing try/catch. After removing P4, this inner try/catch is the original code.

**Identification**: An inner `TryStatement` whose catch block contains user logic (non-span calls, returns, or no rethrow). Distinguished from P4 by: no `span.recordException`, no `span.setStatus`, and no `throw <catch-var>` on the last line.

**Real example** — `src/generators/journal-graph.js`, run-17 (inner block):
```js
try {
  const result = await model.invoke([...]);
  if (result.usage_metadata != null) { span.setAttribute(...); }
  return { summary: cleanSummaryOutput(result.content) };
} catch (error) {
  return { summary: '[Summary generation failed]', errors: [...] }; // no rethrow → user code
}
```

---

### P7: span.setAttribute statement (single-line)

**ts-morph node type**: `ExpressionStatement` whose expression is a `CallExpression` where the callee is `PropertyAccessExpression` with name `setAttribute` and receiver matching a span variable name (`span`, `otelSpan`, `activeSpan`, or any identifier bound as the `startActiveSpan` callback parameter).

**Transformation rule**: Remove the `ExpressionStatement`.

**Real example** — `src/generators/journal-graph.js`, run-17:
```js
span.setAttribute('commit_story.ai.section_type', 'summary');
span.setAttribute('gen_ai.operation.name', 'chat');
span.setAttribute('gen_ai.request.temperature', NODE_TEMPERATURES.summary);
```

---

### P8: span.setAttribute multiline (Prettier-split)

**ts-morph node type**: Same as P7 — a single `ExpressionStatement` / `CallExpression` in the AST, regardless of how Prettier formatted it across multiple lines.

**Transformation rule**: Same as P7. The AST node is identical to P7 — this pattern exists only in text form, not in AST form. This is why AST comparison eliminates the reconciler burden: `span.setAttribute(key, value)` is one `CallExpression` node in both the compact and the multi-line form.

**Real example** — multiline form seen in eval output:
```js
span.setAttribute(
  'commit_story.journal.entries_count',
  entries.length,
);
```

---

### P9: span.setStatus statement

**ts-morph node type**: `ExpressionStatement` with `CallExpression` — callee is `PropertyAccessExpression` with name `setStatus`, receiver is span variable.

**Transformation rule**: Remove the `ExpressionStatement`.

**Real example** — `src/generators/journal-graph.js`, run-17:
```js
span.setStatus({ code: SpanStatusCode.ERROR });
span.setStatus({ code: SpanStatusCode.OK });
```

---

### P10: span.recordException statement

**ts-morph node type**: `ExpressionStatement` with `CallExpression` — callee name `recordException`, receiver is span variable.

**Transformation rule**: Remove the `ExpressionStatement`.

**Real example** — `src/generators/journal-graph.js`, run-17:
```js
span.recordException(error);
```

---

### P11: span.end statement

**ts-morph node type**: `ExpressionStatement` with `CallExpression` — callee name `end`, receiver is span variable.

**Transformation rule**: Remove the `ExpressionStatement`. NOTE: `span.end()` inside a `finally` block is handled as part of P4/P5 — the entire `finally` is removed. This pattern covers any standalone `span.end()` that appears outside a `finally` (less common but possible).

**Real example** — `src/mcp/tools/context-capture-tool.js`, run-17 (when `span.end()` appears before finally removal):
```js
span.end();
```

---

### P12: OTel import declaration

**ts-morph node type**: `ImportDeclaration` where `moduleSpecifier` contains `@opentelemetry`.

**Transformation rule**: Remove the `ImportDeclaration`.

**Real example** — `src/generators/journal-graph.js`, run-17:
```js
import { trace, SpanStatusCode } from '@opentelemetry/api';
```

---

### P13: Tracer declaration

**ts-morph node type**: `VariableStatement` containing a `VariableDeclaration` whose initializer is a `CallExpression` with callee matching `trace.getTracer` or `api.trace.getTracer`.

**Transformation rule**: Remove the `VariableStatement`. NOTE: The tracer variable reference (`tracer.startActiveSpan(...)`) is handled as part of P1/P2/P3, not separately.

**Real example** — `src/generators/journal-graph.js`, run-17:
```js
const tracer = trace.getTracer('commit-story');
```

---

### P14: CDQ-007 null guard (single condition)

**ts-morph node type**: `IfStatement` with no `else` clause, whose condition is a `BinaryExpression` with operator `!==` or `!=` and one operand being a `NullKeyword` or the identifier `undefined` (or `typeof x !== 'undefined'` form). The body `Block` contains only `span.setAttribute(...)` calls.

**Transformation rule**: If the block contains ONLY `ExpressionStatement` nodes matching P7, remove the entire `IfStatement`. If the block contains any non-OTel statement, leave it intact (conservatism policy).

**Real example** — `src/generators/summary-graph.js`, run-18:
```js
if (entries != null) {
  span.setAttribute('commit_story.journal.entries_count', entries.length);
}
```

---

### P15: CDQ-007 null guard (compound AND condition)

**ts-morph node type**: `IfStatement` with no `else` clause, whose condition is a `BinaryExpression` with operator `&&` combining two null-check expressions. Body contains only span.setAttribute calls.

**Transformation rule**: Same as P14 — if body is only OTel calls, remove entire `IfStatement`.

**Real example** — from nds003.ts INSTRUMENTATION_PATTERNS comment (run-6 taze):
```js
if (a != null && b.c !== undefined) {
  span.setAttribute('key', value);
}
```

---

### P16: CDQ-006 isRecording guard

**ts-morph node type**: `IfStatement` with no `else` clause, whose condition is a `CallExpression` with callee `PropertyAccessExpression` where name is `isRecording` and receiver is span variable.

**Transformation rule**: If block contains only OTel calls (setAttribute), remove entire `IfStatement`.

**Real example** — from nds003.ts INSTRUMENTATION_PATTERNS comment:
```js
if (span.isRecording()) {
  span.setAttribute('expensive.key', computeExpensive());
}
```

---

### P17: TypeScript error-narrowing guard

**ts-morph node type**: `IfStatement` with condition `BinaryExpression` using `instanceof` with right-hand side `Error`. Body contains only `span.recordException(...)`.

**Transformation rule**: If block contains only `span.recordException(...)`, remove entire `IfStatement`.

**Real example** — from nds003.ts INSTRUMENTATION_PATTERNS comment:
```js
if (err instanceof Error) {
  span.recordException(err);
}
```

---

### P18: context.with (async context propagation)

**ts-morph node type**: `ReturnStatement` or `ExpressionStatement` whose expression is a `CallExpression` where callee is `PropertyAccessExpression` with name `with` and receiver is `context` (from `@opentelemetry/api`). Second argument is an async function.

**Transformation rule**: Same as startActiveSpan — extract the callback body and replace. This pattern is less common in commit-story-v2 eval runs; no debug dump example found in runs 17–19.

**Real example** — from nds003.ts INSTRUMENTATION_PATTERNS (known pattern, not observed in runs 17–19):
```js
return context.with(propagation.extract(context.active(), carrier), async () => {
  // body
});
```

---

### P19: Multiline startActiveSpan arguments

**ts-morph node type**: Same as P1 — a single `CallExpression`. The span name and callback appear on separate lines only in text representation.

**Transformation rule**: Same as P1. The AST node is a single `CallExpression` regardless of formatting. The text split (`'span.name',\nasync (span) => {`) is a Prettier artifact; the AST represents a single call.

**Real example** — `reconcileStartActiveSpanMultilineArgs` in nds003.ts documents the text form:
```js
tracer.startActiveSpan(
  'span.name',
  async (span) => {
    // body
  }
);
```

---

### P20: Return value capture for setAttribute

**ts-morph node type**: `VariableStatement` where the declared variable is used exclusively as the argument to `span.setAttribute(...)` and as a `return` value. Equivalent to `reconcileReturnCaptures` in the text-based path.

**Transformation rule**: This is handled by the stripper's two-pass approach: (1) remove `span.setAttribute(varName)` statements (P7), (2) the variable declaration and `return varName` remain as original code. The stripper does NOT remove the variable declaration or bare `return varName` — those belong to the original code. After stripping, the captured variable and return form an equivalent structure to the original `return expr`.

**Note**: The AST comparison must account for this structural difference. The original has `return expr` while the stripped instrumented has `const var = expr; return var;`. This equivalence needs explicit handling in the AST comparison step (M2), not the stripper.

**Real example** — from `reconcileReturnCaptures` in nds003.ts:
```js
// Original:
return computeResult();

// Instrumented (after stripping span.setAttribute):
const result = computeResult();
return result;
```

---

## Edge Cases

### EC1: Line near 80-char boundary inside startActiveSpan callback

**Description**: A line that fits within Prettier's printWidth at original indentation but exceeds it at the deeper indentation inside a `startActiveSpan` callback. Prettier then wraps the line.

**NDS-003 false positive**: Text comparison sees the original single-line form as "missing" and the split form as "added". The AST comparison sees a single `CallExpression` or `ExpressionStatement` in both — identical.

**Real example** — `src/collectors/claude-collector.js`, run-19 log (no debug dump available):
```text
original line 228 missing/modified: allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
non-instrumentation line added at instrumented line 247: allMessages.sort(
```

The line `allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));` is 79 chars at original indentation; at the deeper indentation inside the span callback it exceeds 80, causing Prettier to split it. The AST node is the same `CallExpression` on `allMessages.sort`.

**Stripper handling**: The line is original code (not an OTel node), so the stripper leaves it untouched. The AST comparison then compares the two `sort(...)` nodes structurally — same arguments, same receiver, identical.

---

### EC2: Early return inside span callback

**Description**: `return value;` or `return { ... };` inside the startActiveSpan callback body.

**Stripper handling**: After unwrapping the startActiveSpan callback (P1), the `return` statement is simply a statement in the function body — no transformation needed. Retain as-is.

**Real example** — `src/mcp/tools/context-capture-tool.js`, run-17:
```js
return tracer.startActiveSpan('commit_story.context.save_context', async (span) => {
  try {
    // ...
    return filePath;  // ← early return — preserved as-is after unwrap
  } catch (error) {
    // ...
  }
});
```

---

### EC3: Multiple sequential spans in one function

**Description**: A function body contains two or more separate `startActiveSpan` calls, each wrapping a distinct block of code.

**Stripper handling**: Each `startActiveSpan` call is independently unwrapped (P1). Process all matching nodes; ts-morph handles the index shifting after each replacement.

**Real example** — not observed in runs 17–19 debug dumps but documented in `reconcileReturnCaptures` code comment patterns. Observed as sequential functions in the same file each having their own span.

---

### EC4: Nested spans

**Description**: An inner `startActiveSpan` call inside the body of an outer `startActiveSpan` callback.

**Stripper handling**: Process innermost nodes first (bottom-up traversal), then outer nodes. After inner unwrap, outer unwrap proceeds normally.

**Note**: Not observed in runs 17–19 debug dumps. The agent generally creates one span per function, not nested spans. If this pattern appears, the stripper must handle it without special-casing — bottom-up traversal handles it automatically.

---

### EC5: Async vs sync callback forms

**Description**: `async (span) => { BODY }` vs `(span) => { BODY }`.

**Stripper handling**: The unwrap operation (P1/P2/P3) is identical for both. The `async` keyword is on the `ArrowFunction` node's `asyncModifier` — not part of the body. Removing the wrapper also removes the async keyword from the callback, which is correct (the function containing the span was already async before instrumentation, or was made async by the agent for the span callback).

**Real example**: Both forms present in runs 17–18. Summary functions use `async (span) =>`, simple void-return functions use `(span) =>`.

---

### EC6: Spans inside conditionals or loops

**Description**: `if (condition) { return tracer.startActiveSpan(...) }` or a `startActiveSpan` call inside a `for`/`while` loop body.

**Stripper handling**: The `startActiveSpan` `CallExpression` is a descendant of the conditional/loop body. The unwrap replaces the `ReturnStatement` (or `ExpressionStatement`) containing the call with the callback body statements — the conditional/loop wrapper is unchanged.

**Not observed** in runs 17–19 debug dumps. Document for completeness.

---

### EC7: Multiline startActiveSpan arguments (Prettier-split call)

**Description**: When the `tracer.startActiveSpan('span.name', async (span) => {` line exceeds Prettier's printWidth, the span name and callback appear on separate lines.

**Stripper handling**: The AST node is a single `CallExpression` regardless of the line-break. The `getArguments()` call returns the same argument list in both compact and split forms. No special handling needed.

**Real example** — reconcileStartActiveSpanMultilineArgs comment in nds003.ts:
```js
tracer.startActiveSpan(
  'span.name',
  async (span) => {
```

---

### EC8: P20 return-value capture structural divergence

**Description**: Original code has `return expr;` while stripped instrumented code has `const var = expr; return var;`. These are structurally different in the AST even though semantically equivalent.

**Impact on AST comparison**: The M2 AST comparison must handle this equivalence explicitly. The stripper removes `span.setAttribute(var)` (P7) but leaves `const var = expr; return var;` as original code. The comparison step needs to detect this two-node pattern and match it against the original single `return expr` node.

**Disposition**: Document here; implement the equivalence check in M2's comparison logic, not in the M1 stripper.

---

## Span Variable Name Conventions

The agent uses these variable names for the span parameter (all observed in runs 17–19):
- `span` — most common
- `otelSpan` — used when a local variable named `span` already exists
- `activeSpan` — less common variant

The stripper must identify the span variable from the `startActiveSpan` callback's parameter list, not by matching a fixed name.

---

## Conservatism Policy (from PRD #875 Design Decisions)

**When uncertain, treat node as original code.**

A false positive (PARTIAL result, file not committed) is recoverable — the agent can retry. A false negative (corrupted code committed silently) is not recoverable without human review.

Concretely:
- If a `TryStatement`'s catch block contains ANY non-OTel statement, leave the entire try/catch intact.
- If an `IfStatement`'s body contains ANY non-OTel statement, leave the entire if block intact.
- If a `VariableStatement`'s initializer is not a recognized OTel pattern, leave it intact.
- If an unrecognized node shape appears, leave it intact and the AST comparison will surface it as a finding.
