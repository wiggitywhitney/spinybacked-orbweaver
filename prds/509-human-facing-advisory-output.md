# PRD #509: Human-facing advisory output

**Status**: Draft
**Priority**: Medium
**GitHub Issue**: [#509](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/509)
**Created**: 2026-04-20
**Blocked by**: Not blocked. PRD #505 (CDQ-008 deletion) and PRD #508 (SCH-004 deletion, SCH-005 audit) have both merged — the rule list is stable. M1–M5 can proceed.
**Source**: PRD #483's Downstream PRD candidate "Human-facing advisory output" in `docs/reviews/advisory-rules-audit-2026-04-15.md`

---

## Problem

Every validation rule's `message` field is written for agent consumption — terse, directive, and assumes technical context. The agent reads these messages during the fix-loop and uses them to correct instrumentation. Example of an agent-correct message (COV-005 — domain attributes present):

> "Required (must add): db.query.text, db.system.name. Recommended (should add): db.row_count. Add setAttribute() calls for each listed attribute."

That message works well when the agent reads it. The problem is that the same message surfaces to humans in three output paths:

1. **CLI verbose output** — agent reasoning notes shown during a run (e.g., `Note: Skipping formatDate per RST-001 (No Utility Spans)`).
2. **PR summary file** — `spiny-orb-pr-summary.md` committed alongside instrumentation changes; advisory findings appear under "Review Attention."
3. **Per-file reasoning reports** — companion markdown files list all advisory findings with rule codes and labels.

A human reading "Add setAttribute() calls for each listed attribute" in a PR summary gets an instruction written for an agent. They don't get the context they need: what does COV-005 check? Why does this finding matter? What should they do about it — fix it, accept it, or ignore it?

A human-facing version of the same COV-005 finding would read something like:

> "COV-005 (domain attributes present) fired because spans in `db.js` are missing attributes the registry marks as required for database operations (`db.query.text`, `db.system.name`). These attributes are how the spans become useful in dashboards — without them, you can see a database span happened but not which query or system. Either add the attributes in a follow-up commit, or remove the span if the operation isn't worth tracking."

That's readable by someone who wasn't in the conversation that produced the finding.

The current state: all advisory messages (and many blocking messages) are stuck at the agent-facing level. The humans who read PR summaries and reasoning reports bear the cognitive cost.

---

## Solution

Add a parallel human-facing description for each rule that surfaces to humans. Human-facing text runs alongside the agent-facing `message` field; it never replaces it. The agent continues to read the terse `message` in the fix-loop and rely on its current format. Output paths destined for humans (CLI verbose, PR summary, reasoning reports) pick up the new human-facing description and display it instead of — or alongside — the agent-facing message.

Three mechanisms under consideration; pick one in Milestone M1:

1. **`humanMessage` field on `CheckResult`.** Each rule's check function returns both `message` and `humanMessage`. Output paths choose which field to display based on audience. Pro: data flows with the finding; no registry lookup needed. Con: every rule's check function grows a new responsibility; rule file diffs get larger.

2. **Dedicated report module.** A separate module (e.g., `src/output/human-report.ts`) formats findings for human consumption, looking up human-facing text from a registry keyed by rule ID. Pro: keeps rule files focused on detection. Con: adds a module; output paths must route through it.

3. **Per-rule description registry.** A single source of truth (e.g., `src/validation/rule-descriptions.ts` or a YAML/JSON file at `docs/rule-descriptions.yaml`) maps rule ID → human-facing description. Output paths read from this registry directly. Pro: single source of truth; easy to review all descriptions together; non-code change when descriptions are updated. Con: descriptions disconnected from rule code — could drift if a rule's detection logic changes without updating the registry.

Each option has tradeoffs; the decision happens in Milestone M1 after reading the audit document and considering long-term maintenance cost.

---

## Scope

### In scope
- Choose and implement one of the three mechanisms above
- Write human-facing descriptions for every validation rule that surfaces to humans (advisory + blocking)
- Wire at least two output paths to use the human-facing descriptions (CLI verbose OR PR summary as the first path in M3; the remaining path in M6)
- Verify end-to-end: every rule has a description that renders correctly in every wired output path
- Update `docs/rules-reference.md` to reflect the new mechanism

### Not in scope
- Modifying existing `message` fields (agent behavior depends on the current terse format — this is a hard constraint)
- Changing the detection logic of any rule
- Adding new rules
- Translating descriptions into other languages

---

## Rule scope

All validation rules whose findings ever surface to humans. PRD #505 (CDQ-008 deleted) and PRD #508 (SCH-004 deleted, SCH-005 deleted, SCH-001/002 rebuilt as unconditionally blocking) have both merged. Final rule list:

**Advisory rules** (non-blocking, surface to humans via PR summary and reasoning reports):
- CDQ-006 (expensive attribute computation guarded)
- CDQ-007 (attribute data quality — PII names, filesystem paths, nullable access)
- CDQ-009 (undefined guard on span attribute values)
- CDQ-010 (untyped string method on property access)
- COV-004 (async operations have spans)
- COV-005 (domain-specific attributes present)
- RST-001 (no spans on utility functions)
- RST-002 (no spans on trivial accessors)
- RST-003 (no duplicate spans on thin wrappers)
- RST-004 (no spans on internal implementation details)
- RST-005 (no double-instrumentation)
- API-002 (`@opentelemetry/api` dependency placement)

**Blocking rules** (surface to humans via CLI error output and PR summary):
- NDS-001 (syntax valid), NDS-002 (tests pass), NDS-003 (code preserved), NDS-004 (signatures preserved — promoted in audit), NDS-005 (control flow preserved — promoted in audit), NDS-006 (module system match — promoted in audit), NDS-007 (expected-condition catch blocks — new rule from audit)
- COV-001 (entry point spans), COV-002 (outbound call spans), COV-003 (error recording), COV-006 (auto-instrumentation preference)
- API-001 (non-API OTel package imports forbidden — promoted in audit), API-004 import-level (SDK internal packages forbidden — promoted in audit)
- SCH-001 (span names match registry — unconditionally blocking; naming quality fallback is deterministic), SCH-002 (attribute keys match registry — unconditionally blocking), SCH-003 (attribute values conform)
- ELISION, LINT, WEAVER
- CDQ-001 (spans closed), CDQ-002 (tracer acquired), CDQ-003 (standard error recording), CDQ-005 (count attribute types)

PRD #505 and PRD #508 have both merged — the rule list above is final.

---

## Decision Log

_Decisions will be added as design questions are resolved during implementation._

---

## Design Notes

- **Critical constraint (inherited from PRD #483 Action Items):** Do NOT modify existing `message` fields. The agent depends on the current terse, directive format for fix-loop correction. Adding human-facing text inline to existing messages would change the text the agent reads and could alter its correction behavior. Human-facing descriptions are strictly additive.
- **Writing style for human-facing descriptions**: each description explains (1) what the rule checks, (2) why a fired finding matters in practical terms, and (3) what the human should do about it — fix, accept, or ignore. Target length: 3-4 sentences, terse enough to fit in a PR annotation. Avoid jargon that requires cross-referencing another document; if a term must be used, briefly gloss it the first time.
- **Rule ID introduction convention** (from project CLAUDE.md): each human-facing description introduces the rule by its plain-English meaning alongside the ID on first use — e.g., "COV-005 (domain attributes present) fired because…" not "COV-005 fired because…".
- **Sequencing with #505 and #508**: Both PRDs have merged. CDQ-008, SCH-004, and SCH-005 are deleted; SCH-001/002 are now unconditionally blocking. All milestones (M1–M6) can proceed.
- **Rules-related PRD** per the project CLAUDE.md convention. Both rules-related conventions apply: read the audit document at the start of every milestone; update `docs/rules-reference.md` as the final PRD step.
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

---

## Milestones

**Every milestone begins with Step 0**: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full. When uncertain whether a change impacts a rule or its documentation, treat it as rules-related.

### Milestone M1: Decide the mechanism (humanMessage field, report module, or description registry)

Evaluate the three mechanisms against this project's existing patterns. Consider: (a) how the rule check functions currently return `CheckResult` — does adding a `humanMessage` field fit cleanly?; (b) whether output paths already have a shared formatting layer (if yes, a report module fits naturally); (c) long-term maintenance cost of keeping descriptions in sync with rule behavior (registry-based approach has highest drift risk; in-check-function approach has lowest).

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [ ] Read `src/validation/types.ts` for the current `CheckResult` shape
- [ ] Read at least three existing rule check functions (e.g., `cov004.ts`, `rst001.ts`, `sch001.ts`) to understand how they currently build `message`
- [ ] Read the CLI verbose output code and the PR summary generator to understand how `message` currently reaches humans
- [ ] Decision recorded in this PRD's Decision Log: Option 1 (`humanMessage` field), Option 2 (dedicated report module), or Option 3 (description registry), with rationale covering maintenance, drift risk, and integration cost

### Milestone M2: Implement the chosen mechanism (infrastructure only)

Build the infrastructure for the mechanism chosen in M1. No rule text written yet — this milestone wires up the plumbing and adds one placeholder description for a single rule to prove the mechanism works end-to-end.

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [ ] Mechanism implemented per M1's decision (new field on `CheckResult`, new report module, or new description registry)
- [ ] A single placeholder human-facing description wired up for one rule (e.g., COV-005) as a smoke test — verify it reaches the intended output without changing agent-facing message behavior
- [ ] Existing `message` fields unchanged — agent behavior in the fix-loop is unaffected (verified by running the acceptance gate and confirming no regression)
- [ ] Unit tests for the new mechanism (type checks, presence checks, fallback behavior when a rule has no human-facing description yet)
- [ ] `npm test` passes; `npm run typecheck` passes

### Milestone M3: Wire the first output path to use the new mechanism

Pick one output path (CLI verbose output OR PR summary file) and wire it to display human-facing descriptions when present. If a rule doesn't have a human-facing description yet (pre-M4), the output path falls back to the agent-facing `message` gracefully — no broken UI.

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [ ] Chosen output path updated to prefer `humanMessage` / description-registry lookup / report-module output over the agent-facing `message`
- [ ] Fallback to agent-facing `message` when no human description is registered — tested
- [ ] Integration test covering both cases: a rule with a human description (COV-005 from M2) and a rule without one (pick any)
- [ ] `npm test` passes; `npm run typecheck` passes

### Milestone M4: Write human-facing descriptions for all advisory rules

Write human-facing descriptions for every advisory rule per the writing-style guide in Design Notes. The advisory rule list in the "Rule scope" section is final — PRD #505 and PRD #508 have both merged.

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [ ] Human-facing descriptions written for each advisory rule (list from the "Rule scope" section above)
- [ ] Each description follows the writing style: (a) what the rule checks, (b) why a finding matters, (c) what the human should do. Length: 3-4 sentences. Rule ID introduced with plain-English meaning on first use per project CLAUDE.md convention.
- [ ] Descriptions surface correctly in the output path wired in M3 — manually verified on a test run
- [ ] `npm test` passes; `npm run typecheck` passes

### Milestone M5: Write human-facing descriptions for all blocking rules

Same as M4 but for blocking rules. Blocking rules surface to humans via CLI error output and PR summary when they fire; their descriptions need the same clarity.

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [ ] Human-facing descriptions written for each blocking rule (list from the "Rule scope" section above)
- [ ] Each description follows the writing-style guide from M4
- [ ] Descriptions surface correctly in the output path wired in M3 for a blocking-rule fixture (manually verified)
- [ ] `npm test` passes; `npm run typecheck` passes

### Milestone M6: Wire the remaining output path(s)

Pick up whichever output path wasn't wired in M3. Also wire per-file reasoning reports if they don't already reuse the M3 wiring through shared infrastructure.

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [ ] Remaining output path wired (whichever of CLI verbose / PR summary wasn't done in M3)
- [ ] Per-file reasoning reports wired if needed
- [ ] Integration tests cover end-to-end flow from rule fire through the new output path
- [ ] `npm test` passes; `npm run typecheck` passes

### Milestone M7: Update rule documentation and close out

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [ ] `docs/rules-reference.md` updated via `/write-docs` to mention the new human-facing mechanism and where human-facing descriptions live (e.g., "Each rule has a human-facing description in `src/validation/rule-descriptions.ts` — see that file for the current text.")
- [ ] `docs/ROADMAP.md` updated to reflect PRD #509 complete
- [ ] PRD #483 audit document's Action Items section updated to mark "Human-facing advisory output" complete with a link to this PRD
- [ ] Sample PR summary from a test run attached to the final commit or linked from the PROGRESS.md entry — demonstrates the new human-facing output in action
- [ ] **Prompt verification** (per project CLAUDE.md Rules-related work conventions): grep `src/agent/prompt.ts` for rule-ID pattern `[A-Z]{2,4}-\d{3}[a-z]?` and verify every reference still matches a rule in `src/validation/rule-names.ts`. This PRD does not change rule behavior, so prompt updates are not expected — but if the human-facing-description work surfaces any stale prompt references, fix them. If no prompt changes are needed, record that explicitly so the next reviewer knows the prompt was checked.

---

## Success Criteria

- Every rule that surfaces to humans has a human-facing description written per the writing-style guide (what it checks / why it matters / what to do).
- Human-facing descriptions surface correctly in at least two output paths (CLI verbose output and PR summary file, or whichever two were wired in M3 and M6).
- Existing `message` fields are unchanged — agent fix-loop behavior has no regression (verified by acceptance-gate tests).
- A reader of a PR summary can understand each finding without cross-referencing another document.
- `docs/rules-reference.md` mentions the new human-facing mechanism and points to the canonical location for descriptions.
- `npm test` passes; `npm run typecheck` passes; acceptance-gate tests pass.

---

## Risks and Mitigations

- **Risk: Writing 20+ rule descriptions produces inconsistent voice across descriptions.**
  - Mitigation: Writing-style guide in Design Notes enumerates three required elements (what / why / what-to-do) and target length. M4 and M5 write descriptions in batches, giving the author a chance to calibrate voice after the first few and adjust earlier ones.

- **Risk: Output paths have more than two destinations (e.g., eval repo consumes spiny-orb output in formats we haven't enumerated), and the new mechanism misses one.**
  - Mitigation: Before M6 closes, grep for all consumers of `CheckResult.message` and verify they all handle the new mechanism or fall back gracefully.

- **Risk: Modifying `CheckResult` shape (Option 1) breaks consumers that destructure the type.**
  - Mitigation: If Option 1 is chosen in M1, make `humanMessage` optional to avoid breaking existing consumers. Add a deprecation path if any consumer relies on `message` in a human-facing context that should migrate to `humanMessage`.

- **Risk: PRDs #505 and #508 don't merge before M4 starts, causing the advisory rule list to shift mid-implementation.**
  - Mitigation: M4's first step is "Confirm PRD #505 and PRD #508 merge status." If they haven't merged, M4 pauses until they do; M1-M3 can still proceed.

- **Risk: Description registry (Option 3) drifts from rule behavior over time — a rule's detection logic changes but its description doesn't update.**
  - Mitigation: If Option 3 is chosen in M1, include a lint-like check that fails if a rule file is modified without the corresponding registry entry being touched in the same commit (or within N commits). Defer detailed design of this check to M2.

---

## Progress Log

_Updated by `/prd-update-progress` as milestones complete._
