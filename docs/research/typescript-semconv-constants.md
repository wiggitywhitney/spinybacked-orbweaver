# Research: OTel JS Semantic Conventions — Stable Constants for TypeScript Instrumentation

<!-- Metadata header — required by PRD #372 Milestone C0 -->
**Retrieval date:** 2026-04-11  
**Package version documented:** `@opentelemetry/semantic-conventions` v1.40.0  
**Sources:**
- [README (main branch)](https://raw.githubusercontent.com/open-telemetry/opentelemetry-js/main/semantic-conventions/README.md)
- [CHANGELOG (main branch)](https://raw.githubusercontent.com/open-telemetry/opentelemetry-js/main/semantic-conventions/CHANGELOG.md)
- [stable_attributes.d.ts (v1.40.0 via unpkg)](https://unpkg.com/@opentelemetry/semantic-conventions@1.40.0/build/src/stable_attributes.d.ts)
- [experimental_attributes.ts (GitHub API)](https://github.com/open-telemetry/opentelemetry-js/blob/main/semantic-conventions/src/experimental_attributes.ts)
- [trace/SemanticAttributes.ts (deprecated exports)](https://github.com/open-telemetry/opentelemetry-js/blob/main/semantic-conventions/src/trace/SemanticAttributes.ts)

---

## Five Questions Answered

### Q1: Current stable version and naming prefix?

**Current version: v1.40.0**

The naming prefix is `ATTR_` for attributes, `METRIC_` for metrics, `EVENT_` for events. Enum values follow the pattern `${ATTR_NAME}_VALUE_${enumValue}` (e.g., `HTTP_REQUEST_METHOD_VALUE_GET`).

The old `SEMATTRS_*` prefix (e.g., `SEMATTRS_HTTP_METHOD`) is **fully deprecated** — every export in `src/trace/SemanticAttributes.ts` carries a JSDoc `@deprecated` tag. Do not use `SEMATTRS_*` in new code.

### Q2: Has there been any further migration since v1.26.0?

Yes. The `ATTR_*` naming is stable but the **attribute names themselves** have continued evolving:

- **DB attributes:** `db.system` → `db.system.name`, `db.statement` → `db.query.text` (renamed for cleaner semantics)
- **URL attributes:** `http.url` and `http.target` are now deprecated in favor of `url.full`, `url.path`, `url.query`
- **CHANGELOG v1.33.1 warning:** `DB_SYSTEM_NAME_VALUE_*` was moved back to incubating in a minor release — proof that incubating exports can change without warning even within a minor bump

The naming convention itself (`ATTR_` prefix) is fully stable. The attribute strings and their stable/incubating classification continue to evolve.

### Q3: Import pattern for stable vs. incubating?

**Two separate entry-points:**

```typescript
// Stable — semver-safe. Use in published libraries.
import { ATTR_HTTP_REQUEST_METHOD } from '@opentelemetry/semantic-conventions';

// Incubating — NO semver guarantee. Breaking changes can appear in minor releases.
import { ATTR_RPC_METHOD } from '@opentelemetry/semantic-conventions/incubating';
```

The incubating entry-point re-exports everything from the stable entry-point plus all experimental exports. **Never mix the two in the same import statement** — always import stable constants from the root entry-point and incubating constants from `/incubating`.

For Lambda or bundle-size-sensitive environments: copy the specific incubating constants you need into a local `src/semconv.ts` file to avoid shipping the full incubating bundle.

### Q4: Which attributes are stable vs. incubating?

#### HTTP attributes

| Attribute | Constant | Status | Notes |
|-----------|----------|--------|-------|
| `http.request.method` | `ATTR_HTTP_REQUEST_METHOD` | **STABLE** | Replaces deprecated `SEMATTRS_HTTP_METHOD` (`http.method`) |
| `http.response.status_code` | `ATTR_HTTP_RESPONSE_STATUS_CODE` | **STABLE** | Replaces deprecated `SEMATTRS_HTTP_STATUS_CODE` (`http.status_code`) |
| `http.route` | `ATTR_HTTP_ROUTE` | **STABLE** | |
| `url.full` | `ATTR_URL_FULL` | **STABLE** | Replaces deprecated `ATTR_HTTP_URL` (`http.url`) |
| `url.path` | `ATTR_URL_PATH` | **STABLE** | Replaces deprecated `ATTR_HTTP_TARGET` part |
| `url.query` | `ATTR_URL_QUERY` | **STABLE** | Replaces deprecated `ATTR_HTTP_TARGET` part |
| `url.scheme` | `ATTR_URL_SCHEME` | **STABLE** | |
| `http.url` | `ATTR_HTTP_URL` | INCUBATING + **@deprecated** | Use `url.full` instead |
| `http.target` | `ATTR_HTTP_TARGET` | INCUBATING + **@deprecated** | Use `url.path` + `url.query` |
| HTTP method enum | `HTTP_REQUEST_METHOD_VALUE_GET` etc. | **STABLE** | |

#### DB attributes

| Attribute | Constant | Status | Notes |
|-----------|----------|--------|-------|
| `db.system.name` | `ATTR_DB_SYSTEM_NAME` | **STABLE** | **Use this, not `db.system`** |
| `db.query.text` | `ATTR_DB_QUERY_TEXT` | **STABLE** | Replaces deprecated `db.statement` |
| `db.query.summary` | `ATTR_DB_QUERY_SUMMARY` | **STABLE** | |
| DB system enum | `DB_SYSTEM_NAME_VALUE_MYSQL` etc. | **STABLE** | |
| `db.system` | `ATTR_DB_SYSTEM` | INCUBATING + **@deprecated** | Use `db.system.name` instead |
| `db.statement` | `ATTR_DB_STATEMENT` | INCUBATING + **@deprecated** | Use `db.query.text` instead |
| `db.name` | `ATTR_DB_NAME` | INCUBATING + **@deprecated** | |
| `db.operation` | `ATTR_DB_OPERATION` | INCUBATING + **@deprecated** | |

#### RPC attributes — all incubating

| Attribute | Constant | Status |
|-----------|----------|--------|
| `rpc.method` | `ATTR_RPC_METHOD` | INCUBATING |
| `rpc.service` | `ATTR_RPC_SERVICE` | INCUBATING |
| `rpc.system` | `ATTR_RPC_SYSTEM` | INCUBATING |
| `rpc.grpc.status_code` | `ATTR_RPC_GRPC_STATUS_CODE` | INCUBATING |

#### Messaging attributes — all incubating

| Attribute | Constant | Status |
|-----------|----------|--------|
| `messaging.system` | `ATTR_MESSAGING_SYSTEM` | INCUBATING |
| `messaging.operation.name` | `ATTR_MESSAGING_OPERATION_NAME` | INCUBATING |
| `messaging.operation.type` | `ATTR_MESSAGING_OPERATION_TYPE` | INCUBATING |
| `messaging.destination.name` | `ATTR_MESSAGING_DESTINATION_NAME` | INCUBATING |

#### Service attributes — all stable

| Attribute | Constant | Status |
|-----------|----------|--------|
| `service.name` | `ATTR_SERVICE_NAME` | **STABLE** |
| `service.version` | `ATTR_SERVICE_VERSION` | **STABLE** |
| `service.namespace` | `ATTR_SERVICE_NAMESPACE` | **STABLE** |
| `service.instance.id` | `ATTR_SERVICE_INSTANCE_ID` | **STABLE** |

### Q5: Official OTel JS idiomatic import pattern (2025/2026)?

```typescript
// Stable attributes — import from root entry-point
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_FULL,
  ATTR_HTTP_ROUTE,
  ATTR_DB_SYSTEM_NAME,
  ATTR_DB_QUERY_TEXT,
  ATTR_SERVICE_NAME,
  HTTP_REQUEST_METHOD_VALUE_GET,
  DB_SYSTEM_NAME_VALUE_POSTGRESQL,
} from '@opentelemetry/semantic-conventions';

// Incubating attributes — import from /incubating entry-point
import {
  ATTR_RPC_METHOD,
  ATTR_RPC_SERVICE,
  ATTR_RPC_SYSTEM,
  ATTR_MESSAGING_SYSTEM,
  ATTR_MESSAGING_OPERATION_NAME,
} from '@opentelemetry/semantic-conventions/incubating';
```

---

## Recommended Usage Pattern for Spiny-Orb

When the TypeScript provider's prompt instructs the LLM to add semconv attributes:

1. **Prefer stable attributes.** Use `ATTR_HTTP_REQUEST_METHOD`, `ATTR_HTTP_RESPONSE_STATUS_CODE`, `ATTR_URL_FULL`, `ATTR_DB_SYSTEM_NAME`, `ATTR_DB_QUERY_TEXT` — these are in the root entry-point and semver-safe.

2. **For RPC and messaging:** use the `/incubating` entry-point with a comment noting that incubating attributes may change in minor releases.

3. **Import grouping:** put stable and incubating imports in separate import statements with a comment on the incubating block.

4. **Naming guidance for the LLM prompt:** the prompt must instruct the LLM to use `ATTR_*` prefix, not `SEMATTRS_*`. Example phrasing: "Use `ATTR_HTTP_REQUEST_METHOD` from `@opentelemetry/semantic-conventions`, not the deprecated `SEMATTRS_HTTP_METHOD`."

5. **checker rule `cov005`** (registry-defined attributes): when checking whether the LLM used the right attribute key strings, check against the stable names (`db.system.name` not `db.system`, `db.query.text` not `db.statement`, `url.full` not `http.url`).

---

## Gotchas

### G1: DB attributes have new names — training data gets this wrong

`db.system` and `db.statement` are deprecated. The LLM's training data likely suggests these old names. The correct stable names are:
- `db.system.name` (constant: `ATTR_DB_SYSTEM_NAME`)
- `db.query.text` (constant: `ATTR_DB_QUERY_TEXT`)

The prompt MUST explicitly say "do not use `db.system` or `db.statement` — use `db.system.name` and `db.query.text`."

### G2: HTTP URL is now `url.full`, not `http.url`

`http.url` is deprecated and incubating. The stable replacement is `url.full` (constant: `ATTR_URL_FULL`). Similarly, `http.target` is replaced by `url.path` + `url.query`.

### G3: Incubating has NO semver safety

`@opentelemetry/semantic-conventions/incubating` can have breaking changes in any minor release. CHANGELOG v1.33.1 shows `DB_SYSTEM_NAME_VALUE_*` being moved, which broke existing incubating imports. Any code using the `/incubating` entry-point should pin the package or be prepared to update on minor bumps.

### G4: `SEMATTRS_*` still compiles but is wrong

`SEMATTRS_HTTP_METHOD`, `SEMATTRS_HTTP_STATUS_CODE`, etc. are still exported and still compile — they're just deprecated. The LLM will often use these because they appear in training data. The prompt must explicitly prohibit them. Also: these use old attribute strings (`http.method`, `http.status_code`) that differ from current OTel convention (`http.request.method`, `http.response.status_code`).

### G5: Two entry-points must NOT be mixed in one import

```typescript
// WRONG — mixes stable and incubating in one import
import { ATTR_HTTP_REQUEST_METHOD, ATTR_RPC_METHOD } from '@opentelemetry/semantic-conventions/incubating';

// CORRECT — separate imports
import { ATTR_HTTP_REQUEST_METHOD } from '@opentelemetry/semantic-conventions';
import { ATTR_RPC_METHOD } from '@opentelemetry/semantic-conventions/incubating';
```

Importing stable constants from `/incubating` works (it re-exports them) but is wrong style and signals incorrect understanding of the API surface.

### G6: `db.system` vs `db.system.name` coexist in the package simultaneously

`ATTR_DB_SYSTEM` (incubating, deprecated) and `ATTR_DB_SYSTEM_NAME` (stable) both exist. The old one has the string `'db.system'`, the new one has `'db.system.name'`. An LLM asked to use "db system" may pick either. The prompt must be specific: "use `ATTR_DB_SYSTEM_NAME` from the stable entry-point."
