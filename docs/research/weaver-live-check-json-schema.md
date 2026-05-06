# Research B: Weaver Live-Check JSON Schema

**Project:** spinybacked-orbweaver PRD #698
**Last Updated:** 2026-05-05
**Weaver version:** 0.21.2
**Command:** `weaver registry live-check --format json`

---

## TL;DR

`--format json` is the correct flag (not `--diagnostic-format`). The JSON output has two top-level keys: `samples` (array of per-entity compliance results) and `statistics` (aggregate counts). Zero spans received = `samples` is empty + `statistics.total_entities === 0`. Real spans = `samples` non-empty.

---

## The `--format` Flag

```bash
weaver registry live-check -r <registry> --format json [other flags]
```

The flag accepts: `json`, `yaml`, `jsonl` (serde-based serialization) or a template name (e.g., `ansi` is the default). There is no `--format=json` shorthand — must be `--format json` (space-separated).

`--diagnostic-format` is a DIFFERENT flag that controls startup diagnostic output (loading messages), not the compliance report output.

---

## Zero-Spans Output (nothing received)

Captured by starting Weaver, letting the inactivity timeout fire with no spans sent:

```json
{
  "samples": [],
  "statistics": {
    "total_entities": 0,
    "total_entities_by_type": {},
    "total_advisories": 0,
    "advice_level_counts": {},
    "highest_advice_level_counts": {},
    "no_advice_count": 0,
    "advice_type_counts": {},
    "advice_message_counts": {},
    "seen_registry_attributes": {
      "test_app.order.total": 0,
      "test_app.order.id": 0
    },
    "seen_non_registry_attributes": {},
    "seen_registry_metrics": {},
    "seen_non_registry_metrics": {},
    "seen_registry_events": {},
    "seen_non_registry_events": {},
    "registry_coverage": 0.0
  }
}
```

**Detection:** `samples.length === 0` OR `statistics.total_entities === 0`.

Note: `seen_registry_attributes` shows the registry attribute names with zero counts — these are the attributes defined in the registry that were NOT seen in any span.

---

## Real-Spans Output (spans received with advisories)

Captured with two spans sent via gRPC OTLP. Full abbreviated structure:

```json
{
  "samples": [
    {
      "resource": {
        "attributes": [
          {
            "name": "service.name",
            "value": "taze-research",
            "type": "string",
            "live_check_result": {
              "all_advice": [
                {
                  "type": "PolicyFinding",
                  "id": "missing_attribute",
                  "context": { "attribute_name": "service.name" },
                  "message": "Attribute 'service.name' does not exist in the registry.",
                  "level": "violation",
                  "signal_type": "resource",
                  "signal_name": null
                }
              ],
              "highest_advice_level": "violation"
            }
          }
        ],
        "live_check_result": {
          "all_advice": [],
          "highest_advice_level": null
        }
      }
    },
    {
      "span": {
        "name": "taze.research.operation",
        "kind": "internal",
        "status": { "code": "unset", "message": "" },
        "attributes": [
          {
            "name": "test_app.order.id",
            "value": "order-001",
            "type": "string",
            "live_check_result": {
              "all_advice": [
                {
                  "type": "PolicyFinding",
                  "id": "not_stable",
                  "context": {
                    "attribute_name": "test_app.order.id",
                    "stability": "development"
                  },
                  "message": "Attribute 'test_app.order.id' is not stable; stability = development.",
                  "level": "improvement",
                  "signal_type": "span",
                  "signal_name": "taze.research.operation"
                }
              ],
              "highest_advice_level": "improvement"
            }
          }
        ],
        "span_events": [],
        "span_links": [],
        "live_check_result": {
          "all_advice": [],
          "highest_advice_level": null
        }
      }
    }
  ],
  "statistics": {
    "total_entities": 35,
    "total_entities_by_type": {
      "span": 2,
      "attribute": 31,
      "resource": 2
    },
    "total_advisories": 31,
    "advice_level_counts": {
      "improvement": 2,
      "violation": 29
    },
    "highest_advice_level_counts": {
      "improvement": 2,
      "violation": 29
    },
    "no_advice_count": 4,
    "advice_type_counts": {
      "not_stable": 2,
      "missing_attribute": 29
    },
    "advice_message_counts": {
      "Attribute 'service.name' does not exist in the registry.": 2
    },
    "seen_registry_attributes": {
      "test_app.order.total": 1,
      "test_app.order.id": 1
    },
    "seen_non_registry_attributes": {
      "service.name": 2,
      "host.name": 2
    },
    "seen_registry_metrics": {},
    "seen_non_registry_metrics": {},
    "seen_registry_events": {},
    "seen_non_registry_events": {},
    "registry_coverage": 1.0
  }
}
```

---

## Schema Field Reference

### Top level

| Field | Type | Description |
|---|---|---|
| `samples` | `Sample[]` | One entry per resource or span entity received |
| `statistics` | `Statistics` | Aggregate counts across all received telemetry |

### `Sample` — each entry is ONE OF:

- `{ "resource": ResourceSample }` — a resource block (appears once per batch/trace)
- `{ "span": SpanSample }` — an individual span

### `ResourceSample`

| Field | Type | Description |
|---|---|---|
| `attributes` | `AttributeSample[]` | Per-attribute compliance results |
| `live_check_result` | `LiveCheckResult` | Resource-level aggregate (usually empty) |

### `SpanSample`

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Span name |
| `kind` | `string` | `"internal"`, `"client"`, `"server"`, etc. |
| `status` | `{ code: string, message: string }` | Span status |
| `attributes` | `AttributeSample[]` | Per-attribute compliance results |
| `span_events` | `SpanEventSample[]` | Span events (usually empty) |
| `span_links` | `SpanLinkSample[]` | Span links (usually empty) |
| `live_check_result` | `LiveCheckResult` | Span-level aggregate (usually empty) |

### `AttributeSample`

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Attribute name |
| `value` | `string \| number \| boolean \| string[]` | Attribute value |
| `type` | `string` | `"string"`, `"int"`, `"double"`, `"bool"`, `"string[]"` |
| `live_check_result` | `LiveCheckResult` | Compliance findings for this attribute |

### `LiveCheckResult`

| Field | Type | Description |
|---|---|---|
| `all_advice` | `Advice[]` | All policy findings for this entity |
| `highest_advice_level` | `string \| null` | `"violation"`, `"improvement"`, `"information"`, or `null` if clean |

### `Advice`

| Field | Type | Description |
|---|---|---|
| `type` | `string` | Always `"PolicyFinding"` in observed output |
| `id` | `string` | Finding type: `"missing_attribute"`, `"not_stable"` |
| `context` | `object` | Finding-specific context (e.g., `{ attribute_name, stability }`) |
| `message` | `string` | Human-readable description |
| `level` | `string` | `"violation"`, `"improvement"`, `"information"` |
| `signal_type` | `string` | `"resource"`, `"span"` |
| `signal_name` | `string \| null` | Span name for span-level findings; null for resource |

### `Statistics`

| Field | Type | Description |
|---|---|---|
| `total_entities` | `number` | Total resources + spans + attributes received |
| `total_entities_by_type` | `Record<string, number>` | Counts by type: `span`, `attribute`, `resource` |
| `total_advisories` | `number` | Total policy findings across all entities |
| `advice_level_counts` | `Record<string, number>` | Counts by level: `violation`, `improvement`, `information` |
| `highest_advice_level_counts` | `Record<string, number>` | Counts of entities at each highest level |
| `no_advice_count` | `number` | Entities with no findings (fully compliant) |
| `advice_type_counts` | `Record<string, number>` | Counts by finding id: `missing_attribute`, `not_stable` |
| `advice_message_counts` | `Record<string, number>` | Counts per unique message string |
| `seen_registry_attributes` | `Record<string, number>` | Registry-defined attrs with observation count |
| `seen_non_registry_attributes` | `Record<string, number>` | Attrs not in registry with observation count |
| `seen_registry_metrics` | `Record<string, number>` | (empty in trace-only runs) |
| `seen_non_registry_metrics` | `Record<string, number>` | (empty in trace-only runs) |
| `seen_registry_events` | `Record<string, number>` | (empty in observed runs) |
| `seen_non_registry_events` | `Record<string, number>` | (empty in observed runs) |
| `registry_coverage` | `number` | Fraction of registry attrs seen: 0.0–1.0 |

---

## Distinguishing "Zero Spans" vs "Real Spans"

| Condition | `samples.length` | `statistics.total_entities` | `statistics.registry_coverage` |
|---|---|---|---|
| Zero spans received | `0` | `0` | `0.0` |
| Real spans, some registry attrs seen | `> 0` | `> 0` | `> 0.0` |
| Real spans, all registry attrs seen | `> 0` | `> 0` | `1.0` |

**Recommended detection field:** `statistics.total_entities === 0` is the clearest signal for "nothing received." `samples.length === 0` is equivalent but requires parsing the full samples array. Use `statistics.total_entities` for the summary status check.

---

## `registry_coverage: 1.0` Does NOT Mean Compliance

When all registry attributes were seen in at least one span, `registry_coverage` is `1.0`. But the attributes can still have advisories (e.g., `not_stable`). Do not use `registry_coverage === 1.0` as a compliance signal.

**True compliance check:** `statistics.total_advisories === 0` means no policy findings. In practice, resource attributes auto-added by the SDK (`service.name`, `host.name`, etc.) will almost always have `missing_attribute` findings against a project-specific registry (because the project registry doesn't define standard semconv attrs). Parse `statistics.advice_type_counts` to distinguish registry-coverage violations from schema violations in the project's own attributes.

---

## `/stop` Endpoint and Compliance Report Location

**Weaver 0.21.x (researched here):** POST `/stop` returned the full JSON compliance report as the HTTP response body. `stopResponse.text()` contained the JSON string.

**Weaver 0.22.x (shipped behavior):** POST `/stop` returns `"OK"` as an acknowledgment only. The compliance report is streamed to **stdout** as individual entity JSON objects, with the statistics object written last. The implementation reads from `weaverStdout` (after waiting for the process to fully exit) and falls back to the HTTP response body only for backward compatibility with older Weaver versions.

See the Decision Log in `prds/done/698-live-check-validates-something.md` ("Weaver 0.22.1 changed live-check output format") and `src/coordinator/live-check.ts` for the current parsing logic (`parseComplianceReport`).
