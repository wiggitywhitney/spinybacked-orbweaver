# Spinybacked Orbweaver — Talk Demo Flow

**Format:** 25-minute conference talk
**Demo app:** commit-story-v2 (regular repo, not eval repo)

---

## Pre-Talk Setup

- Run orbweaver against commit-story-v2 to completion before the talk starts
- Disable git hooks on commit-story-v2 (lint, security, test hooks will interfere with live demo)
- Keep a terminal tab open with the full agent logs for walkthrough during the talk
- Be on main in commit-story-v2 at the start of the talk (the instrumented branch and its PR exist but aren't checked out yet)

---

## 1. Opening

"I built an agent that auto-instruments JavaScript with good-practice OpenTelemetry."

## 2. Demo — What Is Commit Story?

Demo commit-story-v2. Show that when you make a commit, it automatically generates an engineering journal entry.

## 3. The Problem

"I want to use the Datadog MCP server and telemetry data to draw me a diagram of how this software works."

Try it. Can't do it — there's no telemetry.

Pause. Let that land.

## 4. Pivot — "So I Built an Agent"

Transition from the problem to the solution. High-level: this is an agent that analyzes JavaScript source files and adds OpenTelemetry instrumentation.

## 5. Prerequisites

Walk through what you need for the agent to work. Build up to the most important ones:

- Node.js project
- OpenTelemetry API dependency
- A Weaver schema and a Weaver registry

## 6. What Is Weaver?

Describe Weaver — the semantic convention tooling.

Click into the Weaver schema. Show what it looks like, what it defines.

## 7. How It Works — The Orchestrator

The orchestrator coordinates the whole run:

- A fresh agent is spun up for each file
- That agent receives the resolved registry (what spans and attributes exist so far)
- The agent instruments the file
- Results are scored against the instrumentation score spec and fed back as feedback
- The agent retries based on that feedback (fix and retry loop)

Open question for audience (or just explain): the agent doesn't know the scoring rules upfront — it discovers them through feedback. (Note: issue #125 addresses adding lightweight scoring rules to the prompt.)

## 8. Fix and Retry Loop

If instrumentation fails at the file level, a new agent is spun up that looks at individual functions within the file.

> **Note to self:** This per-function fallback is future work. Must be implemented before the presentation.

## 9. Schema Evolution Across Files

After each file is instrumented:

- Results are fed back to the coordinator
- The coordinator updates the resolved schema
- The next file's agent receives the updated schema

This means later files benefit from what was learned instrumenting earlier files.

## 10. Checkpoints

Every five files:

- The test suite is run
- The live telemetry check is run

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
- **Logs:** How it dug into certain files to instrument specific functions

Show the PR that the agent created on GitHub:

- **Before/after:** What an instrumented file looks like compared to the original
- **PR body:** All the information provided — validation results, schema extensions, failures

## 13. Final Demo — Closing the Loop

Switch to the instrumented branch in commit-story-v2. Since it runs locally, the instrumented code is now what executes.

Make a commit. This time, the telemetry data flows to Datadog.

Now ask Claude (with the Datadog MCP server) to use telemetry data only to build a diagram of how commit-story works.

This time it works. The loop is closed.

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Agent run doesn't complete cleanly | Run well in advance; have a known-good branch ready |
| Venue network is unreliable | Identify what can be pre-cached or shown offline |
| Datadog MCP diagram is underwhelming | Test end-to-end beforehand; have a known-good screenshot |
| Git hooks interfere with live commits | Disable hooks on commit-story-v2 before the talk |
| 25 minutes isn't enough for all this content | Practice and cut as needed — this doc has everything, cuts come later |

---

## Open Items

- [ ] Implement per-function fallback (section 8) before presentation
- [ ] Decide: eval repo vs regular commit-story-v2 (leaning regular)
- [ ] Test full end-to-end: agent run → PR → switch branch → commit → Datadog → MCP diagram
- [ ] Disable hooks on commit-story-v2
- [ ] Time a practice run to see what needs cutting
