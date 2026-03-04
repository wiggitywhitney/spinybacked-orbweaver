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
