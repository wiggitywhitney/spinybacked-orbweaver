---
name: process-eval-results
description: Process evaluation rubric results into prioritized GitHub issues. Use when receiving eval run findings that need to become actionable work items. Trigger phrases - "eval results", "rubric results", "process findings", "eval run".
category: project-management
---

# Process Eval Results

Turn evaluation rubric findings into prioritized, grouped GitHub issues ready for issue juggling.

## Prerequisites

- Eval findings available (pasted into conversation, file path, or external reference)
- On `main` branch with clean working tree
- `gh` CLI authenticated

## Constraints

- Do NOT create issues for `pass` findings — they are informational only.
- Do NOT create duplicate issues. Always check existing open issues before creating new ones.
- Do NOT modify existing issues without explicit user approval.
- Do NOT dump raw eval data into issue bodies. Keep issue text concise — reference the eval document for full details.
- Do NOT skip user checkpoints. Each step that says "present to the user" requires user confirmation before proceeding to the next step.

## Step 1: Receive & Parse Findings

Ask the user for the eval findings if not already provided. Accept any of:
- Pasted text in the rubric output format: `{rule_id} | {pass|fail} | {file_path}:{line_number} | {message}`
- A file path containing findings
- A reference to an external document (e.g., `commit-story-v2-eval: evaluation/run-N/...`)
- Prose or other structured formats (JSON, markdown tables) — extract rule_id, pass/fail status, file references, and actionable messages from whatever format is provided

If the input format is unclear or cannot be reliably parsed, ask the user to clarify which findings map to which rule IDs before proceeding.

Extract from the findings:
- **Run number**: Ask the user or derive from document metadata (e.g., "run-5", "run-6"). Once known, create the `evaluation/run-N` label if it doesn't already exist: `gh label create "evaluation/run-N" --description "Findings from evaluation run-N" --color "d4c5f9"` (ignore error if label exists).
- **Per-finding data**: rule_id, pass/fail, file_path:line_number, actionable message
- **Filter**: Keep only `fail` entries — `pass` entries are informational only

Present a summary to the user:
```text
Eval run: run-N
Total findings: X fail / Y pass
Dimensions hit: [list affected dimensions, e.g., COV, RST, CDQ]
Files affected: [list unique file paths]
```

## Step 2: Validate Against Current Main

For each failing finding, check whether the referenced file and code still exist on current `main`:
- **File exists, code site still relevant** — keep the finding
- **File deleted or code site no longer exists** — drop the finding, note why
- **Ambiguous** (file exists but code changed significantly) — flag for user review

Present dropped and ambiguous findings to the user before proceeding.

## Step 3: Check for Existing Issues & Combine

Search for existing issues that may overlap with each finding:
- `gh search issues "rule_id" --repo OWNER/REPO --state open` for each rule_id
- `gh search issues "file_path" --repo OWNER/REPO --state open` for each affected file
- `gh issue list --label "evaluation/run-*" --state open` for prior eval findings on the same rules

If overlap is found:
- **Propose combining** — preserve all information from both the existing issue and the new finding
- Show the user what would be added to the existing issue
- Wait for user approval before updating any existing issues

If no overlap, the finding proceeds to a new issue.

## Step 4: Scope & Classify

For each remaining finding, classify:

**Severity:**
- **blocker** — Gate check failure (NDS-001, NDS-002, NDS-003, API-001, NDS-006) or Critical impact rule failure that breaks demo functionality
- **quality** — Important/Normal impact rule failure that degrades instrumentation quality
- **cosmetic** — Low impact rule failure or style-level concern

**Effort:**
- **small** — Single-file fix, clear what to change (e.g., fix a span name, add a missing attribute)
- **medium** — Multi-file change or prompt adjustment needed
- **large** — Design decision required, architectural change, or prompt rewrite

**Category:**
- **agent-code** — Fix in `src/` TypeScript files
- **prompts** — Fix in agent prompt templates
- **config** — Fix in configuration or schema
- **tests** — Fix in test infrastructure

Present the full classification table to the user for adjustment before proceeding.

## Step 5: Group by File Affinity

Cluster findings that touch the same source files. The goal is to create issue groups that can be worked as a single branch without merge conflicts with other groups.

Grouping rules:
- Findings on the same file go in the same group
- Findings on files that import each other go in the same group (they'll likely change together)
- Prompt-related findings group together regardless of which target file they affect
- Keep groups small enough to be a single PR (aim for 1-3 files per group)

Present proposed groups to the user. Each group becomes one GitHub issue (or stays as a single-finding issue if it doesn't cluster).

## Step 6: Prioritize

Order the issues by:
1. **Blockers first** (gate failures, demo-breaking issues)
2. **Quality issues by impact** (Critical > Important > Normal > Low)
3. **Within same severity, smaller effort first** (quick wins before heavy lifts)

Present the prioritized list to the user for reordering. This becomes the juggling order.

## Step 7: Create GitHub Issues

**Parallelize with agents.** Launch one Agent per issue (or issue group) to create the GitHub issues concurrently. Each agent receives:
- The issue title, body, and labels
- The repo owner/name for `gh issue create`

Each agent creates a single issue using `gh issue create` with the established format:

```markdown
## Problem

[What's wrong — specific rule failures with file paths and line numbers]

## Eval Evidence

[Reference to eval run document and specific findings]
Example: `commit-story-v2-eval: evaluation/run-N/orb-findings.md → Finding #X`

## Affected Files

[List of files in this group — helps with branch scoping]

## Acceptance Criteria

- [ ] [Specific, testable requirement per finding in the group]
- [ ] [Rule ID passes on re-evaluation]
```

**Labels to apply:**
- `evaluation/run-N` (from step 1)
- If blocker severity: `high priority`

Wait for all agents to complete, then collect the created issue numbers.

After all issues are created, add a juggling order comment to each issue:

```text
**Eval run-N juggling order: X of Y**
Depends on: #NNN, #NNN (or "—" if none)
Blocks: #NNN, #NNN (or "—" if none)
```

This persists the priority ordering and dependency chain in the issues themselves, so future sessions can discover the juggling sequence via `gh issue view` without a separate tracking document.

## Step 8: Summary

Present a final summary table:

```text
| # | Issue | Title | Files | Severity | Effort |
|---|-------|-------|-------|----------|--------|
| 1 | #NNN  | ...   | ...   | blocker  | small  |
| 2 | #NNN  | ...   | ...   | quality  | medium |
```

Then:
- **Suggested juggling order**: List issue numbers in the order they should be worked
- **Dropped findings**: List any findings that were dropped in step 2, with reasons
- **Combined findings**: List any findings that were merged into existing issues in step 3
- **Total**: X new issues created, Y combined into existing, Z dropped

End by asking the user if they want to start juggling immediately.
