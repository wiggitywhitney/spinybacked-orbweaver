# PRD #1059: Adopt dot-agent-deck orchestration

**Status**: Not started
**Priority**: Medium
**GitHub Issue**: [#1059](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1059)
**Created**: 2026-09-15

---

## Problem Statement

All PRD work in this repo runs through a single Claude Code session doing implementation, testing, review, and audit sequentially. There is no structural separation between the agent that writes code and the agents that check it — the same session that implements a milestone also grades its own work.

## Solution Overview

Adopt Viktor Farcic's `dot-agent-deck` (a Rust terminal dashboard + daemon that runs multiple agent CLI sessions as panes) to split PRD work across dedicated roles: orchestrator, coder, tester, reviewer, auditor, release, and documenter. Each role runs as its own Claude Code session in its own pane, coordinated through a per-repo `.dot-agent-deck.toml` config and `devbox` scripts.

### Context: what's already decided, and where

`dot-agent-deck` itself is a single global daemon/TUI, installed once (`brew tap vfarcic/tap && brew install dot-agent-deck`) and shared across every repo that uses it. Only `.dot-agent-deck.toml` and `devbox.json` are per-repo — this PRD does not need to re-decide whether the tool itself is worth adopting; that question was already answered in `content-manager`'s PRD #126, whose Milestone 0 design-decisions session is complete. This PRD reuses those resolved decisions where they aren't repo-specific, and opens a matching Milestone 0 here only for what genuinely differs per repo.

**Carried over from `content-manager` PRD #126 (not re-decided here):**
- Role set: seven roles matching Viktor's own `dot-ai` usage — orchestrator, coder, tester, reviewer, auditor, release, documenter.
- Vendor: same-vendor Claude throughout every role. No mixed-vendor split — `dot-agent-deck`'s own dogfood config demonstrates a mixed preset, but Viktor's real production repo (`dot-ai`) doesn't use it, and content-manager weighed the same-vendor tradeoff (weaker structural independence between roles vs. no new CLI to maintain) and chose same-vendor.
- Config authored via the tool's own generator (`dot-agent-deck init` to scaffold, then `Ctrl+d` then `g` in the dashboard to have an agent analyze the project and propose the real config) — not hand-copied from another repo's `.toml`.
- Every role whose command is a devbox launcher (e.g. `devbox run agent-coder`) needs an explicit `agent = "claude"` key in its config block, or the dashboard loses status tracking for that pane.
- Devbox script naming: one `agent-<role>` script per role (e.g. `agent-coder`, `agent-tester`).
- TOML placement gotcha: if `worker_response_timeout_minutes` is customized, it must appear above every `[[modes]]`/`[[orchestrations]]` table header in the file — placed below one, it's silently absorbed into that table with no validation error.
- Notification security requirements: an explicit fixed destination id (never "most recently active"), the agent must never read the channel's inbound/updates side, and any MCP server used for notifications must be pinned to a specific version. Additionally — per a finding from `content-manager`'s CodeRabbit review of PRD #126 — no webhook URL or secret may live in the orchestrator's own prompt or config, because the orchestrator's job is reading PRD files and any secret it can see is a prompt-injection target. Route notifications through a small, fixed notifier script that the orchestrator can only trigger by name; it must never see the secret's value.

**Genuinely repo-specific — decided in this PRD's own Milestone 0:**
- Notification channel and destination for this repo. `content-manager` chose a Slack incoming webhook; this repo may want the same channel, a different one, or none yet.
- The orchestrator's test-plan format, informed by this repo's real test tiers (unit / integration / acceptance-gate, per `.claude/verify.json`) rather than assumed from another repo's setup.
- Whether `dot-agent-deck` needs to be installed as part of Milestone 0 in this environment (assumed not yet installed here — confirm during the session rather than assuming).

## User Experience

Whitney runs PRD work through the `dot-agent-deck` dashboard instead of a single Claude Code session. She approves a test plan before the orchestrator delegates work to the coder/tester/reviewer/auditor/release/documenter roles, then everything runs unattended until either a role needs her input or the work is ready for her merge decision. She is notified only at moments she might have walked away — not for every pane update.

## Technical Architecture

- `.dot-agent-deck.toml` in this repo's root, generated via the tool's own config generator and hand-verified against the gotchas listed above (agent key required per devbox-launched role; timeout placement above table headers).
- `devbox.json` with one `agent-<role>` script per role (`agent-orchestrator`, `agent-coder`, `agent-tester`, `agent-reviewer`, `agent-auditor`, `agent-release`, `agent-documenter`), each launching a Claude Code session scoped to that role's responsibilities.
- A small, fixed notifier script (language/shape decided in Milestone 0) that the orchestrator can invoke by name only — it holds the notification destination and any secret; the orchestrator never sees or configures the value directly.
- Role prompts written fresh for this repo, following the generic role responsibilities documented in `dot-agent-deck`'s own `docs/orchestration.md` (reviewer, auditor, release, documenter) plus this repo's specific conventions for the coder and tester roles (test tiers, `.claude/verify.json` commands, `spiny-orb` CLI structure). **Note**: as of this PRD's creation, `content-manager`'s PRD #126 has only completed its design-decisions milestone — no `.dot-agent-deck.toml`, `devbox.json`, or role prompt files exist there yet to copy from. If those artifacts exist by the time Milestone 3 runs, read them for reference, but do not assume they exist or block on them.

## Success Criteria

- `.dot-agent-deck.toml` and `devbox.json` exist, validated with `dot-agent-deck validate` (or equivalent), and every devbox-launched role shows live status tracking in the dashboard (not just "unknown").
- PRD #778 (SDK bootstrap scaffold generation) is implemented, tested, reviewed, audited, and merged entirely through the orchestrated roles, with visible evidence that the release and documenter roles specifically did their jobs — not just implementation/testing/review/audit.
- Notifications fire only at the two designated human-in-the-loop moments (test-plan approval, merge confirmation) plus genuine blockers — not on every pane state change.
- No secret or webhook value is ever visible in the orchestrator's own prompt, config, or logs.

## Risks & Mitigation

| Risk | Mitigation |
|---|---|
| PRD #778's implementation path turns out to have real-world side effects (e.g. an unexpected network call or write outside the repo), discovered only after roles start acting on it unattended | Milestone 1 explicitly confirms PRD #778 is pure code generation and file writes before any role is given write access to run it — do not assume safety from the PRD text alone, since `content-manager`'s PRD #125 looked safe on paper but had two unguarded live-write code paths that only surfaced under review |
| Orchestrator's PRD-reading role becomes a prompt-injection vector if a secret is reachable from its context | Notifications routed through a fixed, name-only-triggerable notifier script per the carried-over security requirement; orchestrator prompt is reviewed in Milestone 0 to confirm no secret material is embedded |
| Role prompts copied wholesale from `content-manager` reference the wrong test commands or file layout for this repo | Milestone 0 explicitly adapts test-plan format and any repo-specific role prompt content before any role runs live work |
| First live orchestration run against PRD #778 goes wrong mid-flight (bad generated code, wrong package names, broken devbox config) | PRD #778 is Priority Low and fully self-contained with no downstream blockers — a broken branch can be discarded with no other PRD affected |

## Dependencies

- `dot-agent-deck` installed globally on Whitney's machine (may already be true from `content-manager`'s adoption — confirmed in Milestone 0).
- PRD #778 (SDK bootstrap scaffold generation) as the first live workload — already unblocked and self-contained, no PRD dependency created by this adoption.

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- Unlike `content-manager`'s original plan for PRD #125, this PRD does not assume a candidate workload is safe to run live without checking — Milestone 1 verifies PRD #778 has no unguarded real-world side effects before any role is allowed to act on it unattended.

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-09-15 | Reuse `content-manager` PRD #126's role set, vendor choice, config-generator approach, and notification security requirements rather than re-deciding them here | Those decisions aren't repo-specific — `dot-agent-deck` is a single global tool, and re-litigating settled tradeoffs (same-vendor vs. mixed-vendor, generator vs. hand-authored config) per repo would be redundant work with no new information to justify a different answer |
| 2026-09-15 | First live workload is PRD #778 (SDK bootstrap scaffold generation), not PRD #373 (Python provider) | #373 is blocked by PRD #507, carries 9 open design decisions, and blocks PRD #374 downstream — too much decision density and blast radius for validating brand-new orchestration tooling. #778 is unblocked, Priority Low, fully self-contained, and has a concrete mechanical spec already written |

## Milestones

- [ ] **Milestone 0 — Design decisions session**: A single human-in-the-loop session with Whitney to finalize every repo-specific decision before any config is written. Covers: (a) confirm whether `dot-agent-deck` is already installed in this environment, and install it if not; (b) run the tool's own config generator (`dot-agent-deck init`, then `Ctrl+d` then `g` in the dashboard) against this repo rather than hand-copying `content-manager`'s `.dot-agent-deck.toml`; (c) decide this repo's notification channel and destination (Slack incoming webhook, matching `content-manager`, or something else); (d) decide the orchestrator's test-plan format, informed by this repo's real test tiers — unit, integration, and acceptance-gate, per `.claude/verify.json`'s `acceptance_test` and `acceptance_test_ci` commands — rather than assuming `content-manager`'s test setup applies; (e) review the generated config against the carried-over gotchas (agent key on every devbox-launched role; timeout placement above table headers) and fix any violation before moving on. Record every decision in this PRD's Decision Log before ending the session.

- [ ] **Milestone 1 — Verify PRD #778 has no unguarded real-world side effects**: Before any role is given write access to act on PRD #778 unattended, read PRD #778's full milestone detail (`prds/778-sdk-bootstrap-scaffold.md`) and trace what its implementation actually touches: file writes (generated bootstrap file, `spiny-orb.yaml` update), `npm install` execution, and any interactive prompts. Confirm there is no network call, external API write, or destructive operation anywhere in its milestone set — the PRD as written appears to be pure code generation and local file writes, but this must be confirmed by reading the milestone text, not assumed by category ("it's a code-gen PRD, code-gen is safe"). Document the confirmation (or any side effect found, and how it will be guarded) directly in this milestone's checkbox notes before Milestone 3 begins.

- [ ] **Milestone 2 — `.dot-agent-deck.toml` and `devbox.json` created and validated**: Using Milestone 0's design decisions, write the final `.dot-agent-deck.toml` (seven roles, same-vendor Claude, `agent = "claude"` key on every devbox-launched role, any custom `worker_response_timeout_minutes` placed above all `[[modes]]`/`[[orchestrations]]` headers) and `devbox.json` (one `agent-<role>` script per role). Validate with `dot-agent-deck validate` (or the tool's equivalent check command — confirm the exact command name during this milestone, since it may differ from what `content-manager` used). Confirm every devbox-launched role shows live status tracking in the dashboard, not "unknown."

- [ ] **Milestone 3 — Notifier script and role prompts**: Implement the fixed, name-only-triggerable notifier script decided in Milestone 0 — it holds the notification destination and any secret; the orchestrator's own prompt and config must never contain either. Write role prompts for all seven roles: base the generic ones (reviewer, auditor, release, documenter) on the role responsibilities documented in `dot-agent-deck`'s `docs/orchestration.md`, and write the coder and tester prompts to reference this repo's actual conventions — test tiers and `.claude/verify.json` commands identified in Milestone 0d, and the `spiny-orb` CLI's existing code structure. If `content-manager` has since produced its own `.dot-agent-deck.toml` or role prompt files, read them for reference, but do not block on or assume their existence. Confirm by inspection that no role prompt or config file contains a secret value.

- [ ] **Milestone 4 — Live validation on PRD #778**: With Milestone 1's safety confirmation in hand, run PRD #778 end-to-end through the orchestrated roles — orchestrator delegates, coder implements, tester writes and runs tests, reviewer and auditor check the work, release and documenter finish the loop. Whitney approves the test plan before delegation and confirms the merge at the end; everything in between runs unattended except for genuine blockers. If the run reveals a broken config or role-prompt gap, fix it and re-run rather than merging broken work — PRD #778's branch can be freely discarded since it has no downstream dependents.

- [ ] **Milestone 5 — Merge PRD #778 and document the setup**: Once Milestone 4's run is clean, merge PRD #778 through the normal PR/CodeRabbit process. Write `docs/dot-agent-deck.md` describing the final role set, config location, how to invoke a run, and the notification setup — enough for a future session (human or AI) to pick up orchestrated PRD work here without re-deriving Milestones 0–3. Update `PROGRESS.md` with a changelog entry.

## Implementation Plan

Milestones run in order — each depends on the prior one's output (Milestone 0's decisions feed Milestone 2's config; Milestone 1's safety confirmation gates Milestone 4's live run). No milestone should start work that a later milestone's design decision could invalidate.

## Open Questions

- Does this repo want the same Slack channel `content-manager` uses for notifications, or a dedicated one? (Milestone 0)
- Does `dot-agent-deck`'s validate/check command differ from what `content-manager` used, given any tool updates since PRD #126's Milestone 0? (Milestone 2)

## Progress Log

*(Updated by `/prd-update-progress` as work proceeds.)*
