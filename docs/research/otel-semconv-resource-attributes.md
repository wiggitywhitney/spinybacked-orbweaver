# Research: OTel Semantic Conventions for Resource Attributes

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-17

## Update Log
| Date | Summary |
|------|---------|
| 2026-06-17 | Initial research — stability status of service/host/deployment attributes, Datadog tag mapping, service.namespace gap, host.* Development status |

## Findings

### Summary

The three OTel resource attributes needed for Datadog Unified Service Tagging (and metrics-to-logs correlation) are all **Stable** in the OTel semconv spec: `service.name` (→ `service`), `service.version` (→ `version`), and `deployment.environment.name` (→ `env`). All `host.*` attributes are **Development** status and used only for Datadog hostname resolution — not as metric tags. Two Required OTel attributes (`service.namespace`, `service.instance.id`) have no Datadog tag mapping at all.

---

### Surprises & Gotchas

🔴 **`service.namespace` and `service.instance.id` are "Required" in the OTel spec but have NO Datadog tag mapping.** The OTel spec marks these attributes as Required (for defining service uniqueness), but neither maps to a Datadog reserved tag or appears as a metric dimension. Developers who see them as "Required" may assume Datadog surfaces them — it does not without `resource_attributes_as_tags: true`.

**Source says:** The Datadog Unified Service Tagging page maps only `service.name`, `service.version`, and `deployment.environment.name`/`deployment.environment` — `service.namespace` and `service.instance.id` are not mentioned. ([Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/))

🔴 **ALL `host.*` resource attributes are Development (not Stable) status in OTel semconv.** Including `host.name` and `host.id`. Despite being Development-status, Datadog uses them for hostname resolution (infrastructure list, host map) as a fallback. They are never converted to metric tags.

**Source says:** "Both entity groups (`host` and `host.cpu`) carry **Development** status." ([OTel Resource Host Semconv](https://opentelemetry.io/docs/specs/semconv/resource/host/))

🟠 **`deployment.environment.name` is Stable in the OTel spec but requires specific minimum Datadog versions.** The spec page shows the Stable badge. However, the Datadog Exporter and Agent require v0.110.0+ and 7.58.0+ respectively to recognize this attribute.

**Source says:** "`deployment.environment.name` replaces the deprecated `deployment.environment` and requires Agent 7.58.0+ and Datadog Exporter v0.110.0+." ([Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/))

🟡 **`host.id` takes priority over `host.name` in Datadog hostname resolution** — not the other way around. Both are Development-status, but `host.id` (cloud instance ID or machine-id) is checked first in the fallback path.

**Source says:** Hostname priority: fall back to `host.id` first, then `host.name` ([Mapping OTel to Hostnames](https://docs.datadoghq.com/opentelemetry/mapping/hostname/))

---

### Stability Status Table

🟢 high confidence

| OTel Resource Attribute | OTel Semconv Status | Datadog Tag | Notes |
|---|---|---|---|
| `service.name` | **Stable**, Required | `service` | Core UST tag |
| `service.version` | **Stable**, Recommended | `version` | Core UST tag |
| `service.namespace` | **Stable**, Required | *(none)* | No Datadog mapping |
| `service.instance.id` | **Stable**, Required | *(none)* | No Datadog mapping |
| `deployment.environment.name` | **Stable**, Recommended | `env` | Requires Agent 7.58+, Exporter v0.110+ |
| `deployment.environment` | **Deprecated** (v1.27.0) | `env` | Backward compat; still works |
| `host.name` | **Development**, Recommended | hostname (infra) | Not a metric tag |
| `host.id` | **Development**, Recommended | hostname (infra) | Not a metric tag; priority over host.name |

**Source says (service attributes):** "Logical name of the service" (`service.name`, Stable, Required); "A namespace for `service.name`" (`service.namespace`, Stable, Required); "The string ID of the service instance" (`service.instance.id`, Stable, Required); version is Recommended. ([OTel Service Resource Semconv](https://opentelemetry.io/docs/specs/semconv/resource/service/))

**Source says (deployment.environment.name):** Stability badge shows **Stable**. Well-known values: `development`, `production`, `staging`, `test`. ([OTel Deployment-Environment Semconv](https://opentelemetry.io/docs/specs/semconv/resource/deployment-environment/))

**Source says (host):** "Both entity groups (`host` and `host.cpu`) carry Development status." ([OTel Resource Host Semconv](https://opentelemetry.io/docs/specs/semconv/resource/host/))

---

### Deprecated Attribute Compatibility

🟢 high confidence

Datadog maps BOTH `deployment.environment` and `deployment.environment.name` to the `env` tag. The OTel spec deprecated `deployment.environment` in v1.27.0. Datadog retains support for the old attribute as a backward-compatibility fallback.

**Source says:** The Datadog UST mapping table explicitly lists both attributes, with a footnote on `deployment.environment.name` requiring newer tooling versions. ([Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/))

---

### `datadog.host.name` — Vendor-Specific Attribute

🟢 high confidence

`datadog.host.name` is a Datadog-specific (non-OTel-semconv) resource attribute that overrides hostname resolution at the highest priority. Recommended when cross-product consistency (APM + infra + logs) matters.

**Source says:** "Prefer using the `datadog.host.name` convention since it is namespaced and less likely to conflict with other vendor-specific behavior." ([Hostname and Tagging](https://docs.datadoghq.com/opentelemetry/config/hostname_tagging/))

---

### Recommendation

For the observability triangle demo using pure OTel path:

1. Set only the three UST resource attributes: `service.name`, `service.version`, `deployment.environment.name`
2. Do NOT add `service.namespace` or `service.instance.id` expecting them to appear as Datadog correlation tags — they won't without `resource_attributes_as_tags: true`
3. Do NOT rely on `host.name` for application-level metrics-to-logs correlation — it's infrastructure metadata, not a metrics-to-logs correlation tag

---

### Caveats

- `deployment.environment.name` is Stable in the OTel spec but its JS constant lives in `@opentelemetry/semantic-conventions/incubating` due to library promotion lag — define it locally: `const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name'`
- For environments running older Datadog infrastructure (Agent < 7.58.0 or Exporter < v0.110.0), use `deployment.environment` (deprecated) instead of `deployment.environment.name`
- `service.namespace` uniqueness scoping is OTel-internal — it has no effect on how Datadog groups or routes metrics/logs

## Sources

- [OTel Resource Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/resource/) — resource attribute group stability overview
- [OTel Service Resource Semconv](https://opentelemetry.io/docs/specs/semconv/resource/service/) — service.* attribute stability and requirement levels
- [OTel Deployment-Environment Semconv](https://opentelemetry.io/docs/specs/semconv/resource/deployment-environment/) — deployment.environment.name Stable status, well-known values
- [OTel Host Resource Semconv](https://opentelemetry.io/docs/specs/semconv/resource/host/) — all host.* attributes are Development status
- [Datadog Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/) — OTel→Datadog tag mapping; service.namespace/instance.id absent
- [Datadog Semantic Mapping](https://docs.datadoghq.com/opentelemetry/mapping/semantic_mapping/) — resource_attributes_as_tags option
- [Datadog Hostname Mapping](https://docs.datadoghq.com/opentelemetry/mapping/hostname/) — hostname resolution priority, host.id before host.name
