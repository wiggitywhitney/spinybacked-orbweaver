# Research: Python OTel API/SDK Dependency Placement vs API-002's Motivating Risk

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-07-17

## Update Log
| Date | Summary |
|------|---------|
| 2026-07-17 | Initial research |

## Findings

### Summary
OTel Python **does** have the same API-vs-SDK dependency-placement convention as JS (libraries depend on `opentelemetry-api`, applications add `opentelemetry-sdk`). But the specific failure mode that motivates JS's API-002 (Dependency Placement) — silent trace-propagation breakage from multiple SDK instances nested in `node_modules` — does not exist in Python, because Python's packaging model structurally prevents multiple instances of a package from coexisting in one environment. Milestone D4's premise that "the OTel spec basis is identical to JavaScript API-002" is correct for the *convention*, but the *rationale* needs revision.

### Surprises & Gotchas
- The multi-instance tracing-break risk that grounds JS API-002 is an npm-specific artifact of nested `node_modules` (multiple copies of `@opentelemetry/sdk-*` can coexist at different tree depths with independently duplicated global state). Python's flat `site-packages` model and pip's resolver make this structurally impossible — pip raises `ResolutionImpossible` rather than installing two versions side by side.
- Python's real OTel tracing-break bugs are a completely different class: initialization-order bugs (`get_tracer_provider()` called before `set_tracer_provider()` permanently locks in a no-op provider) and fork/multiprocessing propagation bugs. Neither is detectable via a manifest-level dependency-placement check.

### Findings

**1. The API-vs-SDK convention exists in Python, matching JS in intent** — 🟢 high confidence
**Source says:** "Libraries that produce telemetry data should only depend on `opentelemetry-api`, and defer the choice of the SDK to the application developer." ([opentelemetry-python-contrib README](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/README.md))
**Interpretation:** This mirrors JS contrib's GUIDELINES.md language almost exactly. Milestone D4's core check (flag libraries depending on `opentelemetry-sdk`/`opentelemetry-exporter-*`/`opentelemetry-instrumentation-*`, require `opentelemetry-api`) is well-grounded — the convention itself transfers cleanly.

**2. Python's flat, single-version-per-environment packaging model structurally prevents the npm failure mode** — 🟢 high confidence
**Source says:** Per pip's dependency resolution docs, pip installs a single version of any given package per environment. The docs illustrate a hypothetical conflict (`package_coffee` needing `package_water<3.0.0,>=2.4.2` while `package_tea` needs `package_water==2.3.1`) and state pip "cannot install a single version of `package_water` that satisfies both," raising `ResolutionImpossible` rather than installing multiple versions side by side. ([pip dependency resolution docs](https://pip.pypa.io/en/stable/topics/dependency-resolution/))
**Interpretation:** npm's API-002 risk exists *because* nested `node_modules` lets multiple copies of `@opentelemetry/sdk-*` coexist at different tree depths, each with independent module-level global state (context/propagation globals duplicated per copy). Python's `site-packages` has no equivalent nesting — there is exactly one `opentelemetry-sdk` module object per interpreter process (cached in `sys.modules`), so there is no mechanism for two independent copies of the global `_TRACER_PROVIDER` singleton to exist simultaneously and silently diverge the way duplicate npm SDK copies can.

**3. Python's actual OTel tracing-break bugs are ordering/lifecycle bugs, not multi-instance bugs** — 🟢 high confidence
**Source says:** "calling `trace.get_tracer()` before setting a global tracer provider effectively disables all tracing for the process" — `get_tracer_provider()` sets the global `_TRACER_PROVIDER` to the default no-op implementation if unset, and subsequent `set_tracer_provider()` calls are then silently ignored. ([opentelemetry-python issue #1159](https://github.com/open-telemetry/opentelemetry-python/issues/1159), [issue #1276](https://github.com/open-telemetry/opentelemetry-python/issues/1276))
**Source says:** A separate bug describes spans generated in a forked child process not being exported despite tracer provider setup in the parent process — "the global tracer provider singleton doesn't properly propagate/reinitialize across forked processes." ([opentelemetry-python issue #4215](https://github.com/open-telemetry/opentelemetry-python/issues/4215))
**Interpretation:** These are real Python-specific tracing-break risks — but they're runtime initialization-order and multiprocessing bugs, not something a manifest-level dependency-placement rule (reading `pyproject.toml`/`requirements.txt`/`setup.cfg`) could ever detect or prevent. They are out of scope for a D4-style static check.

**4. `opentelemetry.io`'s Python libraries page has no dependency-placement guidance** — 🟢 high confidence
**Source says:** The page at `https://opentelemetry.io/docs/languages/python/libraries/` covers using instrumentation libraries and installing them via pip; it contains no mention of dependency placement, peer dependencies, or package declarations.
**Interpretation:** Unlike JS (where the OTel main site plus contrib's GUIDELINES.md both discuss the convention), Python's guidance on this topic lives only in the contrib repo's README, not the main docs site. This affects where D4's rule documentation should cite as its spec basis.

### Conflicting Findings
None — sources corroborate each other consistently (pip docs, contrib README, and multiple independent GitHub issues all point the same direction).

### Recommendation
Keep Milestone D4's rule (advisory, checks `opentelemetry-api` vs `opentelemetry-sdk`/exporter/instrumentation placement in Python manifests) — it is still good package hygiene and matches the real OTel Python community convention. But rewrite D4's rationale: don't claim it prevents "silent trace-propagation breakage" the way JS API-002's rationale does, since that specific risk doesn't exist in Python. The Python-specific motivations are: (a) forcing an SDK/exporter choice on downstream consumers who may want a different backend, (b) unnecessary transitive dependency bloat (exporter deps, gRPC, etc.) pulled into libraries that don't need them, (c) avoiding "Attempting to instrument while already instrumented" double-init warnings when both a library and its consuming app independently configure providers.

### Caveats
- This doesn't rule out *application-level* multi-provider bugs (e.g., repeated init in long-running/serverless processes creating duplicate exporters, as seen in Azure Monitor scenarios) — but that's a runtime configuration issue, not a dependency-placement issue, and D4 as scoped (static manifest check) cannot address it.
- Scope was Python only per issue #1017. Go's equivalent question is explicitly out of scope and will get its own placeholder milestone separately.

## Sources
- [opentelemetry-python-contrib README](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/README.md) — confirms API/SDK separation convention
- [pip dependency resolution docs](https://pip.pypa.io/en/stable/topics/dependency-resolution/) — confirms single-version-per-environment model
- [opentelemetry-python issue #1159](https://github.com/open-telemetry/opentelemetry-python/issues/1159) — DefaultTracerProvider lock-in bug
- [opentelemetry-python issue #1276](https://github.com/open-telemetry/opentelemetry-python/issues/1276) — premature get_tracer() disables tracing
- [opentelemetry-python issue #4215](https://github.com/open-telemetry/opentelemetry-python/issues/4215) — fork-related propagation break
- [opentelemetry.io Python libraries docs](https://opentelemetry.io/docs/languages/python/libraries/) — checked, no dependency-placement guidance there (confirms guidance lives only in contrib README, not the main site)
