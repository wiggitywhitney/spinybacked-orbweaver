# Spinybacked Orbweaver

AI-powered telemetry instrumentation agent for JavaScript applications. Analyzes JavaScript source files and adds OpenTelemetry instrumentation (spans, attributes, context propagation) using LLM-guided code generation.

## Tech Stack

- **Language**: TypeScript (agent code) / JavaScript (target files the agent instruments)
- **Runtime**: Node.js >=24.0.0
- **Module System**: ESM (`"type": "module"`)
- **Type Checking**: `erasableSyntaxOnly` — no build step, `tsc --noEmit` as CI gate
- **Test Framework**: Vitest
- **License**: Apache 2.0

## Development Setup

```bash
npm install
npm run typecheck    # Type-check without emitting
npm test             # Run all tests
npm run test:watch   # Watch mode
npm run test:coverage  # With coverage
```

Secrets are managed via vals — two secrets configured: `ANTHROPIC_API_KEY` and `GITHUB_TOKEN`.

```bash
vals exec -f .vals.yaml -- <command>
```

**PATH caveat**: `vals exec -- bash -c '...'` drops Homebrew from PATH. Commands like `npx`, `node`, and `weaver` won't be found. Fix by prepending PATH inside the bash -c:

```bash
vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && npx vitest run ...'
```

## TypeScript: erasableSyntaxOnly

This project uses Node.js 24.x native type stripping. TypeScript annotations are erased at runtime — no transpilation step. Run files directly with `node src/index.ts`.

**Constraints — these will cause runtime errors if violated:**
- No `enum` declarations (use `as const` objects instead)
- No `namespace` declarations
- No `const enum`
- No constructor parameter properties (`constructor(private x: number)`)
- Import types with `import type` (enforced by `verbatimModuleSyntax` in tsconfig.json)

**Benefits:**
- Zero build step for development — `node src/index.ts` works directly
- `tsc --noEmit` catches type errors without producing output files
- Zod schemas get full `z.infer<typeof Schema>` type inference

## Agent Code vs Target Files

The agent writes TypeScript (.ts files in `src/`). The files the agent *instruments* are JavaScript (.js). These are separate concerns:

- **Agent code**: TypeScript with type annotations, lives in `src/`. This is what we build.
- **Target files**: JavaScript files in user codebases that the agent analyzes and modifies. The agent reads them, adds OTel instrumentation, and writes them back as JavaScript.

Never add TypeScript syntax to target file output. Never treat agent module paths as .js.

## Document Layering

The project's design is captured across research documents. Each layer builds on the previous:

1. **Telemetry Agent Spec** (`docs/specs/telemetry-agent-spec-v3.9.md`) — The authoritative specification. Defines what the agent does, its interface contracts, evaluation criteria, and architectural patterns.
2. **Tech Stack Evaluation** (`docs/architecture/tech-stack-evaluation.md`) — Library choices and version decisions for each build phase.
3. **Recommendations** (`docs/architecture/recommendations.md`) — What to preserve from the first-draft implementation and what to change.
4. **Design Document** (`docs/architecture/design-document.md`) — Cross-phase interfaces, module organization, TypeScript type definitions, and the decision register.
5. **Evaluation Rubric** (`research/evaluation-rubric.md`) — Quality criteria for assessing agent output. Used to validate implementation correctness.
6. **Implementation Phasing** (`docs/specs/research/implementation-phasing.md`) — What to build in what order (7 phases with acceptance gates).

When the spec and design document disagree, the spec wins. The design document interprets the spec into concrete types and module boundaries, but the spec is the source of truth.

## Attribution Rules

- The telemetry agent spec is Whitney Lee's original work. Always attribute the spec to her.
- When discussing prior implementations, call them "the first-draft implementation." Do not name authors or include repository URLs.
- This repo is public. Code and documentation should be written accordingly.

## PRD Workflow

Implementation follows a 7-phase build plan. Each phase gets its own PRD generated from the research artifacts.

### Generating a Phase PRD

```text
/prd-phase N
```

Where N is the phase number (1-7). The skill reads the spec, tech stack, recommendations, design document, and rubric to produce a focused, bounded PRD for that phase.

### Working with PRDs

- `/prd-create` — create new PRDs with structured requirements, milestones, and decision logs.
- `/prd-next` — identify the next task from an active PRD.
- `/prd-update-progress` — log completed work with evidence. Clear conversation context afterward before starting the next task.
- `/prd-update-decisions` — capture design decisions and scope changes in the PRD decision log.
- `/prd-done` — finalize a completed PRD (PR, merge, close issue).

Do not invent tasks outside the PRD structure. When a PRD exists, follow it. Do not commit manually during PRD work — `/prd-update-progress` handles commits, PRD updates, and journaling together.

### Rules-related work conventions

These conventions apply to any PRD or GitHub issue that adds, removes, modifies, rebuilds, or otherwise changes the behavior of any validation rule. When uncertain whether a change qualifies, treat it as rules-related — the cost of reading the audit and keeping documentation and the agent prompt in sync is low; the cost of missing a drift case is high.

- **First step of any rules-related work (PRD milestone zero, or the opening of a rule-changing issue): read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full** (or its successor if a future rules audit is published). The audit is the durable record of every rule's decision, rationale, and OTel spec alignment. Context is cleared between milestones and between issue sessions; re-reading the whole audit document prevents decisions from being inadvertently reverted by a fresh session that lacks context. Reading the whole document leaves less room for error than relying on section-by-section recall.
- **Final step: update `docs/rules-reference.md` via `/write-docs`** to reflect any rule additions, deletions, registration changes, promotion-to-blocking changes, or message changes introduced by the work. `docs/rules-reference.md` is the canonical user-facing rule reference. Closing rules-related work without this step introduces documentation drift between the codebase's rule behavior and the published reference.
- **Final step: update `src/agent/prompt.ts`** to match any rule ID or description changes introduced by the work. The prompt instructs the LLM agent using rule IDs (e.g., `- **RST-001**: Do NOT add spans to pure synchronous data transformations...`); orphaned references — a rule ID no longer in `src/validation/rule-names.ts`, or a description that no longer matches the rule's current behavior — will confuse the agent. After making rule changes, grep the prompt for the rule-ID pattern `[A-Z]{2,4}-\d{3}[a-z]?` and verify every match still corresponds to a registered rule with accurate guidance. If a rule was deleted, remove the prompt bullet; if a rule's behavior or scope changed, update the prompt's directive phrasing to match.

## Code Review Triage

When triaging CodeRabbit or `/code-review` findings during a PR, **never defer findings to a GitHub issue**. Fix every non-Skip finding inline in the PR, even if it requires additional files or interface changes. The Defer disposition in the global `git-workflow.md` does not apply to this project — deferred findings rarely ship; inline fixes do.

## Acceptance Gate Tests

**Check the most recent acceptance gate run before every push.** Run `gh run list --workflow=acceptance-gate.yml --limit=1 --repo wiggitywhitney/spinybacked-orbweaver` before pushing. If the most recent run passed, or if no runs exist yet, proceed. If one is in progress, proceed. If the most recent run failed — on any branch — stop, investigate, and fix the failures before pushing.

**Acceptance gate tests must actually run.** A suite that exits with zero test files is not a pass — it is a broken runner. If the acceptance gate hook reports "no test files found" or runs zero tests, stop and fix the execution environment (glob patterns, PATH, working directory) before proceeding. Silent non-execution is how acceptance gates go unenforced for entire PRD cycles.

**Never dismiss acceptance gate test failures.** When the acceptance gate suite reports failures — whether during a hook, a manual run, or a `/prd-next` loop — treat every failure as a real signal that must be investigated. Do not rationalize failures as "unrelated to the current task" or "pre-existing." If the tests fail, something is wrong, and the current work cannot proceed until the failures are understood and resolved (or triaged into a dedicated PRD).

## npm Release Workflow

When creating a new GitHub release (`v1.x.x`):

1. The `publish.yml` workflow fires automatically and publishes to npm via OIDC trusted publishing.
2. The `npm-release-test.yml` workflow fires automatically and tests the **installed artifact** — it installs `spiny-orb@latest` from the npm registry (not from source) and runs `spiny-orb instrument` against a fixture, asserting `status=success` and `spansAdded>0`.

If `npm-release-test.yml` fails after a release, the package was published but the artifact is broken. Investigate and publish a patch release.

To trigger `npm-release-test.yml` manually before a release (e.g., to validate packaging changes), create a PR with the `run-acceptance` label.

## Communicating About Validation Rules

When discussing validation rules with Whitney, always state what the rule checks for in plain English alongside its ID. Never refer to a rule by its code name alone — "COV-001" means nothing in conversation without the description.

**Do**: "COV-001 (entry points have spans) fires here because..."
**Don't**: "COV-001 fires here because..."

Do NOT use a rule ID without its description in any context: audit findings, failure explanations, design decisions, PRD milestones, or inline code comments.

## Testing: Weaver CLI

**Never mock the Weaver CLI.** Weaver is installed locally and runs fast (<1s per command except live-check). All tests that exercise Weaver behavior must run against the real binary. Mocking Weaver has hidden real bugs (wrong output format assumptions, deprecated commands, missing flags). Use real registry fixtures instead of fabricating Weaver output.
