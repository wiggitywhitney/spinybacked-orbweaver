# Research: TypeScript tsc CLI Behavior (5.x → 6.x)

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-04-28

## Update Log
| Date | Summary |
|------|---------|
| 2026-04-28 | Initial research — TS5112, --ignoreConfig, stdout vs stderr, new 6.x defaults, --noCheck |

## Findings

### Summary

TypeScript 6.0 (released March 2026) introduced TS5112, a hard error that fires when files are passed on the command line while a tsconfig.json is discoverable. The fix is `--ignoreConfig`, a new tsc 6.x-only flag. tsc writes most diagnostics to **stdout** (not stderr) — this has been the behavior since TypeScript 2.x and remains unchanged in 6.x. `--noCheck` (added in 5.6) skips type-checking without loading a tsconfig. The spiny-orb project has already implemented handling for all of these in `src/languages/typescript/validation.ts`.

---

### Surprises & Gotchas

**The biggest surprise: tsc errors go to stdout, not stderr** — and this is "Working as Intended." Multiple GitHub issues (615, 9526, 12844) report this and are all closed as "By Design." TS5112 specifically also goes to stdout. Any tool capturing tsc output must capture both streams.

The spiny-orb codebase empirically discovered this; line 210 of `validation.ts` reads:
```typescript
// tsc sometimes writes diagnostics to stdout rather than stderr (e.g. TS5112).
```
and the code joins both streams.

---

### 1. TS5112 — "tsconfig.json is present but will not be loaded" (tsc 6.0+)

🟢 **High confidence** — confirmed in official release notes, RC blog post, GitHub issue #62197.

**What triggers it:** Running `tsc <file>` (with file arguments on the CLI) when a `tsconfig.json` is discoverable. tsc walks up ancestor directories to discover tsconfig, so the tsconfig does not need to be in the CWD — TS5112 fires for any tsconfig found by walking up the directory tree.

**Exact error text:**
```text
error TS5112: tsconfig.json is present but will not be loaded if files are specified
on commandline. Use '--ignoreConfig' to skip this error.
```

**Exit code:** Hard error (non-zero exit), not a warning. The `error TS5112:` prefix confirms this.

**Introduced in:** TypeScript 6.0 (March 2026). Not present in any 5.x release.

**Motivation:** AI coding agents ran `tsc foo.ts` expecting defaults, silently ignoring tsconfig, then tried to "fix" errors that were artifacts of wrong compiler settings. TS5112 forces the mismatch to be explicit.

**Source:** "error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline." — [TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)

---

### 2. `--ignoreConfig` Flag

🟢 **High confidence** — in official CLI options docs and release notes.

**Exact flag names:** `--ignoreConfig` (camelCase) or `--ignore-config` (kebab-case) — both accepted.

**What it does:** "Ignore the tsconfig found and build with commandline options and files." Bypasses tsconfig discovery entirely. Suppresses TS5112. No tsconfig is loaded, even from ancestor directories.

**When available:** tsc 6.0+ ONLY. On tsc 5.x, passing `--ignoreConfig` causes "unknown compiler option" error. Must version-gate.

**Recommended pattern for tsc 6+:**
```bash
tsc --noEmit --ignoreConfig --strict [other flags] file.ts
```

**The spiny-orb code does exactly this:**
```typescript
...getTscMajorVersion(tsc) >= 6 ? ['--ignoreConfig'] : [],
```

---

### 3. stdout vs stderr — the long-standing trap

🟢 **High confidence** (empirical + multiple GitHub issues closed "By Design").

tsc has written all diagnostics (errors, warnings, TS5112) to **stdout** since at least TypeScript 2.x. This behavior is marked "Working as Intended" / "By Design" in multiple closed issues:
- [Issue #615](https://github.com/Microsoft/TypeScript/issues/615): "By Design"
- [Issue #9526](https://github.com/Microsoft/TypeScript/issues/9526): "Working as Intended"
- [Issue #12844](https://github.com/microsoft/TypeScript/issues/12844): "Duplicate"/"Working as Intended"

**stderr is used by tsc** only for certain infrastructure/configuration errors (e.g., missing tsconfig when one is required). A [vitest fix](https://github.com/vitest-dev/vitest/commit/7b10ab4cd) added stderr capture specifically for that case: "Also capture stderr for configuration errors like missing tsconfig."

**Practical consequence:** Code that only reads `stderr` from a tsc child process will miss most errors. Must capture both streams and join them.

**No change in 5.x → 6.x.** The stdout-first behavior is unchanged.

---

### 4. New defaults when running tsc 6.x without a tsconfig

🟢 **High confidence** — from official release notes.

When running `tsc --ignoreConfig file.ts` (no tsconfig loaded), tsc 6.0 defaults have changed significantly from 5.x:

| Option | tsc 5.x default | tsc 6.0 default |
|---|---|---|
| `strict` | `false` | `true` |
| `module` | `commonjs` | `esnext` |
| `target` | `es5` | `es2025` |
| `types` | all @types/* | `[]` (none) |
| `rootDir` | inferred from files | `.` |

Tools that relied on 5.x's permissive defaults will see more errors under 6.x. Always pass explicit flags.

---

### 5. `--noCheck` flag (tsc 5.6+)

🟡 **Medium confidence** — from search results; official docs page gave minimal detail.

- **Introduced:** Internal in TypeScript 5.5; public CLI flag in TypeScript 5.6 (September 2024).
- **What it does:** Disables full type checking; only critical parse and emit errors are reported. Faster.
- **Use case:** Tools that want to emit JavaScript without type-checking (separate type-check process). Not the same as `--noEmit`. Does not suppress TS5112 on its own.
- **spiny-orb uses `--noEmit`** (check types, don't emit) which is correct for a validator. `--noCheck` is not used.

---

### 6. Deprecated options that are now hard errors in tsc 6.0

🟢 **High confidence** — from release notes.

These flags, valid in 5.x, now cause hard errors in 6.0 when passed on the CLI:
- `--target es5` (minimum is now ES2015)
- `--moduleResolution node` / `node10`
- `--baseUrl` (as a module resolution root)
- `--outFile` (removed entirely)
- `--module amd` / `umd` / `systemjs` / `none`

Tools that hardcode any of these flags will break under tsc 6.0.

---

### Recommended Pattern for File-by-File Type Checking (tsc 5.x + 6.x compatible)

```typescript
// Detect tsc version first
const version = getTscMajorVersion(tsc); // parse 'Version X.Y.Z' from tsc --version

// Build args array
const args = [
  '--noEmit',
  '--strict',
  '--skipLibCheck',
  '--allowImportingTsExtensions',
  // Only add --ignoreConfig on tsc 6+; it is an unknown flag on 5.x
  ...(version >= 6 ? ['--ignoreConfig'] : []),
  '--module', moduleFlag,
  '--moduleResolution', moduleResolutionFlag,
  '--target', 'ES2022',
  filePath,
];

// Always capture both stdout and stderr — tsc writes errors to stdout (by design)
const result = execFileSync(tsc, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
});
// On error, join error.stdout and error.stderr
```

---

### Caveats

- The exact scope of TS5112's tsconfig discovery (CWD only vs. ancestor walk) is not explicitly documented. The evidence (tsc has always walked ancestor directories; TS5112 fires whenever tsconfig "would be loaded") strongly implies it fires for parent-dir tsconfigs, but no authoritative quote confirms this specific scenario.
- The stdout-first behavior has never been officially documented as a permanent guarantee — it's empirically observed and "Working as Intended." A future major version could change it without announcement.
- tsc 7.0 (Go-based rewrite) is in development. CLI behavioral compatibility is not yet documented.

## Sources

- [TypeScript 6.0 Release Notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html) — official docs for TS5112, --ignoreConfig, new defaults
- [Announcing TypeScript 6.0 (MS Blog)](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/) — confirmed TS5112, --ignoreConfig motivation
- [Announcing TypeScript 6.0 RC (MS Blog)](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0-rc/) — RC details for CLI changes
- [GitHub Issue #62197: Error if command-line options specified when tsconfig present](https://github.com/microsoft/TypeScript/issues/62197) — design discussion for TS5112
- [TypeScript CLI Options docs](https://www.typescriptlang.org/docs/handbook/compiler-options.html) — --ignoreConfig and --noCheck flag reference
- [GitHub Issue #615: Compilation error not reported on stderr](https://github.com/Microsoft/TypeScript/issues/615) — stdout-first behavior, "By Design"
- [GitHub Issue #9526: Errors are output to stdout](https://github.com/Microsoft/TypeScript/issues/9526) — "Working as Intended"
- [GitHub Issue #12844: tsc error message printed to stdout not stderr](https://github.com/microsoft/TypeScript/issues/12844) — "Duplicate"/"Working as Intended"
- [TypeScript 5.x to 6.0 Migration Guide (Gist)](https://gist.github.com/privatenumber/3d2e80da28f84ee30b77d53e1693378f) — migration guide with breaking changes
- [vitest commit 7b10ab4: improve error when tsc outputs help text](https://github.com/vitest-dev/vitest/commit/7b10ab4cd) — empirical evidence for stderr used for config errors
- [TypeScript 5.9 Release Notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html) — 5.9 CLI changes (--init, --module node20)
