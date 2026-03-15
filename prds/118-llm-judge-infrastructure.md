# PRD: LLM-as-Judge Infrastructure for Semi-Automatable Validation Rules

**Issue**: [#118](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/118)
**Status**: Draft
**Priority**: Medium
**Created**: 2026-03-14

## What Gets Built

Shared infrastructure for calling an LLM to make semantic judgments on validation candidates flagged by scripts, plus judge implementations for three rules that the [evaluation rubric](../research/evaluation-rubric.md) classifies as semi-automatable.

## Why This Exists

### Spec vs Rubric vs Implementation Gap

The [telemetry agent spec](../docs/specs/telemetry-agent-spec-v3.9.md) (Two-Tier Validation Architecture section) defines Tier 2 checks as "concrete, AST-based, deterministic checks — not vague quality judgments." The spec intentionally scoped Tier 2 to automatable checks.

The [evaluation rubric](../research/evaluation-rubric.md) (Automation Classification section) goes further: "All [three non-fully-automatable rules] are strong candidates for LLM-as-judge evaluation — a script + LLM judge pipeline could bring the effective automation rate to 32/32, fully automatable with no specialized human knowledge required."

The implementation brought the script-only portions of these rules into the Tier 2 fix loop but left the semantic judgment gaps unaddressed:

| Rule | Rubric Classification | Script Portion (implemented) | Semantic Gap (not implemented) |
|---|---|---|---|
| [SCH-004](../src/validation/tier2/sch004.ts) | Semi-automatable | Jaccard token similarity >0.5 catches obvious duplicates | Cannot catch semantic equivalence across naming conventions (e.g., `request.latency` vs `http.request.duration`) |
| [SCH-001](../src/validation/tier2/sch001.ts) | Mixed-mode | Registry mode: exact string match. Fallback: regex cardinality check | Naming quality fallback cannot assess whether invented span names are "meaningful" or follow conventions |
| NDS-005 | Semi-automatable | **Not implemented at all** — no file, not in [index](../src/validation/tier2/index.ts), not in [chain](../src/validation/chain.ts) | AST detection of error handling structural changes + semantic preservation judgment |

The rubric (Automation Classification table) defines semi-automatable as: "Script provides partial signal but cannot produce a definitive pass/fail; requires semantic judgment to interpret. Script flags candidates; human or LLM judge makes the call."

### Value of Inner-Loop Judges

An LLM judge in the fix loop can tell the agent: "you created attribute `commit_story.git.subcommand` but the registry already has `commit_story.git.command` which captures the same concept — use the registered key." The agent fixes it on the next attempt. Without the judge, the token similarity script misses this (different tokens), and the agent ships a redundant attribute.

The cost per judge call is low (~$0.001 with Haiku). A file with 3 flagged candidates across 2 attempts = 6 calls = ~$0.006. The value is avoiding redundant schema entries that fragment telemetry queryability.

## Design

### Judge Infrastructure

New module `src/validation/judge.ts` providing:

```typescript
interface JudgeQuestion {
  ruleId: string;
  context: string;      // What the script found (the flagged candidate)
  question: string;     // What the judge should decide
  candidates: string[]; // Registry entries to compare against (if applicable)
}

interface JudgeVerdict {
  answer: boolean;           // Does this pass the semantic check?
  suggestion?: string;       // Concrete fix if it fails (e.g., "use registered key X")
  confidence: number;        // 0-1, for logging/debugging
}
```

The judge infrastructure handles:
- LLM API call with a focused judge prompt (separate from the instrumentation agent prompt)
- Cost tracking (judge calls are tracked separately from instrumentation calls)
- Error handling (judge failure = fall back to script-only verdict, never blocks the pipeline)
- Model selection (use a fast/cheap model — Haiku — since judge questions are short and well-scoped)
- Privacy/data minimization (see below)

#### Privacy and Data Handling

Judge prompts receive code context (attribute names, span names, error handling structures). To minimize exposure of sensitive data:

- Judge prompts receive **identifiers only** (attribute keys, span names, function signatures) — not full source code or file contents
- String literals, constants, and variable values are excluded from judge context unless semantically necessary (e.g., enum values for type checking)
- The same API key and data-handling policies that govern the instrumentation agent apply to judge calls — no additional data exposure beyond what the agent already sees
- Judge prompts are logged at the same level as instrumentation prompts for auditability

### Integration with Validation Chain

The judge runs **inside the existing Tier 2 validation**, after the script flags candidates. The flow for each semi-automatable rule:

1. Script runs (existing code) → flags candidates
2. If candidates flagged and judge is available → call judge for each candidate
3. Judge verdict replaces the script's uncertain "maybe" with a definitive pass/fail + suggestion
4. Result feeds into fix loop feedback as normal

If the judge is unavailable (API error, cost limit), the script's existing behavior is preserved — the check degrades gracefully to script-only mode.

### Per-Rule Implementation

#### Milestone 1: SCH-004 — Redundant Schema Entries (advisory)

**Current**: [sch004.ts](../src/validation/tier2/sch004.ts) uses Jaccard token similarity. Advisory (non-blocking). Catches `http_request_duration` vs `http.request.duration` but misses `request.latency` vs `http.request.duration`.

**With judge**: When the script finds a novel attribute key with no high-similarity match, the judge asks: "Does attribute `{new_key}` capture the same concept as any of these registered keys: `{registry_keys}`? If yes, which one?" If the judge finds a semantic match, the advisory feedback includes a concrete suggestion: "use `{matched_key}` instead of `{new_key}`."

**Why first**: Lowest risk — already advisory, so a wrong judge verdict doesn't block anything. Proves the infrastructure works before applying it to blocking checks.

#### Milestone 2: SCH-001 — Span Naming Quality (blocking in fallback mode)

**Current**: [sch001.ts](../src/validation/tier2/sch001.ts) has two modes. Registry mode (exact match) is automatable and needs no judge. Naming quality fallback (when registry has no span definitions) only checks cardinality — it can't assess naming quality.

**With judge**: In fallback mode, after the cardinality check passes, the judge asks: "Does span name `{name}` follow the `<namespace>.<category>.<operation>` convention? Is it descriptive and bounded? The project namespace is `{namespace}`." The judge can suggest a better name if the current one is vague.

**Note**: This only activates when the registry lacks span definitions. For well-configured registries, the existing exact match is sufficient.

**Reliability policy for blocking verdicts**: Since SCH-001 fallback is blocking (triggers retry), judge reliability matters. A wrong verdict wastes a retry attempt. Safeguards:
- Judge verdicts with `confidence < 0.7` are downgraded from blocking to advisory — the agent sees the suggestion but isn't forced to act on it
- If the judge returns an error or times out, the check falls back to the script-only cardinality check (pass if no unbounded patterns)
- Judge verdicts are included in the validation feedback so the agent (and humans reviewing the output) can see what the judge decided and why

#### Milestone 3: NDS-005 — Error Handling Preservation (new rule)

**Current**: Not implemented. No file exists.

**With judge**: Two-part implementation:
1. **Script** (new): AST analysis detecting structural changes to pre-existing `try`/`catch`/`finally` blocks in the agent's diff — reordered catch clauses, merged error handling blocks, modified throw statements.
2. **Judge**: When the script flags a structural change, the judge asks: "Does the restructured error handling preserve the original propagation semantics — exception types, re-throw behavior, and catch clause ordering?"

**Dependency**: NDS-005 judge verdicts feed into the refactor recommendation system ([PRD #111](../prds/111-refactor-recommendations.md)). When the judge determines error handling was restructured in a non-preserving way, this becomes a candidate for a refactor recommendation rather than just a blocking failure.

**Why last**: Requires building the script from scratch (AST error handling diffing) before the judge can run. Most complex milestone.

## Milestones

- [x] Judge infrastructure: `src/validation/judge.ts` with LLM call, cost tracking, graceful fallback, and test coverage
- [x] SCH-004 judge integration: semantic equivalence check for flagged novel attribute keys, with advisory feedback including concrete "use X instead" suggestions
- [ ] SCH-001 judge integration: naming quality assessment in fallback mode, with convention-following suggestions
- [ ] NDS-005 script: AST detection of structural changes to pre-existing error handling blocks
- [ ] NDS-005 judge integration: semantic preservation check for flagged error handling changes, feeding into refactor recommendations
- [ ] Integration test: full pipeline with registry that triggers all three judge-enhanced rules

## Success Criteria

1. SCH-004 catches semantic duplicates that Jaccard similarity misses (e.g., `request.latency` vs `http.request.duration`)
2. SCH-001 fallback mode produces actionable naming suggestions instead of only cardinality checks
3. NDS-005 exists and detects error handling restructuring that the current validation chain misses entirely
4. Judge failures degrade gracefully — script-only results are used, pipeline is never blocked by judge unavailability
5. Judge cost is tracked separately and visible in token usage reporting
6. The effective automation rate moves from 29/32 toward 32/32 as described in the rubric

## Design Notes

- Judge uses Haiku for cost efficiency — judge questions are short, well-scoped, and don't need deep reasoning
- Judge calls are injectable (dependency injection) for testing — tests use mock judges, not real API calls
- The spec (Two-Tier Validation Architecture section) says Tier 2 checks should be "deterministic." Adding LLM judges makes them non-deterministic. This is an intentional deviation from the spec, justified by the rubric's recommendation. The decision log captures this.
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

## Decision Log

| Date | Decision | Context |
|------|----------|---------|
| 2026-03-14 | One PRD for all three rules | Shared judge infrastructure is the hard part; per-rule logic is "what question to ask." Building it three times as three issues would duplicate infrastructure. |
| 2026-03-14 | SCH-004 first | Lowest risk — already advisory, wrong verdicts don't block. Proves infrastructure before applying to blocking checks. |
| 2026-03-14 | NDS-005 last | Requires new script (AST error handling diff) before judge can run. Most complex. Also depends on PRD #111 (refactor recommendations) for output integration. |
| 2026-03-14 | Inner-loop judges, not post-run only | The agent can fix naming and attribute issues on retry. Post-run-only judges report problems without fixing them. Inner-loop judges produce better output for the same API cost. |
| 2026-03-14 | Graceful fallback on judge failure | Judge unavailability should never block the pipeline. Script-only results are always available as fallback. |
| 2026-03-14 | Intentional spec deviation | Spec says Tier 2 should be deterministic. Rubric says semi-automatable rules are candidates for LLM judges. We follow the rubric's recommendation here — the spec was written before the rubric refined the automation classifications. |
| 2026-03-14 | Identifiers only in judge prompts | Judge receives attribute keys, span names, function signatures — not full source code. Minimizes sensitive data exposure while providing enough context for semantic judgment. |
| 2026-03-14 | Confidence threshold for blocking verdicts | Judge verdicts with confidence < 0.7 are downgraded from blocking to advisory. Prevents low-confidence judgments from wasting retry attempts. |
