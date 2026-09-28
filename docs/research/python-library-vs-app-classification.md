# Research: Classifying a Python Project as a Distributable Library vs. an Application

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-09-28

## Update Log

| Date | Summary |
|------|---------|
| 2026-09-28 | Initial research (PRD #373 Milestone D4, OD-9b) |
| 2026-09-28 | Revised after review: a missing `[build-system]` is not an application marker (PyPA specification says tools should not require it); added the `setup.cfg` library criteria and a legacy Poetry caveat |

## Findings

### Summary
No single manifest field reliably separates a Python library from an application. `[build-system]` is present in both (current `uv init` apps and FastAPI's own app template have it). `[project.scripts]` appears in both (Black, HTTPX, pytest, Strawberry and Litestar are libraries or tools with CLIs). The only marks that reliably say "not a distributable library" are negative and opt-in: the `Private :: Do Not Upload` classifier and Poetry's `package-mode = false`. A missing `[build-system]` is a weaker mark: `uv init --no-package` omits it, but the packaging specification says tools should not require the table, so a library can omit it too. Separately, real libraries declare `opentelemetry-sdk` in optional-dependency extras, so a rule that scans a whole manifest for SDK packages would flag well-regarded libraries.

### Surprises & Gotchas

- **`[build-system]` is not a library signal.** Since uv v0.12, `uv init` for an application also generates one.
- **`[project.scripts]` is not an application signal.** Libraries ship CLIs, and an app can have none.
- **Real libraries put `opentelemetry-sdk` in an extra.** Strawberry and Litestar both do.
- **`[project]` scripts can be written as dotted keys** (`scripts.pytest = ...`), which a header-based line parser for `[project.scripts]` would miss. A real TOML parser is needed.
- **Positive "library" markers do not exist.** Every reliable marker is a negative one.

### Findings

**1. `[build-system]` is present in apps as well as libraries** 🟢 high
**Source says:** "A build system is defined, so the project will be installed into the environment." (default `uv init` app) and "Prior to v0.12, uv did not define a build system for applications by default." ([uv: Creating projects](https://docs.astral.sh/uv/concepts/projects/init/))
**Source says:** FastAPI's own full-stack template backend (an application) has `build-backend = "hatchling.build"`, no `[project.scripts]`, and no `classifiers` key. ([full-stack-fastapi-template pyproject.toml](https://raw.githubusercontent.com/fastapi/full-stack-fastapi-template/master/backend/pyproject.toml))
**Source says:** The PyPA guide calls the table "strongly recommended" and says it "should always be present, regardless of which build backend you use." ([PyPA: Writing your pyproject.toml](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/))
**Interpretation:** Requiring `[build-system]` as evidence of a library would classify the FastAPI app template and every default `uv init` app as libraries. Manifests without it exist (`uv init --no-package` omits it, per the uv docs: "does not include a build system, it is not a package"), but that does not make absence an application marker.
**Source says:** "Tools should not require the existence of the `[build-system]` table." and "If the file exists but is lacking the `[build-system]` table then the default values as specified above should be used." ([PyPA: pyproject.toml specification](https://packaging.python.org/en/latest/specifications/pyproject-toml/))
**Interpretation:** A library that relies on the default build semantics is valid, so a missing `[build-system]` alone cannot classify a project as an application.

**2. `[project.scripts]` does not distinguish libraries from apps** 🟢 high (for existence; sample is small)
**Source says:** Libraries or tools with CLIs, from their own manifests: Black (`black`, `blackd`), HTTPX (`httpx`), pytest (`pytest`, `py.test`), Strawberry (`strawberry`), Litestar (`litestar`). The FastAPI app template has none. Default `uv init` apps include one and `uv init --lib` does not.
**Interpretation:** The PRD's "no CLI entry points" condition would classify Black, HTTPX, pytest, Strawberry and Litestar as apps, so they would never be checked. It would classify the FastAPI template as a library. Both errors come from the same heuristic. Only the second is harmful here.

**3. `Private :: Do Not Upload` is a real but rare "not a library" marker** 🟡 medium
**Source says:** "To prevent a package from being uploaded to PyPI, use the special `Private :: Do Not Upload` classifier." and "PyPI will always reject packages with classifiers beginning with `Private ::`." ([PyPA guide](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/))
**Source says:** None of the sampled real projects' manifests use the classifier: Black, HTTPX and pytest have no classifier containing "Private", and the FastAPI template has no classifiers at all. Named real uses found: aspect-build/bazel-examples (`classifiers = ["Private :: Do Not Upload"]`), clebidk/scottie (a private CLI), and Hynek Schlawack for private packages. ([Hynek](https://hynek.me/articles/sharing-your-labor-of-love-pypi-quick-and-dirty/), [GitHub search summary](https://github.com/aspect-build/bazel-examples/blob/main/pyproject.toml))
**Source says:** Tooling friction exists: `poetry check` reports "Unrecognized classifiers" ([poetry #7167](https://github.com/python-poetry/poetry/issues/7167)), `flit build` warned ([flit #413](https://github.com/pypa/flit/issues/413)), and `uv publish` fails in a workspace containing it ([uv #16290](https://github.com/astral-sh/uv/issues/16290)).
**Interpretation:** It is a high-precision, low-recall signal. When present it reliably means "not for PyPI", but most private apps do not set it, so it cannot be the only exemption. Prevalence is estimated from a small sample and not measured.

**4. Poetry and uv both have explicit non-package modes** 🟢 high
**Source says:** "Whether Poetry operates in package mode (default) or not." ([Poetry: pyproject.toml](https://python-poetry.org/docs/pyproject/)). Non-package mode cannot build or publish the project, per Poetry's basic-usage page.
**Source says:** `uv init --no-package`: "does not include a build system, it is not a package, and will not be installed into the environment." ([uv docs](https://docs.astral.sh/uv/concepts/projects/init/))
**Interpretation:** Both are reliable exemptions from the library check. They are opt-in, so they do not cover apps that use the default packaged mode.

**5. `setup.cfg` has no application marker at all** 🟢 high
**Source says:** `[metadata]`, `[options]` with `packages = find:` and `install_requires`, and `[options.entry_points]` with `console_scripts`. A `setup.py` is still required for legacy builds. ([setuptools: declarative config](https://setuptools.pypa.io/en/latest/userguide/declarative_config.html))
**Interpretation:** For `setup.cfg`-only projects, only entry points and classifiers are available, and finding 2 already showed entry points do not discriminate.

**6. Real libraries declare `opentelemetry-sdk` in extras** 🟢 high
**Source says:** Strawberry: `opentelemetry = ["opentelemetry-api<2", "opentelemetry-sdk<2"]` under `[project.optional-dependencies]`. Litestar: `opentelemetry = ["opentelemetry-instrumentation-asgi", "opentelemetry-sdk"]`. ([strawberry pyproject.toml](https://raw.githubusercontent.com/strawberry-graphql/strawberry/main/pyproject.toml), [litestar pyproject.toml](https://raw.githubusercontent.com/litestar-org/litestar/main/pyproject.toml))
**Source says:** "You may want to make some of your dependencies optional, if they are only needed for a specific feature of your package." ([PyPA guide](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/))
**Interpretation:** These extras are opt-in, so a consumer who does not install the extra is not forced into an SDK choice. That is a weaker violation than the runtime-dependency case the OTel contrib README targets ("Libraries that produce telemetry data should only depend on `opentelemetry-api`"). A rule scanning the whole manifest would flag both libraries. A rule scoped to required runtime dependencies would not.

**7. TOML dotted keys defeat header-based parsing** 🟢 high
**Source says:** pytest writes `scripts.pytest = "_pytest.config:_console_main"` under `[project]`, not in a `[project.scripts]` table. ([pytest pyproject.toml](https://raw.githubusercontent.com/pytest-dev/pytest/main/pyproject.toml))
**Interpretation:** The two forms are equivalent TOML. Detection by looking for a `[project.scripts]` or `[project.optional-dependencies]` header misses the dotted form. A real TOML parser is required for `pyproject.toml`.

### Conflicting Findings
- **Source A says:** "Libraries that produce telemetry data should only depend on `opentelemetry-api`" ([opentelemetry-python-contrib README](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/README.md), from the prior research file).
- **Source B says:** Strawberry and Litestar declare `opentelemetry-sdk` in an optional extra.
- **Interpretation:** Not a strict contradiction. The README speaks about what a library depends on. The extras make the SDK an opt-in choice for the consumer. Whether an extra counts as "depending" is a policy decision for the rule, not a fact the sources settle.

### Recommendation
Drop the "positive library signal" approach: none exists. Two changes to D4's design follow.
1. **Scope the check to required runtime dependencies** (`[project].dependencies`, `setup.cfg` `install_requires`), not optional extras. Extras stay allowed. This avoids flagging Strawberry and Litestar.
2. **Classify by exclusion.** Treat a project as an application (skip the SDK check) if any of these hold: `Private :: Do Not Upload` classifier; Poetry `package-mode = false`; `requirements.txt` is the only manifest (a missing `[build-system]` alone is not an application marker; see finding 1). Treat it as a library only when it has `[project]` (or, for `setup.cfg` projects, `[metadata]` plus `[options]` packages) plus publication intent, meaning at least one PyPI-facing classifier (for example `Development Status ::`). Black, HTTPX and pytest have them, and the FastAPI template and default `uv init` apps do not. This publication-intent signal is **inferred from a six-project sample, not established**, and needs testing.

### Caveats
- Poetry's pre-2.0 layout has no `[project]` table and keeps dependencies under `[tool.poetry.dependencies]`. The rule as decided cannot classify or read those manifests, so it skips them with an explicit message (PRD #373 Decision D-D4-2). Parsing `[tool.poetry.dependencies]` was left out of scope.
- The sample is six real manifests (Black, HTTPX, pytest, Strawberry, Litestar, FastAPI template), plus documented defaults for uv and Poetry. It supports "these signals do not discriminate." It does not measure how often the classifier-presence heuristic is right across the ecosystem.
- Strawberry's and Litestar's classifiers were not inspected, so the sample does not confirm they would pass the publication-intent test.
- Flask application samples were not fetched. Flask itself is a library and is not a counterexample.
- The Poetry docs page fetched did not characterize non-package mode as "application" or "library". That inference is ours.

## Sources
- [uv: Creating projects](https://docs.astral.sh/uv/concepts/projects/init/) — app and library defaults, v0.12 build-system change, `--no-package`
- [PyPA: Writing your pyproject.toml](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/) — `Private ::` classifier, `[project.scripts]`, extras, `[build-system]` status
- [PyPA: pyproject.toml specification](https://packaging.python.org/en/latest/specifications/pyproject-toml/) — `[build-system]` is optional and has default semantics when missing
- [Poetry: pyproject.toml](https://python-poetry.org/docs/pyproject/) — `package-mode`, scripts
- [setuptools: declarative config](https://setuptools.pypa.io/en/latest/userguide/declarative_config.html) — `setup.cfg` sections
- [Black pyproject.toml](https://raw.githubusercontent.com/psf/black/main/pyproject.toml), [HTTPX](https://raw.githubusercontent.com/encode/httpx/master/pyproject.toml), [pytest](https://raw.githubusercontent.com/pytest-dev/pytest/main/pyproject.toml) — library manifests with CLIs, dotted-key scripts
- [full-stack-fastapi-template](https://raw.githubusercontent.com/fastapi/full-stack-fastapi-template/master/backend/pyproject.toml) — application manifest with `[build-system]` and no scripts
- [Strawberry](https://raw.githubusercontent.com/strawberry-graphql/strawberry/main/pyproject.toml), [Litestar](https://raw.githubusercontent.com/litestar-org/litestar/main/pyproject.toml) — `opentelemetry` extras declaring the SDK
- [Hynek: PyPI quick and dirty](https://hynek.me/articles/sharing-your-labor-of-love-pypi-quick-and-dirty/), [bazel-examples pyproject.toml](https://github.com/aspect-build/bazel-examples/blob/main/pyproject.toml) — real `Private ::` usage
- [poetry #7167](https://github.com/python-poetry/poetry/issues/7167), [flit #413](https://github.com/pypa/flit/issues/413), [uv #16290](https://github.com/astral-sh/uv/issues/16290) — tooling friction with the classifier
