# Acceptance Gate Test Calibration Audit

> Produced by PRD #857 M4. Inputs: test/acceptance-gate.test.ts (P1), test/fix-loop/acceptance-gate.test.ts (P3), test/coordinator/acceptance-gate.test.ts (P4+P5), and test/commit-story-v2/acceptance-gate.test.ts (included because M4's explicit journal-graph.js question requires it).

## Assertion Table

> **Verdict key**: yes = realistic and correctly placed; no = should be changed (tests wrong thing or introduces hard-coded fragility); conditional = should be guarded or relaxed.
> Trivially-correct infrastructure assertions (`.toBeDefined()`, `.toBeGreaterThan(0)` on token counts after real API calls, `.toBeGreaterThanOrEqual(0)`) are grouped as "infrastructure" and marked **yes** unless there is a specific reason to flag them.

### test/acceptance-gate.test.ts (P1)

| Test file | Test name | Assertion (exact or paraphrased code) | Realistic for LLM output? | Proposed change |
|---|---|---|---|---|
| acceptance-gate.test.ts | user-routes.js | `expect(result.success).toBe(true)` | yes | keep |
| acceptance-gate.test.ts | user-routes.js | `expect(output.instrumentedCode.length).toBeGreaterThan(original.length)` | yes | keep |
| acceptance-gate.test.ts | user-routes.js | `expect(output.notes.length).toBeGreaterThan(0)` | yes — deterministic | keep |
| acceptance-gate.test.ts | user-routes.js | Token usage fields `> 0` | yes — deterministic | keep |
| acceptance-gate.test.ts | user-routes.js | `expect(output.spanCategories).not.toBeNull()` | yes — deterministic | keep |
| acceptance-gate.test.ts | user-routes.js | All 10 rubric checks (incl. NDS-003) pass: `expect(check.passed).toBe(true)` | conditional — NDS-003 is broken (PRD #845 reconciler gap); a valid first-attempt output can fail NDS-003 for reconciler-gap reasons, not agent quality reasons. The comment at line 148 acknowledges order-service.js was removed from P1 for exactly this reason. | NDS-003 rule should be disabled in the P1 single-shot test while PRD #845 is open. Pass `{ nds003: false }` to `runRubricChecks`. All other 9 rules remain active. |
| acceptance-gate.test.ts | user-routes.js | `packages.toContain('@opentelemetry/instrumentation-pg')` | yes — deterministic (pre-scan) | keep |
| acceptance-gate.test.ts | user-routes.js | `packages.toContain('@opentelemetry/instrumentation-express')` | yes — deterministic (pre-scan) | keep |
| acceptance-gate.test.ts | format-helpers.js | All assertions (sync note, zero tokens, code unchanged, empty extensions, zero attributesCreated) | yes — all deterministic via sync pre-screening | keep |
| acceptance-gate.test.ts | Test A: agent uses registry attribute | `expect(result.success).toBe(true)` | yes | keep |
| acceptance-gate.test.ts | Test A: agent uses registry attribute | `expect(attributeExtensionsA).toEqual([])` (zero attribute extensions when registry has the exact attribute) | conditional — non-deterministic; the agent may still emit a span-type extension or choose a near-synonym. The assertion tests an important behavior but can flake. | keep — this tests the registry-first principle, which is a core correctness property. Accept occasional flakiness here. |
| acceptance-gate.test.ts | Test A: agent uses registry attribute | `expect(output.instrumentedCode).toMatch(/setAttribute\(['"]dd\.http\.request\.method['"]/)` | conditional — same reasoning | keep |
| acceptance-gate.test.ts | Test B: agent invents dd.* attributes | `expect(result.success).toBe(true)` | yes | keep |
| acceptance-gate.test.ts | Test B: agent invents dd.* attributes | `expect(attributeExtensions.length).toBeGreaterThan(0)` ("Agent should invent at least one attribute") | **no** — tests that the LLM WILL invent an attribute. The agent may correctly decide no custom attributes are needed (e.g., using only the span itself). Fails for correct agent behavior. | Remove this line entirely. The namespace-consistency loop below it is the real assertion. A zero-extension run is valid; the test verifies that ANY extensions produced are correctly namespaced. |
| acceptance-gate.test.ts | Test B: agent invents dd.* attributes | `for ext: expect(ext).toMatch(/^dd\./)` | yes — if extensions exist, they should match namespace. Currently runs only when `attributeExtensions.length > 0` (the loop body). This remains correct after removing the length assertion above. | keep |
| acceptance-gate.test.ts | already-instrumented.js | All assertions (code unchanged, zero tokens, skip note, null spanCategories) | yes — all deterministic | keep |

### test/fix-loop/acceptance-gate.test.ts (P3)

| Test file | Test name | Assertion | Realistic? | Proposed change |
|---|---|---|---|---|
| fix-loop/acceptance-gate.test.ts | instruments user-routes.js | `expect(result.status).toBe('success')` | yes — fix loop should handle retries | keep |
| fix-loop/acceptance-gate.test.ts | instruments user-routes.js | `expect(result.spansAdded).toBeGreaterThan(0)` | yes | keep |
| fix-loop/acceptance-gate.test.ts | instruments user-routes.js | `expect(result.validationAttempts).toBeGreaterThanOrEqual(1)` | yes — deterministic | keep |
| fix-loop/acceptance-gate.test.ts | instruments user-routes.js | `expect(result.validationAttempts).toBeLessThanOrEqual(3)` | yes — reasonable max | keep |
| fix-loop/acceptance-gate.test.ts | instruments user-routes.js | `expect(result.validationStrategyUsed).toMatch(pattern)` | yes — deterministic | keep |
| fix-loop/acceptance-gate.test.ts | instruments user-routes.js | Token usage `> 0` | yes — deterministic | keep |
| fix-loop/acceptance-gate.test.ts | instruments user-routes.js | `expect(result.errorProgression).toBeDefined()` | yes | keep |
| fix-loop/acceptance-gate.test.ts | instruments user-routes.js | `expect(result.errorProgression!.length).toBe(result.validationAttempts)` | **conditional** — hard equality (`toBe`) can fail if function-level fallback appends extra entries ("function-level: N/M...", "reassembly: ..."). P3 test 5 (line 293) correctly uses `toBeGreaterThanOrEqual` for the same quantity. Inconsistency is a calibration issue. | Change `toBe` → `toBeGreaterThanOrEqual` to match P3 test 5. |
| fix-loop/acceptance-gate.test.ts | instruments user-routes.js | `expect(result.errorProgression![last]).toBe('0 errors')` | yes — for success, last entry should be 0 errors | keep |
| fix-loop/acceptance-gate.test.ts | instruments user-routes.js | `expect(result.librariesNeeded.length).toBeGreaterThan(0)` | yes — pg/express always detected | keep |
| fix-loop/acceptance-gate.test.ts | instruments user-routes.js | Notes, file-on-disk length assertions | yes — deterministic for success path | keep |
| fix-loop/acceptance-gate.test.ts | instruments order-service.js | `expect(result.status).toBe('success')` | yes — fix loop | keep |
| fix-loop/acceptance-gate.test.ts | instruments order-service.js | `expect(fileOnDisk).toContain('validateOrder')` | yes — public API preservation is deterministic | keep |
| fix-loop/acceptance-gate.test.ts | budget exceeded | All assertions (status failed, reason budget/pre-flight, file reverted) | yes — deterministic, designed behavior | keep |
| fix-loop/acceptance-gate.test.ts | file revert on exhaustion | All assertions (conditional on success/failure branch) | yes — handles both outcomes correctly | keep |
| fix-loop/acceptance-gate.test.ts | reports correct strategy | `expect(result.errorProgression!.length).toBeGreaterThanOrEqual(result.validationAttempts)` | yes — correctly permissive | keep |
| fix-loop/acceptance-gate.test.ts | snapshot cleanup | `expect(['success', 'failed']).toContain(result.status)` | yes — trivially always true; tests no crash | keep (trivial but harmless) |
| fix-loop/acceptance-gate.test.ts | snapshot cleanup | `expect(result.tokenUsage).toBeDefined()` | yes | keep |

### test/coordinator/acceptance-gate.test.ts (P4 + P5 + M5 live-check)

| Test file | Test name | Assertion | Realistic? | Proposed change |
|---|---|---|---|---|
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(result.filesProcessed).toBe(5)` | **no** — hard-coded; adding or removing any fixture file breaks the test | Replace with `toBeGreaterThanOrEqual(5)` or compute from fixture directory count at test time. |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(skippedResults.length).toBeGreaterThanOrEqual(1)` | yes | keep |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(alreadyInstrumented!.status).toBe('skipped')` | yes — deterministic | keep |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(alreadyInstrumented!.reason).toContain('already instrumented')` | yes — deterministic | keep |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(nonSkipped.length).toBe(4)` | **no** — hard-coded; derives directly from `filesProcessed === 5` minus 1 skip | Replace with `toBe(result.filesProcessed - skippedResults.length)` or `toBeGreaterThanOrEqual(3)`. |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | OTel on disk check for instrumented-succeeded files | yes | keep |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | Failed files reverted to original | yes — deterministic contract | keep |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(result.filesSucceeded + result.filesFailed + result.filesSkipped + result.filesPartial).toBe(result.filesProcessed)` | yes — algebraic invariant | keep |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(result.filesSucceeded).toBeGreaterThanOrEqual(1)` | yes | keep |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | Callback event type presence checks | yes — deterministic | keep |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(fileStartEvents.length).toBe(5)` | **no** — hard-coded | Replace with `toBe(result.filesProcessed)`. |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(fileCompleteEvents.length).toBe(5)` | **no** — hard-coded | Replace with `toBe(result.filesProcessed)`. |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(runCompleteResults).toHaveLength(5)` | **no** — hard-coded | Replace with `toHaveLength(result.filesProcessed)`. |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(result.costCeiling.fileCount).toBe(5)` | **no** — hard-coded | Replace with `toBe(result.filesProcessed)`. |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(result.costCeiling.maxTokensCeiling).toBe(5 * 80000)` | **no** — hard-coded; uses the literal 5 | Replace with `toBe(result.filesProcessed * config.maxTokensPerFile)`. |
| coordinator/acceptance-gate.test.ts | P4-1 full end-to-end | `expect(result.fileResults).toHaveLength(5)` | **no** — hard-coded | Replace with `toHaveLength(result.filesProcessed)`. |
| coordinator/acceptance-gate.test.ts | P4-2 spansAdded diagnostics | `expect(succeeded.length).toBeGreaterThanOrEqual(1)` | yes | keep |
| coordinator/acceptance-gate.test.ts | P4-2 spansAdded diagnostics | `expect(instrumented.length).toBeGreaterThanOrEqual(1)` | yes | keep |
| coordinator/acceptance-gate.test.ts | P4-2 spansAdded diagnostics | Per-instrumented-file assertions (spansAdded, attempts, strategy, tokens) | yes | keep |
| coordinator/acceptance-gate.test.ts | P4-3 SDK init libraries | All assertions (conditional on libraries existing) | yes | keep |
| coordinator/acceptance-gate.test.ts | P4-4 advisory annotations | Structure checks (conditional on annotations present) | yes | keep |
| coordinator/acceptance-gate.test.ts | P4-5 error progression | `expect(r.errorProgression).toBeDefined()` | yes | keep |
| coordinator/acceptance-gate.test.ts | P4-5 error progression | `expect(r.errorProgression!.length).toBeLessThanOrEqual(r.validationAttempts)` (for `functionsInstrumented === undefined` files) | **no** — semantically wrong. The comment says "length == validationAttempts for whole-file results" but the code asserts `<=`. Using `<=` passes silently when errorProgression entries are missing (length < validationAttempts), hiding a real bug. P3 test 5 correctly uses `>=`. | Change to `toBeGreaterThanOrEqual(result.validationAttempts)` for consistency with P3. This also catches cases where entries are missing. |
| coordinator/acceptance-gate.test.ts | P5-(a) schema fields | `expect(result.schemaHashStart).toMatch(/^[0-9a-f]{64}$/)` | conditional — format only; two incorrect hashes that are valid hex will pass | keep (format check is better than nothing; functional correctness is covered by the conditional hash-diff block) |
| coordinator/acceptance-gate.test.ts | P5-(a) schema fields | `expect(result.schemaHashEnd).toMatch(/^[0-9a-f]{64}$/)` | conditional — same | keep |
| coordinator/acceptance-gate.test.ts | P5-(a) schema fields | `if (anyExtensions) { expect(schemaHashStart).not.toBe(schemaHashEnd); ... }` | yes — already correctly conditional | keep |
| coordinator/acceptance-gate.test.ts | P5-(a) schema fields | `expect(result.filesProcessed).toBe(5)` | **no** — hard-coded | Replace with `toBeGreaterThanOrEqual(5)` or dynamic count. |
| coordinator/acceptance-gate.test.ts | P5-(a) schema fields | `expect(result.filesSucceeded).toBeGreaterThanOrEqual(1)` | yes | keep |
| coordinator/acceptance-gate.test.ts | P5-(b) schema lifecycle | `expect(deps.createBaselineSnapshot).toHaveBeenCalled()` | yes — deterministic | keep |
| coordinator/acceptance-gate.test.ts | P5-(b) schema lifecycle | `if (anyExtensions) { expect(deps.computeSchemaDiff).toHaveBeenCalled(); }` | yes — conditional, correct | keep |
| coordinator/acceptance-gate.test.ts | P5-(b) schema lifecycle | `expect(deps.cleanupSnapshot).toHaveBeenCalled()` | yes — deterministic | keep |
| coordinator/acceptance-gate.test.ts | P5-(d) live-check compliance | `expect(deps.runLiveCheck).toHaveBeenCalled()` | yes — deterministic | keep |
| coordinator/acceptance-gate.test.ts | P5-(d) live-check compliance | `expect(result.endOfRunValidation).toBe('Schema compliance: ...')` | yes — deterministic (mocked) | keep |
| coordinator/acceptance-gate.test.ts | P5-(d) live-check per-file hashes | `expect(r.schemaHashBefore).toMatch(/^[0-9a-f]{64}$/)` | conditional — format only | keep |
| coordinator/acceptance-gate.test.ts | P5-(d) live-check per-file hashes | `expect(r.schemaHashAfter).toMatch(/^[0-9a-f]{64}$/)` | conditional — format only | keep |
| coordinator/acceptance-gate.test.ts | P5-(c) onSchemaCheckpoint | Mock call assertion | yes — deterministic | keep |
| coordinator/acceptance-gate.test.ts | P5-f no warnings | `expect(schemaWarnings).toHaveLength(0)` | yes | keep |
| coordinator/acceptance-gate.test.ts | M5 live-check SDK injection | `expect(result.skipped).toBe(false)` | yes | keep |
| coordinator/acceptance-gate.test.ts | M5 live-check SDK injection | `expect(result.testsPassed).toBe(true)` | yes — tests real OTel behavior | keep |
| coordinator/acceptance-gate.test.ts | M5 live-check SDK injection | `expect(result.parsedCompliance!.spansReceived).toBe(true)` | yes — key assertion | keep |
| coordinator/acceptance-gate.test.ts | M5 live-check SDK injection | `expect(result.parsedCompliance!.spanCount).toBeGreaterThan(0)` | yes | keep |

### test/commit-story-v2/acceptance-gate.test.ts (included for journal-graph.js explicit question)

| Test file | Test name | Assertion | Realistic? | Proposed change |
|---|---|---|---|---|
| commit-story-v2/acceptance-gate.test.ts | parseSummarizeArgs isolated | `expect(result.status).toBe('success')` | yes — pure sync utility, pre-screening returns success | keep |
| commit-story-v2/acceptance-gate.test.ts | runSummarize isolated | `expect(result.status).toBe('success')` | yes — reasonable with retry | keep |
| commit-story-v2/acceptance-gate.test.ts | runSummarize isolated | `expect(result.spansAdded).toBeGreaterThan(0)` | yes | keep |
| commit-story-v2/acceptance-gate.test.ts | runSummarize isolated | `expect(instrumented).toMatch(/result\.failed\.push/)` | yes — specific regression check for issue #839 | keep |
| commit-story-v2/acceptance-gate.test.ts | summarize.js | `expect(result.status).toBe('success')` | yes — with 3 retries (makeConfig uses maxFixAttempts: 3) | keep |
| commit-story-v2/acceptance-gate.test.ts | summarize.js | `expect(result.spansAdded).toBeGreaterThanOrEqual(3)` | yes — 3 async entry points | keep |
| commit-story-v2/acceptance-gate.test.ts | summarize.js | `expect(result.schemaExtensions.length).toBeGreaterThan(0)` | **conditional** — non-deterministic; the agent may correctly produce zero extensions if all attributes resolve from the existing registry | Change to: assert format only when extensions exist: remove the `> 0` guard; keep the `for ext of result.schemaExtensions { expect(ext).toMatch(...) }` loop. The loop is a no-op when empty. |
| commit-story-v2/acceptance-gate.test.ts | summarize.js | `for ext: expect(ext).toMatch(/^[a-z_]+(\.[a-z_]+)+$/)` | yes — format check | keep |
| commit-story-v2/acceptance-gate.test.ts | summarize.js | Rubric violation check | yes | keep |
| commit-story-v2/acceptance-gate.test.ts | journal-graph.js | `expect(result.status).toBe('success')` | **no** — see Explicit Questions section below | Change to partial-acceptable; see verdict below. |
| commit-story-v2/acceptance-gate.test.ts | journal-graph.js | `expect(result.spansAdded).toBeGreaterThanOrEqual(4)` | **conditional** — tied to status success; partial means fewer spans | Change to `toBeGreaterThanOrEqual(1)` (at least one span was added). |
| commit-story-v2/acceptance-gate.test.ts | journal-graph.js | `expect(result.schemaExtensions.length).toBeGreaterThan(0)` | **conditional** — non-deterministic | Same as summarize.js: remove the length guard, keep the format loop. |
| commit-story-v2/acceptance-gate.test.ts | journal-graph.js | `for ext: expect(ext).toMatch(...)` | yes | keep |
| commit-story-v2/acceptance-gate.test.ts | journal-graph.js | Rubric violation check | yes | keep |
| commit-story-v2/acceptance-gate.test.ts | summary-graph.js | `expect(result.status).toBe('success')` | **no** — see test-calibration-deferred.md Post-M4 Extension | Change to partial-acceptable (updated during M5 after acceptance gate run 25833556848 documented the first `partial` failure for this file — see test-calibration-deferred.md). |
| commit-story-v2/acceptance-gate.test.ts | summary-graph.js | `expect(result.spansAdded).toBeGreaterThanOrEqual(6)` | conditional — non-deterministic span count | keep — represents the desired target; the `>=` bound is permissive |
| commit-story-v2/acceptance-gate.test.ts | summary-graph.js | `expect(result.schemaExtensions.length).toBeGreaterThan(0)` | **conditional** — non-deterministic | Same fix as summarize.js. |
| commit-story-v2/acceptance-gate.test.ts | summary-graph.js | Rubric violation check | yes | keep |
| commit-story-v2/acceptance-gate.test.ts | sensitive-filter.js | `expect(result.status).toBe('success')` | yes — sync pre-screening, deterministic | keep |
| commit-story-v2/acceptance-gate.test.ts | sensitive-filter.js | `expect(result.spansAdded).toBe(0)` | yes — deterministic | keep |
| commit-story-v2/acceptance-gate.test.ts | sensitive-filter.js | `expect(result.schemaExtensions).toHaveLength(0)` | yes — deterministic | keep |
| commit-story-v2/acceptance-gate.test.ts | sensitive-filter.js | Rubric checks (syntax, API-001, NDS-005b) | yes — deterministic for unchanged code | keep |
| commit-story-v2/acceptance-gate.test.ts | journal-manager.js | `expect(result.status).toBe('success')` | yes — with retry | keep |
| commit-story-v2/acceptance-gate.test.ts | journal-manager.js | `expect(result.spansAdded).toBeGreaterThanOrEqual(2)` | yes — 2 async entry points | keep |
| commit-story-v2/acceptance-gate.test.ts | journal-manager.js | `expect(result.schemaExtensions.length).toBeGreaterThan(0)` | **conditional** — non-deterministic | Same fix as summarize.js. |
| commit-story-v2/acceptance-gate.test.ts | journal-manager.js | Rubric violation check | yes | keep |

---

## Explicit Questions

### journal-graph.js fixture

**Verdict: change to partial-acceptable**

**Rationale**: `status === 'success'` is not a realistic assertion for journal-graph.js while PRD #845 is open. The NDS-003 reconciler gap causes `partial` status on valid agent output — the agent correctly instruments the async exported function and some internal nodes, but the broken reconcilers reject the output for patterns the reconciler list does not handle. `partial` means the fix-loop ran all attempts and produced the best available output without full validation passing. This is a correct agent outcome mixed with a broken-validator outcome. There is no way to distinguish which is failing from the test result alone, which is exactly the calibration problem.

Changing to partial-acceptable means: `expect(['success', 'partial']).toContain(result.status)`. This keeps the regression value (confirming the file is processed, spans are added, and rubric violations are absent) without asserting on the part that depends on the broken validator.

`spansAdded >= 4` should become `spansAdded >= 1` — partial status means fewer spans were committed, but at least one span reaching the disk validates that the instrumentation path ran.

The `remove fixture` verdict is rejected: removing journal-graph.js would lose the only LangGraph pipeline test that exercises internal node instrumentation. Once PRD #845 is merged, the fixture should revert to `status === 'success'` and `spansAdded >= 4`. The change should include a comment: `// While PRD #845 (NDS-003 reconciler redesign) is open, partial is an acceptable outcome.`

---

### Schema extensions assertion

**Verdict: conditional-acceptable — already implemented correctly**

The Phase 5 hash-change assertion in `test/coordinator/acceptance-gate.test.ts` is already conditional (lines 575–588). The test guards the `schemaHashStart !== schemaHashEnd` assertion inside `if (anyExtensions)`, where `anyExtensions = result.fileResults.some(r => r.status === 'success' && r.schemaExtensions?.length > 0)`. This correctly:
- Passes when the LLM does not produce extensions (no false failure)
- Asserts hashes differ when extensions are produced (correctness when they are)

The schema hash _format_ assertions (`toMatch(/^[0-9a-f]{64}$/)`) are unconditional but only check format, not correctness. This is weak but acceptable — the format check confirms the field is populated and has the right shape. No change needed here.

**The only conditional-schema-extensions issue that needs M5 attention** is the `schemaExtensions.length > 0` assertions in `test/commit-story-v2/acceptance-gate.test.ts` (four tests: summarize.js, journal-graph.js, summary-graph.js, journal-manager.js). These are separate from the Phase 5 coordinator assertion.

---

### Hard-coded counts

Every instance of `=== 5` or `toBe(5)` in the coordinator acceptance tests that refers to the number of fixture files processed:

| Location | Assertion | Keep / replace / range |
|---|---|---|
| P4-1 line 256 | `expect(result.filesProcessed).toBe(5)` | Replace with `toBeGreaterThanOrEqual(5)` |
| P4-1 line 271 | `expect(nonSkipped.length).toBe(4)` | Replace with `toBe(result.filesProcessed - skippedResults.length)` |
| P4-1 line 310 | `expect(fileStartEvents.length).toBe(5)` | Replace with `toBe(result.filesProcessed)` |
| P4-1 line 311 | `expect(fileCompleteEvents.length).toBe(5)` | Replace with `toBe(result.filesProcessed)` |
| P4-1 line 316 | `expect(runCompleteResults).toHaveLength(5)` | Replace with `toHaveLength(result.filesProcessed)` |
| P4-1 line 323 | `expect(result.costCeiling.fileCount).toBe(5)` | Replace with `toBe(result.filesProcessed)` |
| P4-1 line 325 | `expect(result.costCeiling.maxTokensCeiling).toBe(5 * 80000)` | Replace with `toBe(result.filesProcessed * config.maxTokensPerFile)` |
| P4-1 line 326 | `expect(result.fileResults).toHaveLength(5)` | Replace with `toHaveLength(result.filesProcessed)` |
| P5-(a) line 595 | `expect(result.filesProcessed).toBe(5)` | Replace with `toBeGreaterThanOrEqual(5)` |

Note: `config.maxTokensPerFile` is `80000` from `makeConfig()`. The substitution `result.filesProcessed * config.maxTokensPerFile` is dynamic and requires passing `config` into the assertion scope, which it already is.

---

## Summary

### Tests that should be changed

These assertions have a non-"yes" verdict and are the M5 work list:

1. **P1 user-routes.js: NDS-003 in single-shot rubric check** — disable NDS-003 check (`{ nds003: false }`) while PRD #845 is open. The same file is covered by P3 through the fix loop (the production path). Single-shot NDS-003 failures are validator noise, not agent quality signals.

2. **P1 Test B: `attributeExtensions.length > 0`** — remove. Tests LLM will-invent, not correctness. The namespace check below it is the real assertion.

3. **P3 test 1 line 155: `errorProgression.length toBe validationAttempts`** — change `toBe` to `toBeGreaterThanOrEqual`. Function-level fallback appends extra entries; hard equality fails for those runs. Consistent with P3 test 5 (line 293) which already uses `>=`.

4. **P4-5: `errorProgression.length <= validationAttempts`** — change `<=` to `>=`. The comment says "length == validationAttempts for whole-file results" but `<=` allows missing entries to hide silently. Using `>=` matches P3's semantics and catches missing-entry bugs. The conditional (`functionsInstrumented === undefined`) remains in place.

5. **P4-1 + P5-(a): all hard-coded `=== 5` count assertions** (9 instances) — replace with dynamic references to `result.filesProcessed` or `>= 5`. See Hard-coded counts table above.

6. **journal-graph.js: `status === 'success'`** — change to `['success', 'partial'].toContain(result.status)`. Change `spansAdded >= 4` to `spansAdded >= 1`. Add comment referencing PRD #845. See Explicit Questions above.

7. **commit-story-v2 schema extensions `length > 0`** (4 tests: summarize.js, journal-graph.js, summary-graph.js, journal-manager.js) — remove the `length > 0` guard; keep the per-extension format loop. The loop is a no-op when empty and the format check is correct when extensions are present. This acknowledges that zero extensions is also a valid agent outcome.

### Tests that are sound

All remaining assertions (roughly 90+ across all files) are sound:

- Deterministic infrastructure assertions (token counts, file revert on failure, sync pre-screening behavior, callback event presence) — all correct and stable.
- Fix-loop success/failure contracts (budget exceeded, exhaustion revert, strategy matching) — all well-designed with conditional branching for both outcomes.
- already-instrumented.js skip detection — fully deterministic.
- Library detection (pre-scan deterministic) — sound.
- Advisory annotation structure checks — conditional and correct.
- Schema lifecycle mock assertions (createBaselineSnapshot, cleanupSnapshot, runLiveCheck called) — deterministic.
- M5 live-check SDK injection assertions — test real OTel behavior, correct.
- sensitive-filter.js sync pre-screening — fully deterministic.
- runSummarize inner-catch regression check (`result.failed.push`) — specific and correct.
- Rubric checks (NDS-001, NDS-004, NDS-005, API-001, CDQ-*) — sound for the assertions that do not involve NDS-003.
