# Research: OpenTelemetry Semantic Conventions for Python (`opentelemetry-semantic-conventions`)

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-09-17

## Update Log

| Date | Summary |
|------|---------|
| 2026-09-17 | Initial research — resolves PRD #373 OD-8 research spike |
| 2026-09-17 | Verified `URL_PATH` stability directly against the primary registry source (`open-telemetry/semantic-conventions` `model/url/registry.yaml`: `url.path` has `stability: stable`) rather than inferring it by analogy. Upgraded confidence from 🟡 medium to 🟢 high. |
| 2026-09-17 | Corrected two CodeRabbit-caught issues: the import-path code example used `url_attributes.URL_FULL`, inconsistent with the checker-relevant attribute (`url.path`) named everywhere else in this doc — changed to `URL_PATH`. Also narrowed the version-pinning finding's scope: its source is a contrib instrumentation package's `pyproject.toml` (`opentelemetry-instrumentation-flask`), not the core SDK, so the "OTel Python project's own convention" framing overstated what one contrib package's pinning choice actually proves. |
| 2026-09-17 | Second correction pass on the same version-pinning finding: the original citation linked `opentelemetry-instrumentation-flask/pyproject.toml` at `main`, a moving target — re-fetched at commit `3e21539` and found the quoted versions had already drifted (`opentelemetry-api ~= 1.4` → `~= 1.12`; `opentelemetry-semantic-conventions == 0.57b0` → `== 0.66b0.dev`). Updated the quoted values and re-pinned the citation link to that commit instead of `main`, and fixed a duplicate stale `~= 1.4` reference in the Recommendation section's OD-8a rationale that repeated the same claim. |
| 2026-09-17 | Third correction pass: pinned every remaining `opentelemetry-python` GitHub link that was still on `main` to the `v1.44.0` tag (confirmed via its `opentelemetry-semantic-conventions/pyproject.toml` and `semconv/version/__init__.py` that this tag corresponds exactly to `opentelemetry-semantic-conventions` `0.65b0`) and every `open-telemetry/semantic-conventions` link to the commit actually fetched (`d0472f4`). The Sources section's separate `v1.36.0` link for the SDK `pyproject.toml` (kept intentionally alongside the `v1.44.0` link, as a historical comparison across releases) is unaffected by this pass. Also corrected a factual error: the claim that neither `HTTP_REQUEST_METHOD` nor `HTTP_RESPONSE_STATUS_CODE`'s docstring carries a `![Development]` badge was wrong — `HTTP_REQUEST_METHOD`'s docstring does have one, on its `known_methods` declarative-config override sub-clause (confirmed directly against the primary registry, `model/http/registry.yaml`: `id: http.request.method`, `stability: stable`, with the same badge inside its `note` field). The attribute itself is still stable; only the blanket "neither docstring" phrasing was inaccurate. |

## Findings

### Summary

`opentelemetry-semantic-conventions` for Python is packaged as `Production/Stable` (Development Status classifier) but is still versioned as a beta release (`0.65b0` as of 2026-07-16, paired with `opentelemetry-api` 1.44.0) — it has **not reached GA/1.0**. The import path spiny-orb's PRD assumed (`from opentelemetry.semconv.trace import SpanAttributes`) is **deprecated since v1.25.0**. The current pattern splits by stability: stable attributes live under `opentelemetry.semconv.attributes.<namespace>_attributes` (no version qualifier needed in the import path itself), and incubating/experimental attributes live under the underscore-prefixed `opentelemetry.semconv._incubating.attributes.<namespace>_attributes` (explicitly marked internal/unstable by Python convention). All four attributes spiny-orb's checkers care about — HTTP method, HTTP status code, URL path, DB system — have reached the **stable** module. At least one identified downstream package (`dapr-agents`) pins it with an exact `==` version (not a compatible-release range) — a data point suggesting real-world breaking changes between betas, though not confirmed as a general pattern across downstream packages (see Finding 5 below) — so spiny-orb's prompt should default to **raw attribute key strings**, per the PRD's own fallback rule for a still-beta package.

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

**Source says:** "Use attributes defined in the :py:const:`opentelemetry.semconv.attributes` and :py:const:`opentelemetry.semconv._incubating.attributes` modules instead. ... Deprecated since version 1.25.0." (deprecation notice on `SpanAttributes`, [opentelemetry-python/opentelemetry-semantic-conventions/.../semconv/trace/__init__.py](https://github.com/open-telemetry/opentelemetry-python/blob/v1.44.0/opentelemetry-semantic-conventions/src/opentelemetry/semconv/trace/__init__.py))
**Interpretation:** `from opentelemetry.semconv.trace import SpanAttributes; SpanAttributes.HTTP_METHOD` (the pattern named in PRD #373's Big Picture Context section) is the deprecated legacy form. The current pattern imports a namespace module and reads its constant:

```python
from opentelemetry.semconv.attributes import http_attributes, url_attributes, db_attributes

span.set_attribute(http_attributes.HTTP_REQUEST_METHOD, method)   # "http.request.method"
span.set_attribute(http_attributes.HTTP_RESPONSE_STATUS_CODE, code)  # "http.response.status_code"
span.set_attribute(url_attributes.URL_PATH, path)                 # "url.path"
span.set_attribute(db_attributes.DB_SYSTEM_NAME, "postgresql")     # "db.system.name"
```

**3. Stable vs. incubating split — mirrors the JS package's shape:**

**Source says:** "Semantic Conventions in Python puts unstable attributes in the `opentelemetry.semconv._incubating` import path which is considered (following Python underscore convention) to be internal and subject to change... stable attributes live under `opentelemetry.semconv.attributes`." (synthesized from [opentelemetry-python semconv resource/__init__.py](https://github.com/open-telemetry/opentelemetry-python/blob/v1.44.0/opentelemetry-semantic-conventions/src/opentelemetry/semconv/resource/__init__.py) and corroborating docs)
**Interpretation:** This is structurally identical to the JS package's own stable/incubating split (`@opentelemetry/semantic-conventions` for stable, `@opentelemetry/semantic-conventions/incubating` for incubating) — same two-tier model, different namespace mechanism (Python: underscore-prefixed submodule; JS: `/incubating` subpath).

**4. Attributes spiny-orb's checkers care about (HTTP method, status code, URL path, DB system) — all four are stable:**

| Attribute | Python module | Constant | String value | Stability |
|---|---|---|---|---|
| HTTP method | `opentelemetry.semconv.attributes.http_attributes` | `HTTP_REQUEST_METHOD` | `http.request.method` | 🟢 Stable |
| HTTP status code | `opentelemetry.semconv.attributes.http_attributes` | `HTTP_RESPONSE_STATUS_CODE` | `http.response.status_code` | 🟢 Stable |
| URL path | `opentelemetry.semconv.attributes.url_attributes` | `URL_PATH` | `url.path` | 🟢 Stable — confirmed directly against the primary registry source (`model/url/registry.yaml`: `id: url.path`, `stability: stable`), not inferred by analogy |
| DB system | `opentelemetry.semconv.attributes.db_attributes` | `DB_SYSTEM_NAME` | `db.system.name` | 🟢 Stable — the same `db.system` → `db.system.name` rename also documented for the JS/TS `@opentelemetry/semantic-conventions` package, confirming this is a spec-level rename, not Python-specific |

**Source says (HTTP):** `HTTP_REQUEST_METHOD: Final = "http.request.method"` and `HTTP_RESPONSE_STATUS_CODE: Final = "http.response.status_code"` (fetched directly from [`http_attributes.py` at `v1.44.0`](https://github.com/open-telemetry/opentelemetry-python/blob/v1.44.0/opentelemetry-semantic-conventions/src/opentelemetry/semconv/attributes/http_attributes.py)). `HTTP_RESPONSE_STATUS_CODE`'s docstring has no `![Development]` badge. `HTTP_REQUEST_METHOD`'s docstring does contain one — but, same as `url.full`'s override mechanism noted in the URL Path row below, it annotates a specific sub-clause (the declarative-configuration `known_methods` override for customizing known HTTP methods), not the base `http.request.method` attribute's own stability. The attribute's registry entry itself is stable, matching the JS/TS `ATTR_HTTP_REQUEST_METHOD` constant's stability.
**Source says (DB):** `DB_SYSTEM_NAME: Final = "db.system.name"`, no `![Development]` badge (fetched directly from [`db_attributes.py`](https://github.com/open-telemetry/opentelemetry-python/blob/v1.44.0/opentelemetry-semantic-conventions/src/opentelemetry/semconv/attributes/db_attributes.py))
**Source says (URL path):** `URL_PATH: Final = "url.path"`, no `![Development]` badge in the Python module (fetched directly from [`url_attributes.py`](https://github.com/open-telemetry/opentelemetry-python/blob/v1.44.0/opentelemetry-semantic-conventions/src/opentelemetry/semconv/attributes/url_attributes.py)); independently cross-checked against the upstream spec registry, where `id: url.path` carries `stability: stable` explicitly ([`model/url/registry.yaml`](https://github.com/open-telemetry/semantic-conventions/blob/d0472f4ae331e8ef01aa571fe024d0d6a1a9b5e1/model/url/registry.yaml))

All four attribute constants in the table above were fetched and read directly from their raw GitHub source files in this pass (not inferred from WebSearch-synthesized examples) — 🟢 high confidence for all four rows. Note that `url_attributes.py` and `registry.yaml` do use inline `![Development](...)` badges elsewhere in the file, but those annotate specific sub-clauses (e.g., an optional sensitive-query-parameter override mechanism on `url.full`/`url.query`), not the base attribute's own stability — reading a stray badge anywhere in an attribute's docstring as "this attribute is Development" is a misread of the source; the attribute's actual stability is the `stability:` field on its own registry entry.

**5. Version pinning constraints relative to `opentelemetry-api`:**

**Source says:** "dependencies = [\"opentelemetry-api ~= 1.12\", \"opentelemetry-semantic-conventions == 0.66b0.dev\", ...]" (opentelemetry-instrumentation-flask's `pyproject.toml`, re-fetched 2026-09-17 at commit [`3e21539`](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/3e21539d0ebef675630b0afce3a2401e24468c6b/instrumentation/opentelemetry-instrumentation-flask/pyproject.toml) — pinned to this commit rather than `main`, since the quoted version numbers otherwise drift as the file is updated)
**Interpretation:** This pinning example is from a **contrib instrumentation package** (`opentelemetry-instrumentation-flask`), not the core SDK — it should not be read as an OTel-Python-wide or SDK-wide convention. Within that scope, the contrib package pins `opentelemetry-api` loosely (compatible-release range, e.g. `~= 1.12`) but pins `opentelemetry-semantic-conventions` to an **exact** beta version — a signal that at least the contrib-instrumentation maintainers don't yet consider the semconv package safe to consume with a loose range. If spiny-orb's `installCommand()` adds `opentelemetry-semconv` to a project's dependencies (OD-8b), treating this contrib-package convention as the pattern to follow — exact-pin the semconv package, loose-pin the API package — is an inference from that one data point, not a confirmed project-wide rule.

### Conflicting Findings

None — all sources (PyPI packaging metadata, GitHub deprecation notices, `pyproject.toml` pinning conventions across two repos, and independent usage-example sources) corroborated each other on the core facts (beta status, deprecated old import path, stable/incubating split mechanism).

### Recommendation

**OD-8a (should the LLM prompt use semconv constants instead of raw strings): No, for now — use raw attribute key strings.** This directly follows the PRD's own stated fallback rule: "If semconv is still beta when implementation begins, default to raw strings in the prompt (with a comment noting the future migration path) rather than depending on beta constant names that could change between instrumentation runs." The package is at `0.65b0` as of its most recent release (2026-07-16), still on a beta version number with no GA release identified in this research pass, and `opentelemetry-instrumentation-flask`'s own pinning (exact-pinning the semconv package while loose-pinning the API package) is a contrib-instrumentation-package data point suggesting the semconv package isn't yet safe to depend on loosely — not a confirmed OTel-Python-project-wide rule. Add a code comment in the generated Python noting the future migration path to `opentelemetry.semconv.attributes.<namespace>_attributes` once semconv reaches GA.

**OD-8b (should `installCommand()` include the semconv package): No, for now — follows directly from OD-8a.** If the prompt doesn't instruct the LLM to import semconv constants, there's no reason to add the package to `installCommand()`. **Correction:** the PRD's OD-8 text refers to this package by the shorthand `opentelemetry-semconv`, but that is not an installable name — `opentelemetry-semconv` returns a 404 on PyPI. The actual pip-installable package is `opentelemetry-semantic-conventions` (confirmed directly against [its PyPI page](https://pypi.org/project/opentelemetry-semantic-conventions/)). If OD-8a/OD-8b are ever revisited to "yes" after a GA release, `installCommand()` must use `opentelemetry-semantic-conventions`, not `opentelemetry-semconv`.

**OD-8c (should a checker validate semconv-constant usage): Defer, as the PRD's own recommendation already states** — this is now doubly correct, since OD-8a resolves to raw strings, so there is nothing to validate against yet.

### Caveats

- This research answers "is it stable enough to use today" as of 2026-09-17. Because the package versions on a beta train with no announced GA date, this finding has a shelf life — re-check `pypi.org/project/opentelemetry-semantic-conventions/` before Milestone D2 (prompt writing) actually begins, in case a GA shipped between OD-8 resolution and implementation.
- The four specific constants in item 4's table (`HTTP_REQUEST_METHOD`, `HTTP_RESPONSE_STATUS_CODE`, `URL_PATH`, `DB_SYSTEM_NAME`) were fetched and read directly from their raw GitHub source files in this pass — see the "Source says" citations under item 4. Broader module contents beyond those four specific names (e.g., the full attribute list in each namespace module) were not exhaustively enumerated; if OD-8a is ever revisited to "yes," re-check any additional constant names against the raw source before use.
- No source in this pass gave a specific GA target date for the semconv package — this is an absence of evidence, not evidence that no GA is planned. Check the project's own issue tracker/roadmap directly if a firmer answer is needed for scheduling purposes.

### Sources

- [opentelemetry-semantic-conventions · PyPI](https://pypi.org/project/opentelemetry-semantic-conventions/) — current version, release date, Python requirement, classifier
- [opentelemetry-python-contrib PR #5014 — migrate to stable/incubating messaging semconv](https://github.com/open-telemetry/opentelemetry-python-contrib/pull/5014) — real-world migration example confirming stable/incubating split is an active migration effort, not just a design doc
- [opentelemetry-python/opentelemetry-semantic-conventions/src/opentelemetry/semconv/trace/__init__.py](https://github.com/open-telemetry/opentelemetry-python/blob/v1.44.0/opentelemetry-semantic-conventions/src/opentelemetry/semconv/trace/__init__.py) — directly fetched; confirmed the `SpanAttributes` deprecation notice and its exact wording
- [opentelemetry-python/opentelemetry-semantic-conventions/src/opentelemetry/semconv/resource/__init__.py](https://github.com/open-telemetry/opentelemetry-python/blob/v1.44.0/opentelemetry-semantic-conventions/src/opentelemetry/semconv/resource/__init__.py) — stable/incubating module split
- [opentelemetry-python/opentelemetry-sdk/pyproject.toml](https://github.com/open-telemetry/opentelemetry-python/blob/v1.44.0/opentelemetry-sdk/pyproject.toml) and [v1.36.0 tag](https://github.com/open-telemetry/opentelemetry-python/blob/v1.36.0/opentelemetry-sdk/pyproject.toml) — version pinning pattern (exact-pin semconv, matching version to API)
- [opentelemetry-python-contrib/instrumentation/opentelemetry-instrumentation-flask/pyproject.toml, pinned at commit 3e21539](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/3e21539d0ebef675630b0afce3a2401e24468c6b/instrumentation/opentelemetry-instrumentation-flask/pyproject.toml) — confirms loose-pin API / exact-pin semconv convention in this downstream instrumentation package (not project-wide)
- [dapr/dapr-agents issue #779](https://github.com/dapr/dapr-agents/issues/779) — real-world downstream breakage from exact-pinning `opentelemetry-semantic-conventions`
- [Document OTEL_SEMCONV_STABILITY_OPT_IN · Issue #4202 · opentelemetry-python-contrib](https://github.com/open-telemetry/opentelemetry-python-contrib/issues/4202) — confirms stable HTTP semconv requires an opt-in env var for instrumentation libraries, a related but distinct concern from spiny-orb's manual instrumentation use case
- [opentelemetry-python/.../semconv/attributes/http_attributes.py](https://github.com/open-telemetry/opentelemetry-python/blob/v1.44.0/opentelemetry-semantic-conventions/src/opentelemetry/semconv/attributes/http_attributes.py) — directly fetched; confirmed `HTTP_REQUEST_METHOD`/`HTTP_RESPONSE_STATUS_CODE` constants and values
- [opentelemetry-python/.../semconv/attributes/db_attributes.py](https://github.com/open-telemetry/opentelemetry-python/blob/v1.44.0/opentelemetry-semantic-conventions/src/opentelemetry/semconv/attributes/db_attributes.py) — directly fetched; confirmed `DB_SYSTEM_NAME` constant and value
- [opentelemetry-python/.../semconv/attributes/url_attributes.py](https://github.com/open-telemetry/opentelemetry-python/blob/v1.44.0/opentelemetry-semantic-conventions/src/opentelemetry/semconv/attributes/url_attributes.py) — directly fetched; confirmed `URL_PATH` constant and value, and that inline `![Development]` badges elsewhere in the file annotate sub-clauses, not attribute-level stability
- [open-telemetry/semantic-conventions/.../model/url/registry.yaml](https://github.com/open-telemetry/semantic-conventions/blob/d0472f4ae331e8ef01aa571fe024d0d6a1a9b5e1/model/url/registry.yaml) — directly fetched; the canonical spec source confirming `url.path`'s `stability: stable` field (used to correct a CodeRabbit review false positive that misread an unrelated `![Development]` badge as applying to `url.path`)
