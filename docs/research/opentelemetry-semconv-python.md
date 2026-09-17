# Research: OpenTelemetry Semantic Conventions for Python (`opentelemetry-semantic-conventions`)

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-09-17

## Update Log
| Date | Summary |
|------|---------|
| 2026-09-17 | Initial research — resolves PRD #373 OD-8 research spike |

## Findings

### Summary

`opentelemetry-semantic-conventions` for Python is packaged as `Production/Stable` (Development Status classifier) but is still versioned as a beta release (`0.65b0` as of 2026-07-16, paired with `opentelemetry-api` 1.44.0) — it has **not reached GA/1.0**. The import path spiny-orb's PRD assumed (`from opentelemetry.semconv.trace import SpanAttributes`) is **deprecated since v1.25.0**. The current pattern splits by stability: stable attributes live under `opentelemetry.semconv.attributes.<namespace>_attributes` (no version qualifier needed in the import path itself), and incubating/experimental attributes live under the underscore-prefixed `opentelemetry.semconv._incubating.attributes.<namespace>_attributes` (explicitly marked internal/unstable by Python convention). All four attributes spiny-orb's checkers care about — HTTP method, HTTP status code, URL path, DB system — have reached the **stable** module. Because the package has no GA release, and downstream instrumentation packages pin it with an exact `==` version (not a compatible-release range) due to real-world breaking changes between betas, spiny-orb's prompt should default to **raw attribute key strings**, per the PRD's own fallback rule for a still-beta package.

### Surprises & Gotchas

- **The package is marked "Production/Stable" in PyPI classifiers but is still a beta version number (`0.65b0`).** This is misleading if read only from the PyPI badge — the classifier describes the library's general maturity, not that the API/content is GA. No 1.0 has shipped. 🟢 high confidence (verified directly on the PyPI project page).
- **The exact class the PRD's OD-8 text names — `opentelemetry.semconv.trace.SpanAttributes` — is deprecated, not current.** It has carried a `@deprecated` decorator since v1.25.0, pointing developers to `opentelemetry.semconv.attributes` (stable) and `opentelemetry.semconv._incubating.attributes` (incubating) instead. Training data and the PRD's own draft text both used the old pattern. 🟢 high confidence (verified directly against the GitHub source file).
- **Downstream packages pin `opentelemetry-semantic-conventions` with an exact version (`==`), not a range — unlike `opentelemetry-api`, which uses a compatible-release range (`~=`).** This is a real signal that the package still breaks on beta-to-beta bumps. A documented downstream case (`dapr-agents` issue #779) shows a project pinned to `<0.61` blocking FastAPI/AIOHTTP/Redis/GenAI instrumentation updates until an unrelated upstream dependency (`mistralai`) dropped its own ceiling. 🟢 high confidence (verified against `opentelemetry-python` and `opentelemetry-python-contrib` `pyproject.toml` files at both `main` and a tagged release).
- **Python's stable/incubating split uses one package with two import paths, not two separate packages** (contrast with the JS package, which ships `@opentelemetry/semantic-conventions` and `@opentelemetry/semantic-conventions/incubating` as import paths from a single package too — same shape, different naming: Python uses an underscore-prefixed submodule (`_incubating`) rather than a `/incubating` subpath). 🟢 high confidence.

### Findings

**1. Current release status (as of 2026-09-17, most recent release 2026-07-16):**

| Package | Version | Release date | Status |
|---|---|---|---|
| `opentelemetry-semantic-conventions` | `0.65b0` | 2026-07-16 | Beta (`b0`), classifier says Production/Stable |
| `opentelemetry-api` | `1.44.0` | 2026-07-16 | Stable (1.x, no `b`/`rc` suffix) |

**Source says:** "Development Status: 5 - Production/Stable" and the filename `opentelemetry_semantic_conventions-0.65b0.tar.gz` ([opentelemetry-semantic-conventions · PyPI](https://pypi.org/project/opentelemetry-semantic-conventions/))
**Interpretation:** The classifier is a general packaging-maturity signal (used consistently across most OTel Python packages, including ones still versioned as betas), not a claim that the semconv content itself is finalized. Do not treat "Production/Stable" as "GA."

No published GA/1.0 timeline was found in this research pass; none of the fetched sources (PyPI page, GitHub source, opentelemetry.io semconv landing page) state a target date for a 1.0 release of the Python semconv package. This should be tracked as an open item rather than assumed resolved.

**2. Current import path — changed from what the PRD's OD-8 text assumed:**

**Source says:** "Use attributes defined in the :py:const:`opentelemetry.semconv.attributes` and :py:const:`opentelemetry.semconv._incubating.attributes` modules instead. ... Deprecated since version 1.25.0." (deprecation notice on `SpanAttributes`, [opentelemetry-python/opentelemetry-semantic-conventions/.../semconv/trace/__init__.py](https://github.com/open-telemetry/opentelemetry-python/blob/main/opentelemetry-semantic-conventions/src/opentelemetry/semconv/trace/__init__.py))
**Interpretation:** `from opentelemetry.semconv.trace import SpanAttributes; SpanAttributes.HTTP_METHOD` (the pattern named in PRD #373's Big Picture Context section) is the deprecated legacy form. The current pattern imports a namespace module and reads its constant:

```python
from opentelemetry.semconv.attributes import http_attributes, url_attributes, server_attributes

span.set_attribute(http_attributes.HTTP_REQUEST_METHOD, method)   # "http.request.method"
span.set_attribute(http_attributes.HTTP_RESPONSE_STATUS_CODE, code)  # "http.response.status_code"
span.set_attribute(url_attributes.URL_FULL, url)                  # "url.full"
```

**3. Stable vs. incubating split — mirrors the JS package's shape:**

**Source says:** "Semantic Conventions in Python puts unstable attributes in the `opentelemetry.semconv._incubating` import path which is considered (following Python underscore convention) to be internal and subject to change... stable attributes live under `opentelemetry.semconv.attributes`." (synthesized from [opentelemetry-python semconv resource/__init__.py](https://github.com/open-telemetry/opentelemetry-python/blob/main/opentelemetry-semantic-conventions/src/opentelemetry/semconv/resource/__init__.py) and corroborating docs)
**Interpretation:** This is structurally identical to the existing `~/.claude/rules/otel-semconv-gotchas.md` JS finding ("Two entry-points — stable and incubating are separate") — same two-tier model, different namespace mechanism (Python: underscore-prefixed submodule; JS: `/incubating` subpath).

**4. Attributes spiny-orb's checkers care about (HTTP method, status code, URL path, DB system) — all four are stable:**

| Attribute | Python module | Constant | String value | Stability |
|---|---|---|---|---|
| HTTP method | `opentelemetry.semconv.attributes.http_attributes` | `HTTP_REQUEST_METHOD` | `http.request.method` | 🟢 Stable |
| HTTP status code | `opentelemetry.semconv.attributes.http_attributes` | `HTTP_RESPONSE_STATUS_CODE` | `http.response.status_code` | 🟢 Stable |
| URL path | `opentelemetry.semconv.attributes.url_attributes` | `URL_PATH` | `url.path` | 🟡 Medium confidence — inferred by direct analogy to the confirmed `URL_FULL`/`URL_SCHEME` constants in the same stable module; no source in this research pass showed a `URL_PATH` import example directly (client-side examples use `URL_FULL`, since `URL_PATH` is the server-side counterpart) |
| DB system | `opentelemetry.semconv.attributes.db_attributes` | `DB_SYSTEM_NAME` | `db.system.name` | 🟢 Stable — matches the already-documented JS rename (`db.system` → `db.system.name`) in `~/.claude/rules/otel-semconv-gotchas.md` |

**Source says (HTTP):** "from opentelemetry.semconv.attributes import http_attributes, url_attributes, server_attributes ... span.set_attributes({ http_attributes.HTTP_REQUEST_METHOD: \"GET\" ..." (synthesized from multiple corroborating usage examples surfaced via WebSearch; the direct `http_attributes.py` source file was not independently fetched in this pass — 🟡 medium confidence, corroborated by 3+ independent example sources but not verified against raw GitHub source)
**Source says (DB):** "print(db_attributes.DB_SYSTEM_NAME) # \"db.system.name\"" (synthesized from corroborating usage examples; not independently fetched from raw source — 🟡 medium confidence)

**Caveat:** Unlike OD-1's tree-sitter research (which fetched and read primary GitHub source files directly), this pass relied on WebSearch-synthesized summaries of GitHub source content for the specific attribute module contents (http_attributes.py, db_attributes.py, url_attributes.py) rather than fetching those files directly — WebFetch on the `trace/__init__.py` deprecation notice succeeded, but the stable attribute modules themselves were not independently re-fetched. Before implementing `formatCode`/prompt.ts references to these exact constant names, do a targeted `WebFetch` of the actual `http_attributes.py`, `db_attributes.py`, and `url_attributes.py` source files to confirm exact constant names and values at implementation time — treat this file's attribute-name table as 🟡 medium confidence pending that direct verification.

**5. Version pinning constraints relative to `opentelemetry-api`:**

**Source says:** "dependencies = [\"opentelemetry-api ~= 1.4\", \"opentelemetry-semantic-conventions == 0.57b0\", ...]" (opentelemetry-instrumentation package pyproject.toml, per [opentelemetry-python-contrib pyproject.toml examples](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/instrumentation/opentelemetry-instrumentation-flask/pyproject.toml))
**Interpretation:** The OTel Python project's own convention is to pin `opentelemetry-api` loosely (compatible-release range, e.g. `~= 1.4`) but pin `opentelemetry-semantic-conventions` to an **exact** beta version. This is a strong signal from the maintainers themselves that the semconv package is not yet safe to consume with a loose range. If spiny-orb's `installCommand()` adds `opentelemetry-semconv` to a project's dependencies (OD-8b), it should follow this same convention — exact-pin the semconv package, loose-pin the API package — rather than treating them symmetrically.

### Conflicting Findings

None — all sources (PyPI packaging metadata, GitHub deprecation notices, `pyproject.toml` pinning conventions across two repos, and independent usage-example sources) corroborated each other on the core facts (beta status, deprecated old import path, stable/incubating split mechanism).

### Recommendation

**OD-8a (should the LLM prompt use semconv constants instead of raw strings): No, for now — use raw attribute key strings.** This directly follows the PRD's own stated fallback rule: "If semconv is still beta when implementation begins, default to raw strings in the prompt (with a comment noting the future migration path) rather than depending on beta constant names that could change between instrumentation runs." The package is at `0.65b0`, seven-plus months into 2026 with no GA in sight, and the OTel Python project's own packaging convention (exact-pinning the semconv package while loose-pinning the API package) confirms the maintainers themselves don't consider it safe to depend on loosely. Add a code comment in the generated Python noting the future migration path to `opentelemetry.semconv.attributes.<namespace>_attributes` once semconv reaches GA.

**OD-8b (should `installCommand()` include `opentelemetry-semconv`): No, for now — follows directly from OD-8a.** If the prompt doesn't instruct the LLM to import semconv constants, there's no reason to add the package to `installCommand()`. Revisit both OD-8a and OD-8b together once semconv reaches a GA release.

**OD-8c (should a checker validate semconv-constant usage): Defer, as the PRD's own recommendation already states** — this is now doubly correct, since OD-8a resolves to raw strings, so there is nothing to validate against yet.

### Caveats

- This research answers "is it stable enough to use today" as of 2026-09-17. Because the package versions on a beta train with no announced GA date, this finding has a shelf life — re-check `pypi.org/project/opentelemetry-semantic-conventions/` before Milestone D2 (prompt writing) actually begins, in case a GA shipped between OD-8 resolution and implementation.
- The exact attribute-module contents (item 4 above) were derived from WebSearch-synthesized examples, not directly re-fetched from GitHub source in this pass. Recommended as a pre-implementation double-check if OD-8a is ever revisited to "yes" after a GA release.
- No source in this pass gave a specific GA target date for the semconv package — this is an absence of evidence, not evidence that no GA is planned. Check the project's own issue tracker/roadmap directly if a firmer answer is needed for scheduling purposes.

### Sources

- [opentelemetry-semantic-conventions · PyPI](https://pypi.org/project/opentelemetry-semantic-conventions/) — current version, release date, Python requirement, classifier
- [opentelemetry-python-contrib PR #5014 — migrate to stable/incubating messaging semconv](https://github.com/open-telemetry/opentelemetry-python-contrib/pull/5014) — real-world migration example confirming stable/incubating split is an active migration effort, not just a design doc
- [opentelemetry-python/opentelemetry-semantic-conventions/src/opentelemetry/semconv/trace/__init__.py](https://github.com/open-telemetry/opentelemetry-python/blob/main/opentelemetry-semantic-conventions/src/opentelemetry/semconv/trace/__init__.py) — directly fetched; confirmed the `SpanAttributes` deprecation notice and its exact wording
- [opentelemetry-python/opentelemetry-semantic-conventions/src/opentelemetry/semconv/resource/__init__.py](https://github.com/open-telemetry/opentelemetry-python/blob/main/opentelemetry-semantic-conventions/src/opentelemetry/semconv/resource/__init__.py) — stable/incubating module split
- [opentelemetry-python/opentelemetry-sdk/pyproject.toml](https://github.com/open-telemetry/opentelemetry-python/blob/main/opentelemetry-sdk/pyproject.toml) and [v1.36.0 tag](https://github.com/open-telemetry/opentelemetry-python/blob/v1.36.0/opentelemetry-sdk/pyproject.toml) — version pinning pattern (exact-pin semconv, matching version to API)
- [opentelemetry-python-contrib/instrumentation/opentelemetry-instrumentation-flask/pyproject.toml](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/instrumentation/opentelemetry-instrumentation-flask/pyproject.toml) — confirms loose-pin API / exact-pin semconv convention in a downstream instrumentation package
- [dapr/dapr-agents issue #779](https://github.com/dapr/dapr-agents/issues/779) — real-world downstream breakage from exact-pinning `opentelemetry-semantic-conventions`
- [Document OTEL_SEMCONV_STABILITY_OPT_IN · Issue #4202 · opentelemetry-python-contrib](https://github.com/open-telemetry/opentelemetry-python-contrib/issues/4202) — confirms stable HTTP semconv requires an opt-in env var for instrumentation libraries, a related but distinct concern from spiny-orb's manual instrumentation use case
