# PRD: Refactor Recommendations for Uninstrumentable Files

**Issue**: [#111](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/111)
**Status**: Draft
**Priority**: Medium
**Created**: 2026-03-14

## What Gets Built

A structured recommendation system that surfaces code refactors users should make before re-running the agent on files that failed instrumentation. When the agent identifies code patterns blocking safe instrumentation, it produces actionable refactor recommendations instead of silent failures.

## Why This Exists

### 19% File Failure Rate With No Actionable Feedback

In run-3 evaluation against commit-story-v2, 4/21 files (19%) produced zero instrumentation:

| File | Lines | Failure Mode | Root Cause |
|------|-------|-------------|------------|
| `journal-graph.js` | 500+ | Oscillation | LangGraph state machine too complex for whole-file |
| `sensitive-filter.js` | 236 | Null parsed output | Regex patterns may corrupt JSON |
| `context-integrator.js` | ~200 | NDS-003 violation | Agent needs to extract expression to `const` for `setAttribute` capture |
| `journal-manager.js` | ~300 | 5 NDS-003 + 3 COV-003 | Agent attempts restructuring that violates non-destructiveness |

For `context-integrator.js`, the agent tried the same const-extraction transform across all 3 attempts — demonstrating genuine need, not a mistake. For `journal-manager.js`, 5 NDS-003 violations across all attempts indicate the file needs restructuring the agent correctly refuses to make.

### NDS-003 Is Working As Designed

The agent's non-destructive guarantee (NDS-003) correctly blocks these transforms. Loosening the validation would undermine the core safety property. The right answer is not "let the agent make debatable changes" but "tell the user what to change."

Note: `catch {}` → `catch (error) {}` is being fixed separately in issue [#100](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/100) — that transform is required by the OTel spec and is zero-risk, so it belongs in NDS-003's allowlist, not in the recommendation system.

### No Prior Art for This Problem

Research found no formal concept of "instrumentation-motivated refactors" in the OTel community:

- The [OTel exceptions spec](https://opentelemetry.io/docs/specs/otel/trace/exceptions/) shows attribute extraction from existing variables but never extracts expressions into new variables
- The [OTel Python instrumentation docs](https://opentelemetry.io/docs/languages/python/instrumentation/) demonstrate adding spans and status recording but not code restructuring
- [Dash0 Agent Skills](https://www.dash0.com/changelog/agent-skills-release), the closest prior art for AI instrumentation agents, have no concept of transformation safety or validation rules
- [Anthropic's evals guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) recommends grading "what the agent produced, not the path it took" — but that assumes the agent can produce output. When it can't, the diagnosis is the valuable output.

This is novel territory. AI instrumentation agents with validation rules don't exist in the OTel ecosystem — orb is pioneering this, and the recommendation system is the user-facing answer to the question "why did my file fail?"

## Design

### Core Data Structure

New `suggestedRefactors` field on `FileResult`:

```typescript
interface SuggestedRefactor {
  /** Human-readable description of the refactor */
  description: string;
  /** Code diff showing the change (unified diff format) */
  diff: string;
  /** Why the agent needs this change to instrument correctly */
  reason: string;
  /** Which validation rule(s) the current code pattern triggers */
  unblocksRules: string[];
  /** File path and line range */
  location: { filePath: string; startLine: number; endLine: number };
}
```

### Detection Strategy

Refactor recommendations are generated when:

1. A file exhausts all fix attempts (max retries reached)
2. The same NDS-003 violation repeats across **at least 2 consecutive attempts** at the same line number and rule ID (persistence signal — the agent genuinely needs this transform)
3. The LLM's output consistently contains the same non-instrumentation change across those attempts

Detection happens in the fix loop after retry exhaustion, by comparing the `ruleId:filePath:lineNumber` keys of NDS-003 violations across the error progression. A recommendation is only generated when the same violation key appears in 2+ consecutive attempts — single-occurrence violations are not surfaced as recommendations.

### LLM Integration

The system prompt gains guidance telling the LLM to report transforms it would need to make but can't:

- When the LLM encounters a pattern it can't instrument without modifying business logic, it reports the needed transform in a `suggestedRefactors` field in its structured output
- The fix loop collects these across attempts and deduplicates

### Output Integration

Recommendations surface in three places:

1. **`FileResult.suggestedRefactors`** — programmatic access for tooling
2. **PR summary** — new "Recommended Refactors" section listing each recommendation with description and unblocked rules (diffs are omitted from PR summaries to avoid leaking source code in public PRs)
3. **CLI output** — summary line per file with recommendations count, full diffs available via `--verbose` flag

#### Redaction

Recommendation diffs contain user source code. To avoid leaking sensitive literals or proprietary logic:
- PR summary shows description + rule + location only — no source diffs
- CLI output shows full diffs only in `--verbose` mode (local terminal, not persisted)
- `FileResult.suggestedRefactors` includes full diffs for programmatic consumers (CI tooling, local scripts) — these are not rendered to external-facing outputs by default

### User Workflow

1. Run `orb instrument` → some files fail with recommendations
2. Review recommendations in PR summary or CLI output
3. Apply recommended refactor to the source file
4. Run the project's test suite to verify the refactor is safe
5. Re-run `orb instrument` on the specific file → instrumentation succeeds

## Milestones

- [x] `SuggestedRefactor` type defined in `FileResult` with full test coverage for the type and serialization
- [x] LLM output schema extended with `suggestedRefactors` field; prompt guidance instructs LLM to report needed-but-blocked transforms
- [x] Fix loop detects persistent NDS-003 patterns across retry attempts and collects refactor recommendations
- [ ] PR summary renders "Recommended Refactors" section with diffs and unblocked rules
- [ ] CLI output surfaces recommendation count per file and summary
- [ ] Integration test: file with known NDS-003-blocking pattern produces correct recommendation with actionable diff

## Success Criteria

1. Files that previously failed silently now produce actionable recommendations
2. Recommendations include enough context (diff + reason + rule) for a developer to apply them confidently
3. After applying a recommendation and re-running, the file instruments successfully
4. NDS-003 validation remains unchanged — the agent still cannot make these transforms itself
5. Default behavior for files that instrument successfully is unchanged — no recommendations clutter

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- Recommendations are advisory only — they never block the agent's workflow or gate PR creation
- Recommendations are only surfaced when backed by observed validator evidence: the recommendation must cite a specific `ruleId` and the violation must appear in the error progression from the retry loop. LLM-suggested refactors without a corresponding validator finding are suppressed.

## Decision Log

| Date | Decision | Context |
|------|----------|---------|
| 2026-03-14 | Recommendations over NDS-003 loosening | The agent's non-destructive guarantee is a core safety property. Loosening it for "probably safe" transforms undermines trust. Instead, surface the diagnosis and let humans decide. |
| 2026-03-14 | Exclude catch-binding from recommendations | `catch {}` → `catch (error) {}` is required by the OTel spec (every example uses bound error variables). Zero behavioral risk. Being fixed directly in NDS-003 via issue #100. |
| 2026-03-14 | Detect via persistence signal, not heuristics | If the agent makes the same NDS-003-violating change across all retry attempts, that's a genuine need signal — not a heuristic guess. Cross-attempt consistency is the strongest indicator. |
| 2026-03-14 | Promoted from issue #100 scope | Originally part of #100 (NDS-003 safe refactors). The catch-binding fix stays in #100; const extraction and restructuring became this PRD after discussion showed they need a recommendation UX, not a validation bypass. |
