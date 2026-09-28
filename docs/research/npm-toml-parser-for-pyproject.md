# Research: npm TOML Parser for Reading Python `pyproject.toml`

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-09-28

## Update Log

| Date | Summary |
|------|---------|
| 2026-09-28 | Initial research (PRD #373 Milestone D4, TOML parser choice per Decision D-D4-2) |

## Findings

### Summary
Use `smol-toml` (1.9.0). It is ESM with bundled types, has zero runtime dependencies, parsed all six real manifests correctly including pytest's dotted-key form, throws catchable errors with line and column, and has an explicit option (`unsafeKeyBehaviour: 'throw'`) for untrusted input. `toml` 5.0.0 is a viable runner-up. `@iarna/toml` must not be used: it fails on Black's real `pyproject.toml`.

### Surprises & Gotchas

- **`@iarna/toml` fails on valid, real-world manifests.** It rejects Black's `pyproject.toml` with "Inline lists must be a single type, not a mix of inline-table and string." Arrays of mixed types are valid TOML 1.0. It is the parser older articles most often recommend, and it last changed in 2023.
- **Node has no built-in TOML support.** On Node v25.8.0, `util.parseToml` and `globalThis.TOML` are both undefined.
- **The `toml` package's history is misleading.** Older versions supported only TOML 0.4. Version 5.0.0 (2026-07-14) claims TOML 1.1.0, so advice about the old package does not apply to the current one.
- **`__proto__` in a TOML document becomes an own key, not a prototype change.** No parser polluted `Object.prototype`, but every parser returns an object with an own `__proto__` property. Only downstream merging code (`Object.assign({}, parsed)`) could turn that into pollution.
- **Integers beyond 53 bits throw by default** in `smol-toml`, `toml`, `@ltd/j-toml` and `confbox` (`@iarna/toml` returns a `bigint`). A syntactically valid manifest with a huge integer would throw, so the caller must treat any throw as "could not parse."
- **`@ltd/j-toml` is LGPL-3.0.** That needs a license review against this project's Apache-2.0 license before use. It also last changed in 2023.

### Findings

**1. Node has no built-in TOML parser** 🟢 high
Checked directly on Node v25.8.0: `typeof util.parseToml` and `typeof globalThis.TOML` are both `undefined`.

**2. Registry facts (2026-09-28)** 🟢 high

| Package | Version | Last modified | Types | Module type | Runtime deps | License | Downloads/week |
|---|---|---|---|---|---|---|---|
| smol-toml | 1.9.0 | 2026-09-22 | bundled | ESM (`"type": "module"`) | 0 | BSD-3-Clause | 41,118,431 |
| toml | 5.0.0 | 2026-07-14 | bundled | CommonJS (named `parse` import works from ESM) | 0 | MIT | 27,536,712 |
| @iarna/toml | 2.2.5 | 2023-07-15 | none in registry metadata | CommonJS | 0 | ISC | 9,073,839 |
| @ltd/j-toml | 1.38.0 | 2023-01-16 | bundled | CommonJS | 0 | LGPL-3.0 | not checked |
| fast-toml | 0.5.4 | 2022-05-02 | none in registry metadata | CommonJS | 0 | MIT | not checked |
| confbox | 0.3.1 | 2026-09-03 | bundled | ESM | 0 | MIT | 74,178,258 |

`fast-toml` was excluded on staleness without being run. `confbox` is a multi-format wrapper (TOML, YAML, JSONC). Its TOML error messages match `smol-toml`'s exactly, but its source was not checked, so whether it bundles `smol-toml` is unconfirmed.

**3. Real manifests: dotted keys and extras parse identically in four of five candidates** 🟢 high
All five parsers were run against real manifests fetched on 2026-09-28: Black, HTTPX, pytest, Strawberry, Litestar, and FastAPI's full-stack template backend. `smol-toml`, `toml`, `@ltd/j-toml` and `confbox` parsed all six. Each returned pytest's dotted-key scripts as `{"py.test":"_pytest.config:_console_main","pytest":"_pytest.config:_console_main"}` under `project.scripts`, and each returned the `opentelemetry` extra key for Strawberry and Litestar. `@iarna/toml` parsed five and failed on Black. A synthetic `[project]` with `scripts.a = "b:c"` gave the same nested shape as the table form in all five.

**4. Error behavior on malformed input: all throw synchronously** 🟢 high
All five threw on an unclosed table header, an unterminated string, a duplicate key, and a redefined table. Location data differs:
- `smol-toml`: an `Error` subclass with `line` (1) and `column` (9) properties and a `codeblock` string, verified on the installed 1.9.0.
- `@iarna/toml`: "at row 1, col 10, pos 9" in the message.
- `@ltd/j-toml`: "at line 1" in the message.
- `toml`: a `SyntaxError` describing expected characters, with no line number in the first message line.
Only `@iarna/toml` accepted a BOM-prefixed document as an error (`Unknown character "65279"`), as did `@ltd/j-toml`. `smol-toml`, `toml` and `confbox` parsed it.

**5. `smol-toml` has an explicit untrusted-key policy** 🟢 high
**Source says:** the library "is protected against prototype pollution and will correctly assign a plain property named e.g. `__proto__`", and warns that careless use of the result, for example `Object.assign({}, a)`, can still cause pollution. Its `unsafeKeyBehaviour` option (added in 1.9.0) has `keep` (default), `drop`, and `throw` modes. ([smol-toml README](https://github.com/squirrelchat/smol-toml))
**Verified on the installed 1.9.0:** `keep` returned `{"__proto__":{"polluted":true},"project":{"name":"x"}}`, `drop` returned `{"project":{"name":"x"}}`, and `throw` raised "Invalid TOML document: document contains an unsafe property".
**Interpretation:** For untrusted third-party manifests, `throw` fits this project's rule that code fails explicitly instead of silently dropping data. A legitimate `pyproject.toml` never contains a `__proto__` key.

**6. Spec versions and compliance** 🟡 medium (claims, not independently run through the toml-test suite)
**Source says:** `smol-toml` is "fully spec-compliant with TOML v1.1.0" and passes the `toml-test` suite, with a footnote: "By default, certain invalid datetimes (e.g. `2020-02-30`) are gracefully accepted." ([smol-toml README](https://github.com/squirrelchat/smol-toml))
**Source says:** `toml-node` "supports TOML v1.1.0", scores "702/708 (99.2%)" on `toml-test`, uses the Peggy parser generator, requires Node.js 20 or later, and states "Zero runtime dependencies." ([toml-node README](https://github.com/BinaryMuse/toml-node))
**Interpretation:** Python's own `tomllib` implements TOML 1.0, so real manifests are 1.0. A 1.1 parser accepts everything 1.0 does, so this is not a compatibility risk. The README of `toml` does not describe v5 as a rewrite. That it is one is inferred from the same maintainer and repository, the Peggy-style error messages, and the version jump from 3.x.

**7. Value types differ across parsers** 🟢 high
- **Dates:** `smol-toml` returns a `TomlDate` (subclass of `Date`); `@iarna/toml` returns a `Date`; `toml` returns a string; `@ltd/j-toml` returns a `LocalDate`. For `pyproject.toml` this is irrelevant because the fields the rule reads are strings and arrays of strings.
- **Large integers:** the option for beyond-safe-range integers is `integersAsBigInt` in `smol-toml` and `bigint` in `toml`. Neither is needed for this use.

### Conflicting Findings
None. The README claims and the empirical results agree, apart from the point that `toml` and `smol-toml` READMEs did not describe TOML 1.0-versus-1.1 edge cases, which is not relevant to real manifests.

### Recommendation
Choose `smol-toml`.
1. Call `parse(source, { unsafeKeyBehaviour: 'throw' })` inside a `try`/`catch`, and treat any throw as "manifest could not be parsed": skip the rule for that project and record the reason. Do not fall back to a different parsing approach.
2. Do not spread or `Object.assign` the parsed object into another object. Read the fields directly (`doc.project?.dependencies`).
3. Runner-up: `toml` 5.0.0, if a reason to avoid `smol-toml` appears. It is CommonJS, so it would be imported as `import { parse } from 'toml'` (verified to work from ESM).

### Caveats
- The six manifests are a small sample. They show the parsers handle real-world dotted keys and mixed-type arrays. They do not prove full TOML compliance.
- `smol-toml` has a single maintainer per registry metadata. Its 41 million weekly downloads suggest wide use, but the bus-factor risk is not measured.
- The `toml` README says it passes 702 of 708 `toml-test` cases. Which six fail was not checked.
- `confbox` and `fast-toml` were not tested in depth (see Finding 2).
- Adding `smol-toml` makes this the project's first TOML dependency. It is a runtime dependency of a published CLI, so its version range belongs in `package.json` `dependencies`, not `devDependencies`.

## Sources
- [smol-toml README](https://github.com/squirrelchat/smol-toml) — spec version, `unsafeKeyBehaviour`, `integersAsBigInt`, `TomlDate`
- [toml-node README](https://github.com/BinaryMuse/toml-node) — TOML 1.1.0, 702/708 toml-test, Peggy, zero dependencies, Node 20+
- npm registry (`npm view`, 2026-09-28) — versions, last-modified dates, licenses, dependency counts, module type
- npm downloads API (`api.npmjs.org/downloads/point/last-week`, week ending 2026-09-27) — weekly downloads
- Local test run in a temporary directory: five parsers against six real manifests fetched from GitHub on 2026-09-28 (Black, HTTPX, pytest, Strawberry, Litestar, FastAPI template) and twelve adversarial inputs
