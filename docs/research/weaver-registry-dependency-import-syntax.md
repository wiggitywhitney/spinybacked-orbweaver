# Research: Weaver Registry Dependency Import Syntax

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-04-29

## Update Log
| Date | Summary |
|------|---------|
| 2026-04-29 | Initial research — OD-1 for PRD #581 M2 |

## Findings

### Answer to the core question
**Does adding `dependencies:` + wildcard `imports:` cause `weaver registry resolve` to include those attributes?**

**No.** The `imports: attribute_groups: [wildcard]` syntax is schema-invalid in weaver 0.21.2 and fails immediately. The three viable mechanisms are all unworkable for a general "add OTel semconv" offer:

| Mechanism | Status | Problem |
|-----------|--------|---------|
| `imports: attribute_groups: [http.*]` | ❌ schema-invalid | weaver 0.21.2 rejects `attribute_groups` under `imports:` |
| `extends: <group-id>` | ✅ works but limited | Requires enumerating exact OTel group IDs; no wildcard |
| `--include-unreferenced` flag | ✅ works but impractical | 4.9MB JSON payload from full OTel semconv — overflows LLM context |

🟢 **Conclusion**: Hard block only — no offer to auto-add. The auto-add mechanism is not viable in weaver 0.21.2.

### Dependency declaration syntax (weaver 0.21.2)

Add to `registry_manifest.yaml`:
```yaml
dependencies:
  - name: otel
    registry_path: https://github.com/open-telemetry/semantic-conventions@v1.29.0[model]
```

- Only **one dependency** is supported in weaver 0.21.2 (limitation documented in GH issue #604)
- Old `semconv_version` + `schema_base_url` format is deprecated but still accepted (emits warning)

### `extends:` approach (limited but functional)

Adding a local group that `extends:` an OTel group ID pulls in that group's attributes:
```yaml
groups:
  - id: otel.imported.client
    type: attribute_group
    brief: Client attributes from OTel semconv
    extends: client
    attributes: []
```

This **does** make `client.address` etc. appear in `weaver registry resolve` output (without `--include-unreferenced`). But it requires knowing exact OTel group IDs and is not a viable wildcard/bulk import.

### `--include-unreferenced` flag

Confirmed present in weaver 0.21.2 help output:
> "Boolean flag to include signals and attributes defined in dependency registries, even if they are not explicitly referenced in the current (custom) registry"

Works, but produces a **4.9MB JSON payload** from OTel semconv v1.29.0 — the full semconv is hundreds of attribute groups. Completely unsuitable for LLM agent context.

### spiny-orb's current `resolveSchema` call

`src/coordinator/dispatch.ts:175`:
```typescript
execFile('weaver', ['registry', 'resolve', '-r', fullSchemaPath, '--format', 'json'], ...
```

Does NOT pass `--include-unreferenced`. Any dependency attributes require explicit `imports:` or `extends:` references to appear in spiny-orb's resolved schema.

## Sources
- Weaver 0.21.2 local binary (`weaver registry resolve --help`)
- Live test with `/tmp/weaver-test-registry/` — confirmed `imports: attribute_groups:` schema error
- Live test with `extends: client` — confirmed attribute resolution works
- Live test with `--include-unreferenced` — confirmed 4.9MB JSON output
- Research agent citing `crates/weaver_resolver/data/multi-registry/` and `docs/define-your-own-telemetry-schema.md` from open-telemetry/weaver GitHub
