# Spinybacked Orbweaver — Talk Demo Flow

**Format:** 25-minute conference talk
**Demo app:** TBD (commit-story-v2 or another real codebase — see open items)

---

## Narrative Arc

The talk is grounded in a real industry problem: **code-level telemetry instrumentation is valuable for organizations but developers don't want to do it.** This is the argument from [Code-Level Telemetry Instrumentation: From "Oh Hell No" to "Worth It"](https://www.cncf.io/blog/2025/11/07/code-level-telemetry-instrumentation-from-oh-hell-no-to-worth-it/) (CNCF blog, November 2025).

The arc: "Organizations need business logic visibility → auto-instrumentation doesn't cover it → developers resist the manual work → so I built an agent that does it for them, validated against quality rules derived from community standards."

---

## Pre-Talk Setup

- Run orbweaver against the demo app to completion before the talk starts
- Keep a terminal tab open with the full agent logs for walkthrough during the talk
- Have the agent's PR ready on GitHub
- Be on main in the demo app at the start of the talk (the instrumented branch and its PR exist but aren't checked out yet)

---

## 1. Opening — The Problem

"Organizations need observability into their business logic. Auto-instrumentation covers the framework layer — HTTP servers, database clients, messaging — but not the code that makes your product unique."

Reference the CNCF blog as context: "I wrote about this gap last year — the challenge of getting developers to actually instrument their code." One sentence, then move on.

## 2. The Gap

Walk through what auto-instrumentation gives you (framework telemetry, kernel telemetry via eBPF, network telemetry via service mesh) and what it doesn't: insight into the business logic. The unique, differentiating code that makes your product yours.

"Code-level instrumentation is where the real value is — and it's the part developers don't want to do."

## 3. Why Developers Resist

Brief — don't belabor this, the audience already knows:

- It's tedious and manual
- Naming conventions are inconsistent across teams
- It feels like a favor for the platform team, not a feature for developers
- It rots — instrumentation without validation drifts over time

## 4. Pivot — "So I Built an Agent"

Transition from the problem to the solution. High-level: this is an agent that analyzes JavaScript source files and adds OpenTelemetry instrumentation — validated against quality rules derived from community standards.

## 5. Prerequisites

Walk through what you need for the agent to work. Build up to the most important ones:

- Node.js project
- OpenTelemetry API dependency
- A Weaver schema and a Weaver registry

## 6. What Is Weaver?

Describe Weaver — the semantic convention tooling.

Click into the Weaver schema. Show what it looks like, what it defines. This is the foundation that makes the agent's output consistent and queryable.

## 7. How It Works — The Orchestrator

The orchestrator coordinates the whole run:

- A fresh agent is spun up for each file
- That agent receives the resolved registry (what spans and attributes exist so far)
- The agent instruments the file
- Results are validated against 31 quality rules — derived from the community [Instrumentation Score spec](https://github.com/instrumentation-score/spec) and adapted for static code analysis — then fed back as feedback for the agent to iterate on
- The agent retries based on that feedback (fix and retry loop)

The agent receives both the quality rules upfront (as a scoring checklist in the prompt) and discovers specifics through validation feedback during retries.

## 8. Fix and Retry Loop

Three-attempt strategy: initial generation → multi-turn fix with feedback → fresh regeneration with failure hints.

If instrumentation fails at the file level after all attempts, a new agent is spun up that looks at individual functions within the file.

> **Note to self:** Per-function fallback is tracked in PRD #106. Must be implemented before the presentation.

## 9. Schema Evolution Across Files

After each file is instrumented:

- Results are fed back to the coordinator
- The coordinator re-resolves the schema from the registry (picking up extensions written by earlier files)
- The next file's agent receives the updated schema

This means later files benefit from what was learned instrumenting earlier files.

## 10. Checkpoints

Every five files:

- The test suite is run
- The schema is validated for structural integrity and drift

This catches regressions early rather than discovering them at the end.

## 11. What the User Gets

After a full run, the user gets a PR containing:

- All the code changes (instrumented files)
- PR body with details of what was instrumented
- Live check validation results
- Failures and reasons for failures

## 12. Show the Agent's Work

Switch to the terminal tab with the agent logs. Show the audience:

- **Logs:** How it looked at one file at a time, what feedback it gave for different files
- **Logs:** How it retried and fixed validation failures

Show the PR that the agent created on GitHub:

- **Before/after:** What an instrumented file looks like compared to the original
- **PR body:** All the information provided — validation results, schema extensions, failures

The PR diff is the "worth it" moment — validated, schema-compliant instrumentation that a developer didn't have to write.

## 13. Closing

Bring it back to the problem. "Organizations need business logic visibility. Developers don't want to instrument. This agent does it for them — validated against community-derived quality rules, schema-compliant, non-destructive."

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Agent run doesn't complete cleanly | Run well in advance; have a known-good branch ready |
| 25 minutes isn't enough for all this content | Practice and cut as needed — sections 5-6 are most likely to overrun |
| Audience asks about IS scoring specifics | Be precise: "31 code-level rules derived from the Instrumentation Score spec, adapted for static analysis. The IS spec itself evaluates runtime OTLP telemetry — a different concern." |
| Audience asks about failure rate | Have concrete numbers from the pre-talk run. "X of Y files instrumented successfully, Z failed with these reasons." |

### Resolved risks (from audit review 2026-03-14)

These were previously flagged as risks and have been confirmed resolved:

- Schema evolution across files — working correctly since Phase 5 (per-file re-resolution)
- NDS-003 inline finally false positive — fixed in codebase
- NDS-003 cascading false positives — fixed via frequency map approach
- COV-004/RST-004 validation contradiction — fixed via async function exemption

---

## Open Items

- [ ] Implement per-function fallback (section 8) — PRD #106
- [ ] Choose demo app (commit-story-v2 or another real codebase)
- [ ] Test full end-to-end: agent run → PR → review the output
- [ ] Research spike: current industry conversation around code-level instrumentation benefits (validate framing)
- [ ] Pre-seed telemetry data if the closing demo needs live data
- [ ] Time a practice run to see what needs cutting
- [ ] Prepare answers for: which quality rules? how long does a run take? what if the agent fails?
