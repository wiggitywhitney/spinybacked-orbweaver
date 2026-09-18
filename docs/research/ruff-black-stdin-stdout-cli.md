# Research: Ruff and Black CLI stdin/stdout formatting, and Python compile() syntax errors

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-09-18

## Update Log
| Date | Summary |
|------|---------|
| 2026-09-18 | Initial research, for Milestone D1's checkSyntax()/formatCode()/lintCheck() |

## Findings

### Summary

`ruff format -` and `black -` both read source from stdin and write formatted source to stdout, with `-` as the sole positional argument (no extra flags required). Both fail loudly and distinctly on a syntax error, but with an important divergence: **Black's failure still writes the original (unformatted) code to stdout**, so a caller cannot distinguish success from failure by checking whether stdout is non-empty — the exit code is the only reliable signal. Ruff, by contrast, writes nothing to stdout on failure. `python3 -c "compile(...)"` writes its `SyntaxError` traceback to stderr only, with the failing line number recoverable via a `File "<path>", line (\d+)` pattern in that traceback (the second `File` line — the first is always `File "<string>", line 1, in <module>` from the `-c` wrapper).

### Verified directly (all findings below were reproduced locally against the installed binaries, not just read from docs — ruff 0.15.2, black 25.1.0, Python 3.10.13, 🟢 high confidence)

| Case | Command | Exit code | stdout | stderr |
|---|---|---|---|---|
| Ruff, valid input | `ruff format -` | 0 | formatted code | (empty) |
| Ruff, syntax error | `ruff format -` | 2 | (empty) | `error: Failed to parse at 2:5: ...` |
| Black, valid input | `black -` (or `black - -q`) | 0 | formatted code | status messages (unless `-q`) |
| Black, syntax error | `black -` | **123** | **original unformatted source, unchanged** | `error: cannot format -: Cannot parse: 2:4: ...` |
| Missing binary | `execFileSync('ruff'/'black', ...)` | n/a | n/a | Node throws with `error.code === 'ENOENT'` |
| `python3 -c "compile(open(f).read(), f, 'exec')"`, valid | — | 0 | (empty) | (empty) |
| `python3 -c "compile(...)"`, syntax error | — | 1 | (empty) | full traceback (see below) |

**Node's `execFileSync` throws on any non-zero exit** (Ruff's 2, Black's 123, Python's 1), so a single `try { execFileSync(...) } catch (e) { ... }` correctly separates the success and failure paths for all three tools — the caller never has to branch on stdout content alone. This resolves the Black gotcha: even though Black's stdout on a parse failure contains the (unchanged) original source, the caller never reaches that stdout inside the `try` block's success path, because the non-zero exit throws first.

### Ruff

- `ruff format -` reads stdin and writes formatted code to stdout. Confirmed by Ruff maintainer charliermarsh in a GitHub discussion: `cat foo.py | ruff format -` works with no other flags. 🟢 high (maintainer-confirmed + reproduced locally).
- `--stdin-filename` is optional for `ruff format` — it only matters when Ruff needs the real filename for config/filetype resolution (e.g., matching `[tool.ruff]` overrides by path). Plain `-` is sufficient for a one-off, config-agnostic format call. 🟢 high.
- **Gotcha, not in `--help`:** as of Ruff 0.14.13, a Ruff maintainer (ntBre) acknowledged that `ruff format -` (stdin mode) isn't documented in the CLI's own `--help` output — it's a real, functional, but currently-undocumented capability. Do not conclude from `ruff format --help` alone that stdin support doesn't exist. 🟡 medium (single GitHub discussion, but from a maintainer).
- On a syntax error: exit code **2**, empty stdout, `error: Failed to parse at LINE:COL: <message>` on stderr. 🟢 high (reproduced locally).
- General (non-stdin-specific) exit codes per the official formatter docs: `0` success (formatted or not), `1` only if `--exit-non-zero-on-format` was explicitly passed and something changed, `2` on invalid config/CLI options/internal error (syntax-error-on-stdin falls under this `2` bucket in practice). 🟢 high (docs.astral.sh/ruff/formatter/).
- `ruff check --fix` (the linter, not the formatter) does **not** support the same stdin→stdout round-trip — with `--fix` on stdin input it only prints a summary count, not the fixed code, per an open Ruff feature request (astral-sh/ruff#20460, unresolved as of this research). Not relevant to this milestone (only `ruff format` is used), but worth remembering if a future milestone wants Ruff's linter (not formatter) output.

### Black

- `black -` reads stdin and writes formatted code to stdout — official docs example: `echo "print ( 'hello, world' )" | black -` → `print("hello, world")` on stdout, with `reformatted -` / `All done! ✨ 🍰 ✨` progress banners on **stderr**, never mixed into stdout. 🟢 high (official docs + reproduced locally).
- **Gotcha (the one that matters most here): on a parse failure, Black's exit code is 123, but stdout is NOT empty — it contains the original, unformatted input unchanged.** Reproduced locally: piping an unclosed-paren file through `black -` returns exit 123, stderr `error: cannot format -: Cannot parse: 2:4: ...` plus a `💥` banner, and stdout is the original 2-line file verbatim. A caller that only inspects "did stdout come back non-empty" would wrongly treat this as a successful (no-op) format. **Always check the exit code, not stdout emptiness, to detect a Black failure.** 🟢 high (reproduced locally; not spelled out this explicitly in the docs excerpt fetched).
- `-q`/`--quiet` suppresses the progress banners on stderr but does not suppress real error output — error messages "will still be emitted (which can [be] silenced by `2>/dev/null`)." 🟢 high (official docs).
- Exit code semantics from the docs (for `--check` mode specifically, which is the only place Black's docs enumerate codes numerically): `0` nothing would change, `1` reformatting needed, `123` internal error. The locally-reproduced parse failure on plain `black -` (no `--check`) also returned `123` — consistent with the docs' "internal error" bucket, since a parse failure is not a normal "would reformat" outcome. 🟢 high (reproduced locally, docs confirm the `123` meaning).

### Python `compile()` syntax errors

- `python3 -c "compile(open(f).read(), f, 'exec')"` writes nothing to stdout in either the success or failure case; on failure the full traceback goes to stderr, exit code 1. 🟢 high (reproduced locally).
- The traceback always has **two** `File` lines when invoked this way: the first is always `File "<string>", line 1, in <module>` (an artifact of the `-c` wrapper script itself, always line 1, never the real error location) and the second is `File "<real path>", line N` — that second line's `N` is the actual failing line number. A naive regex matching the *first* `File ".*", line (\d+)` occurrence will always incorrectly report line 1. **Match the line-number pattern anchored to the real file path, or take the last match, not the first.** 🟢 high (reproduced locally).
- Example full traceback:
  ```text
  Traceback (most recent call last):
    File "<string>", line 1, in <module>
    File "/tmp/bad.py", line 1
      def foo(x:
             ^
  SyntaxError: '(' was never closed
  ```

### Detecting "not installed"

- Node's `child_process.execFileSync('ruff'/'black', [...])` throws synchronously with `error.code === 'ENOENT'` when the binary isn't found on `PATH` — no need for a separate `which`/`--version` probe before attempting the real format call; catch `ENOENT` specifically to distinguish "not installed" from "installed but the input was rejected" (non-zero exit with a different `error.code`, or `error.status` set). 🟢 high (reproduced locally with Node directly).

## Recommendation

For `formatCode(source, configDir)`: try `ruff format -` first (spawn with `input: source`); on `ENOENT` (ruff not installed) or any other failure, try `black -` the same way; on `ENOENT` for black too, return `source` unchanged. Do not fall back to Black on a *parse-error* failure from Ruff (exit 2 with a real parse error means the code is genuinely invalid, and Black will fail identically) — only fall back on `ENOENT`. For `lintCheck()`, treat "neither tool installed" (both throw `ENOENT`) as the advisory failure with the canonical OD-2 message.

For `checkSyntax(filePath)`: shell out to `python3 -c "compile(...)"`, catch the throw, take the line number from the traceback's real-file `File` line (not the first `<string>` one), and surface the trimmed traceback tail (from `SyntaxError:` onward, or the whole stderr) as the message.

## Caveats

- All reproduced findings used Ruff 0.15.2 and Black 25.1.0 (local versions, September 2026) and Python 3.10.13. Exit code numbers for parse failures (`2` for Ruff, `123` for Black) are not guaranteed stable across all future major versions — re-verify if either tool's changelog mentions CLI exit-code changes.
- `ruff format -`'s undocumented status in `--help` (per the GitHub discussion) means a future Ruff release could change or formalize this behavior; watch Ruff's changelog if formatCode() output changes unexpectedly after an upgrade.

## Sources
- [Using `ruff` in pipes (formatting stdin and writing to stdout)? · astral-sh/ruff · Discussion #13690](https://github.com/astral-sh/ruff/discussions/13690) — confirms `ruff format -` works standalone, and its undocumented status as of 0.14.13
- [The Ruff Formatter - Astral Docs](https://docs.astral.sh/ruff/formatter/) — general (non-stdin) exit code semantics
- [`ruff check --fix` to stdout when reading from stdin · Issue #20460 · astral-sh/ruff](https://github.com/astral-sh/ruff/issues/20460) — confirms `ruff check --fix` does NOT support the same stdout round-trip (not used by this milestone, but a related gotcha)
- [The basics - Black documentation](https://black.readthedocs.io/en/stable/usage_and_configuration/the_basics.html) — `black -` stdin/stdout example, stderr-only status messages, `-q` behavior, `--check` exit codes
- Local reproduction against ruff 0.15.2, black 25.1.0, Python 3.10.13 (this repo's dev machine) — primary source for exact exit codes and stdout content on parse failures, since none of the fetched docs pages stated the exact numeric exit code or the Black stdout-on-failure gotcha explicitly
