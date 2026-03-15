# PRD: Validation Gap Coverage — Automate Unimplemented Scoring Checklist Rules

**Issue**: [#135](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/135)
**Status**: Draft
**Priority**: Low
**Created**: 2026-03-14

## What Gets Built

Automated validation checks for the 10 scoring checklist rules that currently rely solely on prompt compliance. The agent's scoring checklist has 32 rules; only 22 are enforced by the validation chain. This PRD closes that gap.

## Why This Exists

The agent's prompt tells the LLM to follow 32 rules, but only 22 have automated backstops in the validation chain. The remaining 10 rules are enforced only by the LLM's compliance with instructions — there's no automated catch when the LLM violates them. While violations are currently rare (the prompt is effective), automated validation provides:

- **Defense in depth**: catch violations that slip through prompt compliance
- **Regression detection**: automated checks don't degrade as the prompt evolves
- **Confidence in rule counts**: when we say "validated against 32 rules," all 32 should actually be checked

## Current State

### Rules with automated validation (22)

**Tier 1 (4 checks):**
- ELISION — elision detection (pattern scan + length ratio)
- SYNTAX — syntax checking (`node --check`)
- LINT — diff-based lint (Prettier)
- WEAVER — Weaver registry check

**Tier 2 (18 checks):**
CDQ-001, CDQ-006, CDQ-008, COV-001 through COV-006, NDS-003, RST-001 through RST-004, SCH-001 through SCH-004

### Rules without automated validation (10)

#### Group 1: Already checked under different names/mechanisms (3 rules)

These rules are enforced but not as named validation chain checks. The work here is naming unification and documentation, not new logic.

| Prompt Rule | Current Mechanism | Gap |
|-------------|-------------------|-----|
| NDS-001 (valid syntax) | Tier 1 `SYNTAX` check | Name mismatch only — validation exists under "SYNTAX" not "NDS-001" |
| NDS-002 (tests still pass) | Coordinator checkpoint (runs test suite every N files) | Not per-file — runs at checkpoint intervals, not after each file |
| RST-005 (no double-instrumentation) | `instrumentFile` pre-flight detection | Runs before LLM call, not in validation chain — can't catch LLM adding spans to already-instrumented functions |

#### Group 2: API dimension (4 rules)

Import and dependency checks. Straightforward to implement as AST-based or regex-based checks.

| Prompt Rule | Description | Implementation Approach |
|-------------|-------------|------------------------|
| API-001 | Only import from `@opentelemetry/api` | AST: scan import declarations for `@opentelemetry/sdk-*`, `@opentelemetry/exporter-*`, `@opentelemetry/instrumentation-*` in instrumented code |
| API-002 | `@opentelemetry/api` must be peerDependency (libraries) or dependency (apps) | Pre-instrumentation prerequisite (`checkOtelApiDependency`) enforces peerDependency only — fails if in dependencies, regardless of project type. Gap: no post-instrumentation re-check, and the library-vs-app distinction is not applied — apps using regular dependencies are incorrectly rejected. New work: post-instrumentation verification that respects project type. |
| API-003 | No vendor-specific SDKs | AST: scan imports for `dd-trace`, `@newrelic/*`, `@splunk/otel` |
| API-004 | No SDK internal imports | Same mechanism as API-001 — combined check |

#### Group 3: NDS structural checks (3 rules)

Require AST diffing between original and instrumented code. More complex to implement reliably.

| Prompt Rule | Description | Implementation Approach |
|-------------|-------------|------------------------|
| NDS-004 | No exported function signature changes | AST: compare exported function parameters and return types before/after |
| NDS-005 | No try/catch/finally restructuring | AST: compare try/catch/finally block structure before/after |
| NDS-006 | Match module system (ESM vs CJS) | AST: detect `import`/`export` vs `require`/`module.exports` in original; verify instrumented code uses the same system |

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| NDS-004/005 AST diffing produces false positives | Medium | Start advisory-only; promote to blocking after tuning against evaluation corpus |
| API checks overlap with existing lint rules | Low | Check if existing ESLint rules (such as no-restricted-imports) or custom AST validators already enforce the policy; avoid duplicate enforcement |
| NDS-006 module system detection is ambiguous for mixed files | Low | Use the original file's module system as ground truth; flag only when instrumented code introduces the wrong system |

## Acceptance Gate

| Criterion | Verification |
|-----------|-------------|
| All 32 prompt rules have corresponding automated enforcement | Audit: map each prompt rule to a validation chain check, prerequisite check, or coordinator checkpoint |
| API-001/003/004 catch forbidden imports | Test with fixtures containing `dd-trace`, `@opentelemetry/sdk-trace-node` imports |
| NDS-004 catches signature changes | Test with fixture where instrumented code adds a parameter to an exported function |
| NDS-005 catches try/catch restructuring | Test with fixture where instrumented code wraps existing try/catch in another try/catch |
| NDS-006 catches module system mismatch | Test with ESM original + CJS instrumented output |
| Existing test suite still passes | No regressions in current 1333+ tests |
| False positive rate acceptable | Run against evaluation corpus; advisory checks should have <5% false positive rate |

## Milestones

- [x] API dimension checks: implement API-001, API-003, API-004 as a combined Tier 2 check scanning imports for forbidden packages
- [x] API-002 post-instrumentation verification: verify `@opentelemetry/api` is listed as peerDependency (library projects) or dependency (app projects) after instrumentation, with fixtures for both project types
- [x] NDS-006 module system check: detect ESM vs CJS in original, verify instrumented code matches
- [x] NDS-004 signature preservation check: AST-diff exported function signatures before/after instrumentation
- [x] NDS-005 control flow preservation check: AST-diff try/catch/finally block structure before/after
- [x] RST-005 post-LLM validation: move double-instrumentation detection into the validation chain (complement to pre-flight)
- [x] Naming unification: align SYNTAX→NDS-001, document NDS-002 checkpoint behavior, ensure consistent rule IDs in CheckResult
- [x] Tests for all new checks with positive and negative fixtures

## Design Notes

- API checks (Group 2) are quick wins — simple import scanning, low false-positive risk, can be blocking from day one.
- NDS structural checks (Group 3) should start as advisory and be promoted to blocking after tuning. AST diffing is inherently fuzzy when the LLM restructures code for instrumentation (e.g., wrapping a function body in `startActiveSpan` callback necessarily changes the try/catch structure).
- The naming unification (Group 1) is cosmetic but reduces confusion when debugging validation failures. The `SYNTAX` check could emit `ruleId: 'NDS-001'` instead of `'SYNTAX'` — but this changes the CheckResult contract, so it should be coordinated with any consumers.
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-14 | Low priority — backlog after PRD #106 | Prompt compliance is currently effective; violations are rare. PRD #106 (function-level instrumentation) is the demo blocker for KubeCon EU (March 23). |
| 2026-03-14 | API checks blocking, NDS structural checks advisory initially | API import violations are unambiguous; NDS structural checks need tuning to avoid false positives from legitimate instrumentation restructuring |
