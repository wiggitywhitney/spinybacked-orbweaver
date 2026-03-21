# Spinybacked Orbweaver — Talk Demo Flow

**Format:** 25-minute conference talk
**Demo app:** commit-story-v2 (real codebase, npm-linked globally, runs on every git commit)

---

## Narrative Arc

The talk is grounded in a real industry problem: **code-level telemetry instrumentation is valuable for organizations but developers don't want to do it.** This is the argument from [Code-Level Telemetry Instrumentation: From "Oh Hell No" to "Worth It"](https://www.cncf.io/blog/2025/11/07/code-level-telemetry-instrumentation-from-oh-hell-no-to-worth-it/) (CNCF blog, November 2025).

The arc: "Organizations need business logic visibility → auto-instrumentation doesn't cover it → developers resist the manual work → so I built an agent that does it for them, validated against quality rules derived from community standards → and it tells you which auto-instrumentation packages complete the picture."

---

## Pre-Talk Setup

- Run spiny-orb against commit-story-v2 to completion before the talk starts
- Keep a terminal tab open with the full agent logs for walkthrough
- Have the agent's PR ready on GitHub
- Start the Datadog Agent container (`scripts/setup-dd-agent.sh`) so OTLP ingestion is live
- Switch commit-story-v2 to the instrument branch so the npm-linked CLI runs instrumented code
- Verify traces flow: make a test commit, confirm spans appear in Datadog APM
- Be ready to show: terminal logs, GitHub PR, Datadog APM, and a code diff

---

## 1. Opening — The Problem

"Organizations need observability into their business logic. Auto-instrumentation covers the framework layer — HTTP servers, database clients, messaging — but not the code that makes your product unique."

Reference the CNCF blog as context: "I wrote about this gap last year — the challenge of getting developers to actually instrument their code." One sentence, then move on.

## 2. The Instrumentation Landscape

Build up the layers so the audience understands what exists and what's missing:

**Layer 1 — Auto-instrumentation:** You install a package, it patches library internals. Covers HTTP, databases, LLM clients, messaging. Example: `@traceloop/instrumentation-langchain` gives you LLM call spans for free — every `model.invoke()` becomes a span with token counts and latency. You write zero code.

**Layer 2 — The gap:** Auto-instrumentation knows "an LLM call happened" but not "we were generating a daily summary for March 15th." It sees the plumbing but not the business logic. That context requires manual instrumentation — and that's the part developers don't want to do.

**Layer 3 — The full picture:** Manual and auto coexist. Manual spans wrap your business orchestration; auto-instrumentation fills in the framework details underneath. Show the span hierarchy concept:

```text
generateDailySummary          ← manual (your business logic)
  └─ graph.invoke()           ← auto (LangGraph orchestration)
       └─ model.invoke()      ← auto (ChatAnthropic LLM call)
```

"The agent I built adds layer 2. The deployer adds layer 1. Together you get the complete picture."

## 3. Why Developers Resist

Brief — the audience already knows:

- It's tedious and manual
- Naming conventions are inconsistent across teams
- It feels like a favor for the platform team, not a feature for developers
- It rots — instrumentation without validation drifts over time

## 4. Pivot — "So I Built an Agent"

Transition from the problem to the solution. High-level: this is an agent that analyzes JavaScript source files and adds OpenTelemetry instrumentation — validated against quality rules derived from community standards.

"It adds the manual layer — the business logic spans — and tells you which auto-instrumentation packages to install for the framework layer."

## 5. The Foundation — Weaver Schema

Walk through what you need for the agent to work:

- Node.js project with OpenTelemetry API dependency
- A Weaver schema that defines your telemetry conventions

Click into the Weaver schema. Show what it looks like, what it defines. "This is how you tell the agent what your telemetry should look like — attribute names, types, namespaces. The agent extends this schema as it discovers new things to instrument."

## 6. How It Works — The Orchestrator

The orchestrator coordinates the whole run:

- A fresh agent is spun up for each file
- That agent receives the resolved registry (what spans and attributes exist so far)
- The agent instruments the file
- Results are validated against 32 quality rules — derived from the community [Instrumentation Score spec](https://github.com/instrumentation-score/spec) and adapted for static code analysis
- The agent retries based on validation feedback (fix and retry loop)
- After each file, the schema is re-resolved — later files benefit from what earlier files discovered

## 7. Fix and Retry Loop

Three-attempt strategy: initial generation → multi-turn fix with feedback → fresh regeneration with failure hints.

"The quality rules aren't just a post-hoc check — they're the agent's inner loop. The agent gets the rules upfront, and validation feedback during retries helps it correct violations in context."

## 8. Show the Agent's Work

Switch to the terminal tab with the agent logs. Show the audience:

- **The run in progress:** How it processed files one at a time
- **A successful file:** What the agent decided to instrument and why (the companion `.instrumentation.md` file)
- **A skip decision:** A file the agent correctly left alone (sync utility, no I/O)
- **The validation feedback:** How a retry corrected a rule violation

## 9. The PR

Show the PR that the agent created on GitHub:

- **Before/after diff:** What an instrumented file looks like compared to the original
- **Companion reasoning:** The `.instrumentation.md` file explaining why it instrumented what it did
- **Per-file table:** Status, span counts, schema extensions, cost per file
- **Recommended Companion Packages:** "This project was detected as a library. The following auto-instrumentation packages were identified but not added as dependencies — they are SDK-level concerns that deployers should add."

This is where auto-instrumentation comes back into the story. The agent says "I added the manual spans; here are the auto-instrumentation packages you should install to complete the picture."

The PR diff is the "worth it" moment — validated, schema-compliant instrumentation that a developer didn't have to write.

## 10. Live Telemetry

"Let me show you this actually works."

- Explain: commit-story-v2 is real software that runs on every git commit. It's on the instrumented branch right now.
- Make a real commit in a repo (or show one you made during setup)
- Switch to Datadog APM
- Show the trace: the root span (`commit_story.cli.run`), the business logic spans underneath (`gather_for_commit`, `generate_sections`), and the auto-instrumented LLM calls as child spans
- "The manual spans the agent wrote give you the business context. The auto-instrumentation packages give you the framework details. Together — the complete picture."

## 11. Closing

Bring it back to the problem. "Organizations need business logic visibility. Developers don't want to instrument. This agent does it for them — validated against community-derived quality rules, schema-compliant, non-destructive. And it tells you which auto-instrumentation packages to install for the rest."

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Agent run doesn't complete cleanly | Run well in advance; have a known-good branch ready |
| Live telemetry doesn't show in Datadog | Pre-verify during setup. Have screenshots as backup. |
| 25 minutes isn't enough | Sections 5-6 are most cuttable. The live demo can be 60 seconds. |
| Audience asks about IS scoring specifics | "32 code-level rules derived from the Instrumentation Score spec, adapted for static analysis. The IS spec itself evaluates runtime OTLP telemetry — a different concern." |
| Audience asks about failure rate | Have concrete numbers from the pre-talk run. "X of Y files instrumented successfully, Z failed with these reasons." |
| Audience asks "why not just use auto-instrumentation for everything?" | "Auto covers framework calls. It can't see your business logic — what operation you're performing, for which customer, with what parameters. That's the gap." |

### Resolved risks (from audit review 2026-03-14)

These were previously flagged as risks and have been confirmed resolved:

- Schema evolution across files — working correctly since Phase 5 (PRD #31, `dispatch.ts:248-250`)
- NDS-003 inline finally false positive — fixed (PR #90, `nds003.ts` INSTRUMENTATION_PATTERNS)
- NDS-003 cascading false positives — fixed via frequency map approach (PR #90)
- COV-004/RST-004 validation contradiction — fixed via async function exemption (PR #91)

---

## Open Items

- [ ] Complete PRD #51 on commit-story-v2 (OTel SDK setup, Datadog exporter, auto-instrumentation packages)
- [ ] Run spiny-orb against commit-story-v2 proper (first real run, not eval)
- [ ] Verify live telemetry: commit → traces in Datadog with manual + auto span hierarchy
- [ ] Test full end-to-end: agent run → PR → review the output → live traces
- [ ] Time a practice run to see what needs cutting
- [ ] Prepare answers for: which quality rules? how long does a run take? what if the agent fails?
