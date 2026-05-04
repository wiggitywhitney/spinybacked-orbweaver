# End-of-Run Failure Taxonomy

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-05-04
**Scope:** Answers the three M1 research questions from PRD #687 (smarter end-of-run failure handling)

---

## Q1: Failure Type Taxonomy

Survey of taze eval runs 8–11. Each failure is categorized as a **direct error** (rollback warranted) or **ambiguous** (flag-and-surface warranted).

### Run 8

**Checkpoint failure** triggered at file 10/33 (`constants.ts`). Two tests failed:

| Test | Error | Type | Category |
|---|---|---|---|
| `test/packageConfig.test.ts > defined in config file / optionMode:default` | Assertion error (90ms, fast) | Assertion | **Ambiguous** — fast test, unclear if agent caused it; no stack trace in log |
| `test/cli.test.ts > taze cli should just works` | `AssertionError: expected '' to be ''` from `Error: Timeout requesting "typescript"` | Assertion error caused by npm timeout | **Ambiguous — environmental** |

Note: Baseline tests had pre-existing failures (`baselineTestPassed === false`). End-of-run rollback condition was never satisfied — no rollback occurred.

### Run 9

No end-of-run test failures. Validator-caught failures:

| Failure | Type | Category |
|---|---|---|
| NDS-001 in `packageJson.ts`: TS2322 type mismatch in agent-added return value | TypeScript compile error in agent code | **Direct error — rollback warranted** |
| NDS-001 in `packageYaml.ts`: TS2322 type mismatch in agent-added return value | TypeScript compile error in agent code | **Direct error — rollback warranted** |
| NDS-003 in `packageYaml.ts`: non-instrumentation line added | Structural violation | **Direct error** (pre-commit gate; file never committed) |

### Run 10

No end-of-run test failures. Validator-caught failures:

| Failure | Type | Category |
|---|---|---|
| NDS-003 in `packageJson.ts`: original line 60 missing/modified (`type: 'package.json'`) | Structural violation | **Direct error** (pre-commit gate; file never committed) |
| NDS-003 in `packageYaml.ts`: original line 86 missing/modified (`type: 'package.yaml'`) | Structural violation | **Direct error** (pre-commit gate; file never committed) |

### Run 11

Both a validator-caught failure and an end-of-run test failure:

| Failure | Type | Category |
|---|---|---|
| NDS-003 in `resolves.ts` (6 violations): multiple non-instrumentation lines added | Structural violation | **Direct error** (pre-commit gate; file never committed) |
| End-of-run: `test/resolves.test.ts:136 > resolveDependency` — `AssertionError: expected true to be false` | Assertion error caused by npm registry timeout | **Ambiguous — environmental** |

**Run-11 proof detail:** `resolves.ts` was never committed (NDS-003). The committed files in the checkpoint window were `yarnWorkspaces.ts`, `pnpmWorkspaces.ts`, and `packument.ts`. The failing test stack trace shows only `test/resolves.test.ts:136` — none of the committed files appear in the call path. Fix 1 (call path analysis) would have returned an empty set → no rollback. PRD confirms the npm registry was healthy at test time, making this a transient network issue.

### Decision 6: Semantic Error Check

PRD Decision 6 asks whether any failures fall into the "semantic error" category: instrumentation that compiles and passes validators but breaks behavior at runtime (wrong return value capture, iterator wrapper that doesn't forward yields, broken async context propagation).

**Finding: No eval failures from runs 8–11 fall into this category.** All assertion failures are environmental (npm/jsr registry timeouts manifesting as assertion errors), not caused by incorrect instrumentation behavior. The NDS-001 type errors in run-9 are TypeScript compile errors (caught by the validator). No case of "agent correctly adds spans but breaks semantics" was observed.

This confirms Decision 6 is correct to route semantic errors to flag-and-surface — but it is a theoretical category in this dataset. If future runs show semantic failures, reopen Decision 6.

### Consolidated Category Table

| Failure type | Examples from runs 8–11 | PRD response |
|---|---|---|
| Import error in agent-added code | (none observed — would be NDS-001 import variant) | Rollback |
| TypeScript type error in agent-added code | NDS-001 in runs 9 (packageJson.ts, packageYaml.ts) | Rollback |
| Assertion error from external API timeout | Run 8 (npm timeout via cli.test.ts), run 11 (npm timeout via resolves.test.ts) | Flag-and-surface |
| Assertion error from unclear cause | Run 8 (packageConfig.test.ts) | Flag-and-surface |
| Structural violation (NDS-003) | Runs 9, 10, 11 — all pre-commit gated | Pre-commit gate; not an end-of-run concern |
| Semantic error (instrumentation breaks runtime behavior) | (none observed in runs 8–11) | Flag-and-surface (Decision 6) |

---

## Q2: Generic API Identification from Timeout Error Messages

**Question:** Can the hostname of the failing external API be reliably extracted from timeout error messages?

### Evidence from run-11

The actual assertion error text: `AssertionError: expected true to be false // Object.is equality` at `test/resolves.test.ts:136`. **No hostname is visible.**

The underlying cause is that `resolveDependency()` called the npm registry and received a timeout/failure, returning `false`. The assertion `expect(true).toBe(resolveDependency(...))` then fails. The hostname `registry.npmjs.org` never appears in the error message because Vitest surfaces the assertion failure, not the internal network error.

### Evidence from run-8

The error text: `Error: Timeout requesting "typescript"`. The string "typescript" is the **npm package name**, not the registry hostname. The URL `https://registry.npmjs.org/typescript` is the underlying call, but only the package name is surfaced.

### Conclusion: hostname extraction is NOT feasible

npm registry timeouts manifest in two ways in taze tests:
1. `AssertionError: expected X to be Y` — the function returned a falsy value due to registry failure; no hostname present
2. `Error: Timeout requesting "<package-name>"` — only the package name appears, not `registry.npmjs.org`

In neither case can the hostname be reliably extracted with a regex. Attempting to map package names to registries via `npm config get registry` would be too indirect and fragile.

**Recommendation: hard-code npm/jsr as known endpoints.** This is acceptable because:
1. npm (`registry.npmjs.org/-/ping`) and jsr (`jsr.io`) are the two external APIs in taze's test suite
2. These are the two primary package registries in the JavaScript ecosystem
3. Adding new registries requires explicit configuration regardless (no implicit detection is reliable)

For M3 implementation: use package-manager detection (presence of `pnpm-lock.yaml`, `bun.lockb`, `yarn.lock`, or `package-lock.json`) combined with registry type (npm vs jsr) to select the health endpoint. Do not attempt error-message parsing.

---

## Q3: `parseFailingSourceFiles` Portability at End-of-Run

**Question:** Can `parseFailingSourceFiles` from `dispatch.ts` be called from `coordinate.ts` Step 7c without modification?

### The function itself: lift-and-shift

`parseFailingSourceFiles` at `src/coordinator/dispatch.ts:71` takes `(output: string, windowPaths: string[])`. It:
- Extracts `at ...` stack frame paths using a regex
- Matches against absolute paths in `windowPaths` (exact match or suffix match for relative paths)
- Returns the subset of `windowPaths` that appear in the stack trace

**Vitest stack trace format is identical between checkpoint runs and end-of-run live-check runs.** Both use the same test runner. No adapter is needed. The function can be called from `coordinate.ts` Step 7c as-is.

### The structural gap: test output was not plumbed to Step 7c (resolved)

> **Note (post-M2):** This gap was resolved. `LiveCheckResult` now includes `testOutput?: string`, captured from `ExecFileException.stdout/stderr` in the Step 5 catch block. `coordinate.ts` reads `liveCheckResult.testOutput` and passes it to `parseFailingSourceFiles`. The analysis below describes the pre-M2 state for historical context.

This was the actual portability problem. `runLiveCheck()` in `live-check.ts` did NOT return the test output at the time of this research.

Relevant section of `runLiveCheck` (Step 5):
```typescript
try {
  await runTestSuite(testCommand, projectDir, grpcPort, execFileFn);
} catch (err) {
  testsPassed = false;
  const message = err instanceof Error ? err.message : String(err);
  warnings.push(`End-of-run test suite failed: ${message}`);
}
```

The catch block captures only `err.message` (e.g., `"Command failed: sh -c pnpm test"`). The full stdout/stderr with stack traces is discarded.

`LiveCheckResult` (the return type) has no `testOutput` field:
```typescript
export interface LiveCheckResult {
  skipped: boolean;
  complianceReport?: string;
  testsPassed?: boolean;
  warnings: string[];
  // testOutput is missing — added in M2
}
```

In `coordinate.ts` Step 7c, only `liveCheckTestsPassed` is available from `liveCheckResult`. The full test output needed by `parseFailingSourceFiles` is not accessible.

### Node.js ExecFileException has stdout/stderr

When `execFile` fails (non-zero exit code), the error object is typed as `ExecFileException extends Error`, which includes `.stdout: string` and `.stderr: string` properties. The full test output is technically available inside `runTestSuite` but is lost in the `reject(error)` call because the caller only reads `err.message`.

### Required changes for portability (drive M2 implementation)

1. **In `runTestSuite()`**: On failure, include stdout+stderr in the rejected error (or change the return signature to return an object with `{ output: string }` on error, similar to how checkpoint `runTestCommand` works).

2. **In `runLiveCheck()` Step 5 catch block**: Capture the full output from the error object and store it.

3. **Add `testOutput?: string` to `LiveCheckResult`**: Expose the captured output to callers.

4. **In `coordinate.ts` Step 7c**: Call `parseFailingSourceFiles(liveCheckResult.testOutput ?? '', checkpointWindowRef.files.map(f => f.path))` to identify committed files in the failing test's call path.

The function requires no modification. Only the plumbing to deliver the test output to Step 7c needs to change — this is a three-file change (`live-check.ts`, `LiveCheckResult` interface, `coordinate.ts`).

### Checkpoint vs end-of-run context comparison

| Context | Test runner | Stack trace format | Output captured? | windowPaths source |
|---|---|---|---|---|
| Checkpoint | `options.runTestCommand()` returns `{ passed, output }` | Vitest format | Yes — full stdout+stderr | `checkpointWindowFiles.map(f => f.path)` |
| End-of-run | `runTestSuite()` inside `runLiveCheck()` | Vitest format (identical) | No — only `err.message` today | `checkpointWindowRef.files.map(f => f.path)` |

The `windowPaths` parameter at end-of-run maps to `checkpointWindowRef.files` — the files committed in the last checkpoint window that haven't cleared yet. This is the correct set to check against the failing test's call path.
