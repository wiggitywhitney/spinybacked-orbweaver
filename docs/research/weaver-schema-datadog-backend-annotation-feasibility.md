# Research: Weaver Schema Support for Datadog Backend Indexing Annotations

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-07-06

## Update Log
| Date | Summary |
|------|---------|
| 2026-07-06 | Initial research — investigating whether Weaver's schema format has a mechanism for declaring backend-specific indexing hints (e.g. "this attribute must be a Datadog Metrics without Limits queryable tag"), and whether Datadog publishes an official Weaver dependency registry |

## Findings

### Summary

Weaver's schema format does not currently have a shipped mechanism for declaring backend-specific indexing hints on attributes, and Datadog does not publish a Weaver dependency registry. The attribute-declaration half of the "repeatable Datadog pipeline" story (Weaver schema → Spiny-Orb reliably adds the attribute to spans) is already solved by this project's existing architecture — it does not require anything new from Weaver. The gap is downstream: turning "attribute is reliably on the span" into "attribute is a queryable Datadog metric tag" requires two more hops (Collector `dimensions:` config, then Datadog Metrics without Limits tag configuration) that no tool — not Weaver, not Datadog, not Spiny-Orb today — currently automates from a schema declaration.

### Findings by Question

**Q1: Does Weaver's schema format support vendor-specific backend metadata/annotations on attributes?**

🟡 Medium confidence: Not as a shipped feature. Weaver has a Rego-based policy engine for validating custom annotations/policies (e.g., enforcing naming prefixes), and a forward-looking design doc from the f5/otel-weaver POC describes a planned general annotation/tagging mechanism for the broader "Component Telemetry Schema" concept, explicitly intended to let vendors "extend the definition of concepts defined by OpenTelemetry." But this is a proposal, not current behavior. A custom annotation key (e.g. `x-datadog-index: true`) would likely parse as valid YAML in a Weaver registry definition today, but nothing in Weaver's own tooling reads or acts on it — it would be inert metadata unless a separate tool were written to consume it.

**Source says:** "for all the elements that make up the Component Telemetry Schema, a general mechanism of annotation or tagging will be integrated in order to attach additional traits, characteristics, or constraints, allowing vendors and companies to extend the definition of concepts defined by OpenTelemetry." ([f5/otel-weaver component-telemetry-schema.md](https://github.com/f5/otel-weaver/blob/main/docs/component-telemetry-schema.md))

**Q2: Does Datadog publish an official Weaver dependency/semantic-convention registry?**

🟢 High confidence: No. Datadog's OTel integration is documentation-based mapping tables (["OpenTelemetry Semantic Conventions and Datadog Conventions"](https://docs.datadoghq.com/opentelemetry/mapping/semantic_mapping/)) plus Agent/Collector-side inference logic (e.g. `span.type` inferred from attributes present). No Datadog-maintained repo with a Weaver `registry_manifest.yaml` and `dependencies:` block analogous to `open-telemetry/semantic-conventions-genai` was found.

**Q3: Is there an established pattern for encoding "this attribute must be an indexed metric tag in Datadog" as part of a Weaver registry?**

🟡 Medium confidence: No established pattern exists, but the underlying reason isn't that indexing is conceptually the wrong layer — it's that no tool exists to connect a Weaver-declared intent to Datadog's tag-configuration API. Even with a working annotation mechanism, Metrics without Limits tag configuration is applied per **metric name** inside Datadog, not per **attribute** — so a Weaver annotation on the attribute definition would still need a translation step (reading the Weaver registry, reading the Collector's `dimensions:` config to know which metrics carry the attribute, then calling Datadog's tag-configuration API for each) that is genuinely new scope, not a config toggle.

### Recommendation

The attribute-reliability half of this story does not need new Weaver tooling — it needs the existing COV-005 rule (`src/languages/javascript/rules/cov005.ts`) promoted from advisory (`blocking: false`) to blocking, so that "Weaver declares it required → Spiny-Orb reliably adds it" is actually guaranteed by a validation gate rather than by LLM behavior alone. See project decision discussion (PRD #980) for the two-layer boundary this unlocks: Spiny-Orb-guaranteed attribute presence vs. manually-built-but-trustworthy downstream pipeline (Collector dimensions + Datadog tag configuration).

### Caveats

- The Rego policy engine and Component Telemetry Schema annotation mechanism were not tested directly — findings are based on documentation/design-doc descriptions, not hands-on verification against the current Weaver CLI version used in this project.
- Absence of a public Datadog Weaver registry is a negative finding (nothing found) rather than a confirmed statement from Datadog that none exists — worth re-checking if Datadog's OTel tooling story changes.

## Sources

- [f5/otel-weaver component-telemetry-schema.md](https://github.com/f5/otel-weaver/blob/main/docs/component-telemetry-schema.md) — planned general annotation/tagging mechanism design
- [open-telemetry/weaver define-your-own-telemetry-schema.md](https://github.com/open-telemetry/weaver/blob/main/docs/define-your-own-telemetry-schema.md) — custom registry manifest and dependency mechanics
- [Datadog: OpenTelemetry Semantic Conventions and Datadog Conventions](https://docs.datadoghq.com/opentelemetry/mapping/semantic_mapping/) — confirms documentation-based mapping, not a Weaver registry
- [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai) — reference example of an actual Weaver dependency-registry pattern (used for comparison; no Datadog equivalent found)
