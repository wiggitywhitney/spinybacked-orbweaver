# PRD #362: Installed-artifact CI test for published npm releases

**Status**: Not Started  
**Priority**: Medium  
**GitHub Issue**: [#362](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/362)

---

## Problem

The existing test suite validates source code behavior but cannot detect packaging errors. A wrong `files` field in `package.json`, a missing runtime dependency, or a broken bin symlink would pass all unit tests and yet make the published package unusable. The only way to catch these failures is to install the package from the registry and run it against real input.

---

## Solution

A GitHub Actions workflow (`npm-release-test.yml`) that installs `spiny-orb` directly from the npm registry and runs `spiny-orb instrument` against a real JavaScript fixture file, asserting a successful result. The workflow triggers automatically on every GitHub release publication and can be triggered manually on PRs via the `run-acceptance` label.

---

## Big Picture Context

The existing `verify-action.yml` workflow is the closest analog — it runs the CLI against a fixture but launches the binary from source (not from the registry). The key distinction here is **installing from npm**, which exercises the `files` field, the `bin` entry, the `exports` field, and the runtime dependency closure.

The right fixture is `test/fixtures/project/src/order-service.js` — it is already used by `verify-action.yml` for the same purpose (testing the CLI against real input), has async functions that reliably produce spans, and completes in under 30 seconds. Do not use the commit-story-v2 fixtures for this workflow: those were chosen specifically because they are known-hard regression cases that fail in specific runs.

---

## Design Decisions

- **Install from registry, not from source.** The workflow must run `npm install -g spiny-orb@latest` (or `npx spiny-orb@latest`) — NOT `node bin/spiny-orb.js`. The whole point is to test what was published.

- **Separate workflow file, not acceptance-gate.yml.** This workflow has a different trigger (release events) and a different purpose (artifact validation vs. code quality). Keeping it separate avoids entangling release gating with PR acceptance gating.

- **Single fixture file, not the full eval suite.** One well-chosen fixture is enough to validate the installed artifact. Use `test/fixtures/project/src/order-service.js` — already proven by `verify-action.yml`, completes in under 30 seconds.

- **Assert status=success and spansAdded>0.** The installed-artifact test does not need to validate every quality rule — that's what the acceptance gate handles. The bar here is: did the CLI run, did it instrument something, did it exit 0?

- **Requires `ANTHROPIC_API_KEY`.** The workflow makes real LLM calls. The secret must be available in the repo's Actions secrets (it already is, per the existing `acceptance-gate.yml` setup).

- **Trigger on release + `run-acceptance` label.** Automatic on every GitHub release. Also triggerable on PRs via `run-acceptance` label so packaging changes can be tested before publishing.

---

## Milestones

### Milestone 1: Select and document the test fixture

**Before starting**: Read `test/fixtures/commit-story-v2/` and understand which file is best suited for this test. The goal is a file that:
- Is representative of real-world JS (not trivial, not pathological)
- Has a known-good instrumentation outcome (look at the ABOUTME header in each fixture for the run-4/run-5 outcome history)
- Will complete within ~3 minutes on a GitHub Actions runner

- [ ] Use `test/fixtures/project/src/order-service.js` as the test input — the same fixture already used by `verify-action.yml`. It has async functions that reliably produce spans and completes in under 30 seconds.
- [ ] Read `verify-action.yml`'s "Create test project" step in full. Copy its `package.json`, SDK init file, and `spiny-orb.yaml` contents exactly — this is a proven working setup for this exact fixture.
- [ ] Document the expected outcome in this PRD: `status === "success"` and `spansAdded > 0`.

### Milestone 2: Write the GitHub Actions workflow

**Before starting**: Read `verify-action.yml` in full — it is the closest structural analog. The new workflow follows the same pattern but swaps the "run from source" step for "install from npm."

- [ ] Before writing the workflow: read `.github/workflows/acceptance-gate.yml` and `.github/workflows/verify-action.yml` in full — copy the PR label trigger block from `acceptance-gate.yml` exactly (`contains(github.event.pull_request.labels.*.name, 'run-acceptance')` syntax), and use `verify-action.yml` as the structural model.
- [ ] Create `.github/workflows/npm-release-test.yml` with the following structure:
  - Triggers: `release: [published]` and `pull_request: [labeled, synchronize]` (gated on `run-acceptance` label — use the exact label-checking syntax from `acceptance-gate.yml`)
  - Runs on `ubuntu-latest`, timeout 20 minutes
  - Steps: checkout → setup-node (Node 24) → `npm ci` (for weaver PATH setup) → install Weaver CLI (same method as `verify-action.yml`) → create test project directory using the same `package.json`, SDK init file, and `spiny-orb.yaml` as `verify-action.yml`'s "Create test project" step (copy those exact file contents) → **`npx spiny-orb@latest instrument --yes --output json src/order-service.js`** → parse and assert result
- [ ] The assertion step must verify: exit code 0, `fileResults[0].status === "success"`, `fileResults[0].spansAdded > 0`. Fail with a clear error message if any condition is not met.
- [ ] Wire up `ANTHROPIC_API_KEY` from secrets (same pattern as `verify-action.yml`).
- [ ] Add a `permissions: id-token: read, contents: read` block (standard for release-triggered workflows).

### Milestone 3: Test the workflow end-to-end

**Before starting**: Confirm the workflow file syntax is valid (`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/npm-release-test.yml'))"`) and that the `spiny-orb@latest` on npm is the version you expect.

- [ ] Push the workflow to the feature branch and create a PR with the `run-acceptance` label to trigger the PR path.
- [ ] Verify the workflow runs to completion: the install step fetches from the registry (not from source), the instrumentation step runs with a real API call, and the assertion step passes.
- [ ] Note: `gh workflow list` only shows workflows on the default branch — the workflow will appear there after the PR merges, not during PR testing. During PR testing, validate YAML syntax with `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/npm-release-test.yml'))"` instead.
- [ ] Add a note to `PROGRESS.md` documenting that release-triggered npm artifact validation is in place.

---

## Success Criteria

- Every GitHub release automatically runs an end-to-end test of the installed npm package
- The test installs `spiny-orb@latest` from the registry (not from source)
- A packaging regression (wrong `files`, missing dep, broken bin) causes the workflow to fail and block the release from being considered good
- The workflow completes in under 10 minutes

---

## Design Notes

- The PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- Keep the test project setup minimal — the fixture already has complexity; the scaffolding (package.json, SDK init) should be as simple as possible.
- Do NOT add `--provenance` to the `npm install` command — provenance is a publishing concern, not an install concern.
- If `spiny-orb@latest` is not yet published (e.g., testing before first release), the workflow will fail at the install step with a 404. This is expected and correct behavior.

---

## Progress Log

_Updated by `/prd-update-progress` as milestones complete._
