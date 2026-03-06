# PRD: Per-File Schema Extension Writing

**Issue**: [#31](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/31)
**Status**: In Progress
**Priority**: High
**Blocked by**: None (all required infrastructure exists from Phases 4-5)
**Created**: 2026-03-06

## What Gets Built

Move schema extension writing from the post-dispatch batch step into the per-file dispatch loop. After each successful file, write its schema extensions to the registry immediately and re-resolve the schema before the next file. This ensures each file's agent sees the accumulated schema from all previous files, preventing duplicate or conflicting span/attribute names.

Additionally:
- `FileResult.schemaHashBefore` and `schemaHashAfter` become meaningful (hash changes when extensions are written between files)
- Schema state is snapshot and reverted on file failure (spec requires "copies the file and its corresponding schema state")
- `writeSchemaExtensions` is called incrementally per-file, not once at end-of-run
- Extensions are validated (via `weaver registry check`) immediately after writing, before the next file processes — invalid extensions are caught and rolled back per-file rather than persisting until post-dispatch validation
- Checkpoint infrastructure failures produce warnings instead of silently degrading (`dispatch.ts` lines 219-221 swallow errors with no diagnostic output)

## Why This Phase Exists

The spec is explicit (line 92):

> **Schema re-resolution:** The Coordinator re-resolves the Weaver schema (`weaver registry resolve`) before each file, not once at startup. Since agents can extend the schema and their changes are committed to the feature branch after each successful file (step 4e), subsequent agents must see those extensions to avoid creating duplicate attributes or conflicting span IDs.

The current implementation re-resolves the schema per file (correct) but never writes extensions between files (incorrect). The schema is identical every time it's resolved because nothing changed on disk. This defeats the purpose of re-resolution entirely.

The consequence: if file A instruments a payment flow and creates `app.payment.process` as a new span, file B (which calls into the payment flow) has no way to know that span exists. File B's agent may create `app.payment.handle` for the same operation, or duplicate `app.payment.process` with different attributes. This is exactly the kind of schema inconsistency the tool is designed to prevent.

This is a correctness fix, not a feature. The spec's design is clear; the implementation diverged.

## Acceptance Gate

| Criterion | Verification | Rubric Rules |
|-----------|-------------|--------------|
| Extensions written after each successful file | Instrument a 3-file project where file B depends on schema entries from file A; verify file B's agent receives the extended schema including file A's contributions | SCH-001, SCH-004 |
| `schemaHashBefore` differs from `schemaHashAfter` when extensions are written | Inspect `FileResult` for a file that creates schema extensions; hashes must differ | — |
| `schemaHashAfter` of file N equals `schemaHashBefore` of file N+1 | Hash sequence across `FileResult` array shows monotonic schema growth | — |
| Failed file's schema extensions are reverted | Instrument a file that fails validation after creating extensions; verify extensions are removed from registry before next file processes | — |
| Periodic checkpoints still work correctly | Run with `schemaCheckpointInterval: 2` on a multi-file project; checkpoints see the incrementally-extended schema | — |
| End-of-run batch write is removed or becomes a no-op | Verify `coordinate()` no longer writes extensions in a separate post-dispatch step (extensions are already written per-file) | — |
| Per-file extension validation before next file | After writing extensions for file N, run `weaver registry check` before processing file N+1; invalid extensions are rolled back immediately rather than persisting | SCH-003 |
| Checkpoint infrastructure failures produce warnings | Trigger a checkpoint infrastructure error (e.g., Weaver CLI not found mid-run); verify warning appears in `RunResult.warnings` instead of silent swallow | DX |
| Existing tests continue to pass | All unit, integration, and acceptance gate tests pass | NDS-001, NDS-002 |

## Cross-Cutting Requirements

### Structured Output (DX Principle)

Schema extension write results are reported per-file. If an extension is rejected (namespace violation) during per-file writing, the rejection appears in that file's `FileResult.warnings` or equivalent, not in a deferred batch summary.

### Two-Tier Validation Awareness

No new validation stages. This PRD changes when extensions are written, not how they're validated. The SCH Tier 2 checks (SCH-001 through SCH-004) benefit from this change — when wired into the fix loop (issue #23), they'll validate against a schema that includes prior files' contributions.

## Spec Reference

| Section | Scope | Lines | Notes |
|---------|-------|-------|-------|
| Schema re-resolution | Full paragraph | 92 | "agents can extend the schema and their changes are committed... subsequent agents must see those extensions" |
| File/Directory Processing | Full | 494–516 | "Schema changes propagate: via git commits on feature branch" |
| File Revert Protocol | Full | 506–510 | "copies the file (and its corresponding schema state if the agent modified it) to a temp location" |
| Schema Extension Guardrails | Full | 731–742 | Namespace prefix, structural patterns, drift detection |
| Result Data → Schema Hash Tracking | Subsection | 1255–1258 | "trace exactly which agent introduced a schema change" |
| FileResult.schemaHashBefore/After | Fields | 1140–1141 | "hash of resolved schema before/after agent ran" |

**Spec file**: `docs/specs/telemetry-agent-spec-v3.9.md`

## Interface Contract

No new types or interfaces. This PRD changes the timing and location of existing operations:

- `writeSchemaExtensions()` — already exists in `src/coordinator/schema-extensions.ts`. Currently called once in `coordinate()` after dispatch. Will be called per-file inside `dispatchFiles()`.
- `resolveSchema()` — already exists in `src/coordinator/dispatch.ts`. Already called per-file. After this PRD, it will see updated schema because extensions were written to disk after the previous file.
- `computeSchemaHash()` — already exists in `src/coordinator/schema-hash.ts`. Currently called to set `schemaHashBefore` (before instrumenting) and `schemaHashAfter` (currently identical). After this PRD, `schemaHashAfter` is computed after extensions are written.
- `FileResult.schemaHashBefore` / `schemaHashAfter` — already defined. Become meaningful.

## Module Organization

No new modules. Changes are localized to:

```text
src/
  coordinator/
    dispatch.ts        Primary change: per-file extension writing + schema revert on failure
    coordinate.ts      Remove or simplify post-dispatch batch extension writing
    schema-extensions.ts  May need incremental write mode (append vs overwrite)
```

**Module dependency rules:**
- `dispatch.ts` gains a dependency on `schema-extensions.ts` (currently only `coordinate.ts` calls `writeSchemaExtensions`)
- No new cross-module dependencies

## Milestones

- [x] **Milestone 1: Per-file extension writing in dispatch loop** — Move `writeSchemaExtensions()` call into the `dispatchFiles()` for-loop, executed after each successful file (after `instrumentFn` returns with `status: 'success'`). Extensions from the current file are written to `agent-extensions.yaml` before the next file's `resolveSchema()` call. The existing `collectSchemaExtensions` + `writeSchemaExtensions` functions may need adjustment to support incremental writing via an in-memory accumulator with full-file overwrite (see Decision Log), rather than append-in-place YAML mutation. Verify: (a) file B's resolved schema includes extensions from file A, (b) `weaver registry check` passes after each incremental write, (c) extensions accumulate correctly across files.

- [x] **Milestone 2: Meaningful schemaHashBefore/After** — Compute `schemaHashAfter` after extensions are written (not before, as currently). The hash sequence across the `FileResult` array should show: file A's `schemaHashAfter` equals file B's `schemaHashBefore` (when A wrote extensions). For files that don't create extensions, `schemaHashBefore` equals `schemaHashAfter`. Verify: (a) hashes differ when extensions are written, (b) hash chain is continuous across files, (c) a file with no extensions shows identical before/after hashes.

- [x] **Milestone 3: Schema state revert on file failure** — Before processing each file, snapshot the current `agent-extensions.yaml` (or record its absence). If the file fails (status `'failed'`), restore the snapshot so the failed file's schema extensions don't pollute subsequent files. The spec says "copies the file (and its corresponding schema state if the agent modified it) to a temp location." Verify: (a) failed file's extensions don't appear in the next file's resolved schema, (b) successful file followed by failed file followed by successful file has correct schema state throughout, (c) snapshot cleanup on success.

- [x] **Milestone 4: Remove or simplify post-dispatch batch write** — The batch `collectSchemaExtensions` + `writeSchemaExtensions` call in `coordinate()` (lines 240–253) is now redundant because extensions are written per-file in dispatch. Either remove it or convert it to a verification step that confirms the final `agent-extensions.yaml` matches the accumulated per-file extensions. Verify: (a) removing the batch write doesn't change behavior (extensions already on disk), (b) `RunResult` warnings from extension writing still surface correctly.

- [x] **Milestone 5: Per-file extension validation** — After writing extensions for each file, run `weaver registry check` on the registry to validate the extended schema immediately. If the check fails, roll back the extensions (restore from snapshot) and treat the file as failed. This catches invalid extensions at the source file rather than letting them persist until a periodic checkpoint or end-of-run validation. The current implementation writes extensions in a post-dispatch batch without validation before subsequent files process — invalid extensions from file A could corrupt file B's schema context. **Performance note:** This per-file `registry check` is intentionally separate from periodic checkpoints (Milestone 7). Checkpoints are coarse-grained every-N-files validation; this is immediate post-write validation to catch problems before the next file processes. The overhead of an extra `registry check` per file is acceptable given it prevents cascading schema corruption. Verify: (a) invalid extension (e.g., malformed YAML that passes namespace check but fails Weaver validation) is detected immediately, (b) the file is marked failed and extensions rolled back, (c) subsequent files see clean schema.

- [ ] **Milestone 6: Checkpoint infrastructure failure visibility** — The `catch` block at `dispatch.ts` lines 219-221 silently swallows checkpoint infrastructure failures (e.g., Weaver CLI crashes, `execFile` timeout). Add the error to a warnings list so it surfaces in `RunResult.warnings`. The `onSchemaCheckpoint` callback should not fire on infrastructure failures (it currently doesn't, which is correct), but the user must be told that a checkpoint was skipped and why. Verify: (a) Weaver CLI failure during checkpoint produces a warning in `RunResult.warnings`, (b) dispatch continues (degrade-and-warn, not abort), (c) subsequent checkpoints still attempt to run.

- [ ] **Milestone 7: Integration with periodic checkpoints** — Verify that periodic schema checkpoints (`weaver registry check` + `weaver registry diff` every N files) see the incrementally-extended schema. Since extensions are now written per-file, checkpoints should reflect cumulative changes. **Test callout:** `dispatch-checkpoint.test.ts` specifically needs attention — per-file validation (Milestone 5) changes the checkpoint counting flow, and existing checkpoint tests may need adjustment to account for the additional `registry check` calls happening between checkpoints. Verify: (a) checkpoint after file 2 sees extensions from files 1 and 2, (b) checkpoint diff shows incremental additions, (c) checkpoint failure handling still works (stop processing, blast radius reporting).

- [ ] **Milestone 8: Acceptance gate passes** — End-to-end with a multi-file test project where files have cross-file schema dependencies: (a) later files see earlier files' schema contributions, (b) hash chain is monotonically growing, (c) failed files' extensions are reverted, (d) checkpoints see accumulated extensions, (e) checkpoint infrastructure failures produce warnings, (f) per-file extension validation catches invalid extensions, (g) all existing tests pass.

## Dependencies

- **Phase 5**: Provides `schema-extensions.ts` (`writeSchemaExtensions`, `collectSchemaExtensions`), `schema-hash.ts` (`computeSchemaHash`), `dispatch.ts` (per-file schema resolution).
- **Phase 4**: Provides `coordinate.ts` (dispatch orchestration, post-dispatch extension writing).
- **Issue #23**: `buildValidationConfig` missing SCH checks. This PRD and #23 are independent — this PRD fixes write timing, #23 fixes validation wiring. Both are needed for the spec's full vision to work, but neither blocks the other.
- **External**: Weaver CLI (for `registry resolve` and `registry check` after each write).

## Out of Scope

- Wiring SCH checks into the fix loop (issue #23 — separate concern)
- Per-file git commits (Phase 7 — this PRD writes to the filesystem; Phase 7 commits to git)
- Parallel file processing (the spec acknowledges sequential processing for now; parallel would require a schema merge strategy)
- Changes to the agent prompt or LLM interaction (the agent already declares extensions; this PRD changes when the coordinator writes them)

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-06 | **Incremental writing: Option (b) — in-memory accumulator with full overwrite** | Simplest change to existing `writeSchemaExtensions` signature. Avoids YAML merge complexity of option (a). Makes revert trivial (overwrite with snapshot). Option (c) per-source-file YAML adds filesystem clutter and couples to Weaver's directory resolution behavior. |
| 2026-03-06 | **Schema revert: single-file snapshot of `agent-extensions.yaml`** | `writeSchemaExtensions` only writes this one file, so snapshotting the full registry directory is overkill. Snapshot before processing each file; restore on failure. Record absence if file doesn't exist yet. |
| 2026-03-06 | **Filesystem writes only — no git commits** | Per-file extension writes go to disk. Git commits are Phase 7's responsibility. This PRD is a correctness fix for schema state propagation within a single run, not a git workflow change. |
