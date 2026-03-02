# Phase PRD Template

Use this template when creating phase PRDs. Fill in each section from the source documents identified during the routing step. Sections marked [FROM: source] indicate where to find the content.

---

````markdown
# PRD: Phase N — [Phase Name]

**Issue**: [#issue-id](link)
**Status**: Not Started
**Priority**: High
**Blocked by**: [Phase N-1 PRD, if applicable]
**Created**: [date]

## What Gets Built

[FROM: implementation-phasing.md -> Phase N -> "What Gets Built"]
Copy this section verbatim. It defines the scope boundary.

## Why This Phase Exists

[FROM: implementation-phasing.md -> Phase N -> "Why This Boundary"]
2-3 sentences explaining the dependency rationale. This helps the implementing AI understand what NOT to build (anything outside this boundary).

## Acceptance Gate

[FROM: implementation-phasing.md -> Phase N -> "Acceptance Gate"]
Copy verbatim, then expand each criterion into a testable verification step:

| Criterion | Verification | Rubric Rules |
|-----------|-------------|--------------|
| [gate criterion 1] | [how to test it] | [rule IDs] |
| [gate criterion 2] | [how to test it] | [rule IDs] |

## Cross-Cutting Requirements

### Structured Output (DX Principle)

[FROM: implementation-phasing.md -> "Cross-Cutting: The DX Principle" -> this phase's specific requirement]
Copy the specific DX requirement for this phase (e.g., Phase 1: "The function must return structured results — not fail silently. If prerequisites fail, the error says why.")

### Two-Tier Validation Awareness

[FROM: implementation-phasing.md -> "Two-Tier Validation Architecture"]
Brief note on how this phase relates to the two-tier validation design:
- Phase 1: Not yet applicable — basic elision rejection only
- Phase 2: Implements both tiers; Tier 2 proof-of-concept with CDQ-001 and NDS-003
- Phase 3: Fix loop consumes both tiers
- Phase 4: Additional Tier 2 checks enabled by multi-file context
- Phase 5: Weaver-specific Tier 2 checks
- Phases 6-7: Tiers are internal; interfaces format the output

## Tech Stack

[FROM: tech-stack-evaluation.md -> sections identified by tech-stack-by-phase.md routing]

For each relevant technology, include:

### [Technology Name]
- **Version**: [exact version, e.g., "@anthropic-ai/sdk v0.78.0"]
- **Why**: [1 sentence from recommendation]
- **API Pattern**: [Include a javascript code block with the snippet copied verbatim from tech-stack-evaluation.md. All samples are JavaScript with ESM imports.]
- **Caveats**: [list any limitations that affect THIS phase]

## Rubric Rules

### Gate Checks (Must Pass)

[FROM: evaluation-rubric.md -> look up each gate rule ID listed in the phase definition]

| Rule | Name | Scope | Impact | Description |
|------|------|-------|--------|-------------|
| [ID] | [name] | [scope] | [impact] | [full description] |

### Dimension Rules

[FROM: evaluation-rubric.md -> look up each dimension rule ID listed in the phase definition]

For Phase 2+, classify each rule:

| Rule | Name | Tier | Blocking? | Description |
|------|------|------|-----------|-------------|
| [ID] | [name] | [1 or 2] | [Yes/No] | [full description] |

**Automation classification**: Note which rules are Automatable vs Semi-automatable, as this determines whether they can become validation chain stages.

## Spec Reference

[FROM: implementation-phasing.md -> Phase N -> "Spec Sections" table]

Reproduce the table and add line number ranges:

| Section | Scope | Lines | Notes |
|---------|-------|-------|-------|
| [section name] | [Full/Subsection/Fields] | [start-end] | [from phasing doc] |

**Spec file**: `docs/specs/telemetry-agent-spec-v3.9.md`

The implementing AI should read each listed section. "Full" means read the entire section. "Subsection only" means read only the named part. "Fields only" means extract just the configuration field definitions.

## Milestones

Define 5-8 milestones that incrementally build toward the acceptance gate. Each milestone must be independently testable.

- [ ] **Milestone 1: [Name]** — [What to build and how to verify it]
- [ ] **Milestone 2: [Name]** — [What to build and how to verify it]
- [ ] ...
- [ ] **Milestone N-1: DX verification** — [The phase's specific DX requirement is met: structured results, no silent failures, errors explain why]
- [ ] **Milestone N: Acceptance gate passes** — [Full acceptance gate, end-to-end]

### Milestone Design Guidance

- Earlier milestones should be foundational (e.g., "config validation works" before "LLM call succeeds")
- Each milestone builds on previous ones — the implementing AI should be able to verify each milestone before moving to the next
- Include at least one milestone for the DX cross-cutting requirement
- The final milestone should be the full acceptance gate, tested end-to-end against a real project (not synthetic inputs)
- Where a milestone directly satisfies a rubric rule, note the rule ID (e.g., "Tier 1 syntax check works → NDS-001"). Not every milestone maps to a rubric rule — include the mapping where it's real; omit it where it isn't.

## Dependencies

[List what must exist before this phase can start]

- **Phase N-1**: [what it provides that this phase needs — omit for Phase 1]
- **External**: [any external dependencies — Node.js 24.x, Weaver CLI, Anthropic API key, test JavaScript project, npm packages]

Note: Phase 1 has no predecessor phase. Its dependencies are all external.

## Out of Scope

[List what this phase explicitly does NOT build — derived from the phase boundary in the phasing document]

- [capability deferred to Phase X]
- [capability deferred to Phase Y]

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|

## Open Questions

[Any unresolved decisions that the implementing AI may need to make]
````
