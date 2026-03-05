# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Project scaffolding: TypeScript with erasableSyntaxOnly, Vitest, ESM module system
- 7-phase PRD structure covering single-file instrumentation through git workflow
- Evaluation rubric with 31 rules across 6 dimensions (4 gates + 27 quality rules: NDS, API, COV, RST, CDQ, SCH)
- Telemetry agent spec v3.9 defining the complete agent architecture
- Design document with cross-phase interfaces and module organization
- Config validation (`src/config/`): Zod schema for `orb.yaml` with all config fields, typo detection via Levenshtein distance, structured error codes
- Prerequisite checks (`src/config/prerequisites.ts`): package.json, OTel API peerDependency, SDK init file, Weaver schema validation with actionable remediation messages
- AST helpers (`src/ast/`): OTel import detection, variable shadowing analysis via compiler node locals, function classification (exported, async, line count)
- System prompt construction (`src/agent/prompt.ts`): spec-aligned 7-section prompt with 5 diverse examples, Claude 4.x prompt hygiene, large file handling
- LLM integration (`src/agent/instrument-file.ts`): Anthropic API with structured output (zodOutputFormat), adaptive thinking, prompt caching, token usage tracking
- Basic elision rejection (`src/agent/elision.ts`): placeholder pattern scan and length-ratio threshold (80%) to catch truncated LLM output
- Already-instrumented detection: skips fully-instrumented files without LLM call, passes partial instrumentation context to the agent
- DX verification: structured results for all outcomes (success, prerequisite failure, elision rejection, API error) with meaningful diagnostic content
- Validation chain (`src/validation/`): two-tier validation architecture with structured `CheckResult` and `ValidationResult` types
- Tier 1 structural checks: elision detection (pattern scan + length ratio), syntax checking (`node --check` on real filesystem), diff-based lint checking (Prettier `check()` with project config resolution), Weaver registry check (CLI integration with graceful skip)
- Tier 1 chain orchestration (`src/validation/chain.ts`): sequential execution with short-circuit on first failure, conditional Weaver check, Tier 2 gating
- Tier 2 semantic checks: CDQ-001 (AST-based span closure verification via ts-morph), NDS-003 (diff-based non-instrumentation line preservation with instrumentation pattern filtering)
- Feedback formatting (`src/validation/feedback.ts`): `formatFeedbackForAgent()` producing `{rule_id} | {pass|fail|advisory} | {path}:{line} | {message}` structured output for LLM consumption
- Prettier 3.8.1 dependency for diff-based lint checking
- Fix loop (`src/fix-loop/`): hybrid 3-attempt strategy — initial generation, multi-turn fix with conversation context, fresh regeneration with failure category hint
- File snapshot/restore (`src/fix-loop/snapshot.ts`): copy to `os.tmpdir()` before processing, restore on failure, clean up on success
- Token budget tracking (`src/fix-loop/token-budget.ts`): cumulative usage across attempts, hard stop when `maxTokensPerFile` exceeded
- Oscillation detection (`src/fix-loop/oscillation.ts`): error-count monotonicity and duplicate error detection trigger early exit or skip to fresh regeneration
- `instrumentWithRetry()` orchestrator: wires `instrumentFile` + `validateFile` with retry, populates complete `FileResult` on all exit paths (success, exhaustion, budget exceeded, oscillation, unexpected error)
- Phase 3 acceptance gate tests: end-to-end validation with real Anthropic API (successful retry, budget exceeded, file revert, strategy verification)
