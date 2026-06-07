# Research: OTel to Datadog APM Forwarding Options

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-06

## Update Log

| Date | Summary |
|------|---------|
| 2026-06-06 | Initial research — all options for local OTel→Datadog APM forwarding, recommendation for eval run gap fix |

## Findings

### Summary

The right approach for sending eval run traces to Datadog APM (without breaking IS scoring) is adding a Datadog exporter to the existing `otelcol-config.yaml` alongside the file exporter. The eval repo already has `DD_API_KEY` in its `.vals.yaml`. Wrapping the Collector start with `vals exec` injects the key — no hardcoding, minimal change.

---

### Surprises & Gotchas

**Direct OTLP trace ingestion to Datadog is Preview-only.** The `otlp-intake.datadoghq.com` traces endpoint requires contacting a Customer Success Manager to access. Do not plan around it. (Metrics and logs endpoints are GA; traces are not.) 🔴 low confidence it will be available soon

**The Datadog connector is not required for basic trace visibility.** The exporter skips APM stats computation by default and recommends the connector for those aggregated stats — but individual traces and spans appear in Datadog APM Trace Explorer without it. For a dev/eval environment, omit the connector to keep the config minimal. 🟢 high confidence

**Datadog Agent OTLP receiver port is configurable.** `datadog.yaml` accepts a custom HTTP endpoint under `otlp_config.receiver.protocols.http.endpoint`. Setting it to a non-4318 port would eliminate the IS scoring port conflict entirely — but requires updating every target app's `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` too, making it a larger scope change than the current issue warrants. 🟢 high confidence

**Multiple exporters in one pipeline is standard OTel Collector behavior.** Listing `exporters: [file, datadog]` in the same traces pipeline is fully supported. No known conflicts documented. 🟢 high confidence

**`otelcol-contrib` is the right binary.** It includes the Datadog exporter. The core `otelcol` distribution does not. `otelcol-contrib` is already installed and used for IS scoring. No additional binary needed. 🟢 high confidence

**`vals exec` works for OTel Collector background processes.** `vals exec -f .vals.yaml -- otelcol-contrib --config config.yaml &` runs the Collector in the background with secrets injected. `vals exec` uses execve semantics (replaces itself with the child), so the `&` applies to the Collector process directly. The `DD_API_KEY` env var is available to the Collector. 🟡 medium confidence (verified pattern for similar use cases)

**DDOT (Datadog's OTel Collector distribution) is overkill here.** DDOT bundles the Datadog exporter and opinionated defaults, but requires a separate binary download. Since `otelcol-contrib` is already installed and working, DDOT adds nothing for this use case. 🟢 high confidence

---

### Options Compared

| Option | Solves eval gap | Solves port conflict | Per-repo setup | Machine change | Complexity |
|--------|----------------|---------------------|----------------|----------------|------------|
| **Dual exporters in otelcol-config.yaml** | ✅ | ❌ (Agent still stops) | No | No | Low |
| Permanent Collector daemon + disable Agent OTLP | ✅ | ✅ | No | Yes (launchd plist) | Medium |
| Change Agent OTLP port in datadog.yaml | ✅ | ✅ | Yes (update all endpoint targets) | Yes | Medium |
| Direct OTLP ingestion (otlp-intake.datadoghq.com) | ❌ (Preview) | ✅ | No | No | Low (blocked) |

---

### Recommendation

**Use dual exporters in `otelcol-config.yaml`.** The issue's stated goal is "eval run traces into Datadog APM without breaking IS scoring." This option does exactly that with two targeted changes:

1. Add `datadog` exporter to `evaluation/is/otelcol-config.yaml` (eval repo)
2. Update IS scoring command to wrap with `vals exec` to inject `DD_API_KEY`

The `DD_API_KEY` is already in the eval repo's `.vals.yaml` — no new secrets needed. The port conflict (Agent stops during IS scoring) remains unchanged, which is acceptable — the issue accepts this tradeoff.

A permanent daemon approach would be a good follow-up improvement to eliminate the per-run Agent stop/start cycle entirely, but it is a machine-level change out of scope for this issue.

---

### Minimum Config for Dual Export

```yaml
# otelcol-config.yaml addition
exporters:
  file:
    path: ./eval-traces.json
  datadog:
    api:
      key: ${env:DD_API_KEY}
      site: datadoghq.com   # default; omit if using datadoghq.com

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file, datadog]
```

`DD_API_KEY` is injected via `vals exec -f .vals.yaml`. The eval repo's `.vals.yaml` already maps `DD_API_KEY` to the GCP secret `datadog-commit-story-dev`.

---

### Updated IS Scoring Command

Replace the bare `otelcol-contrib` start command with:

```bash
vals exec -f ~/Documents/Repositories/spinybacked-orbweaver-eval/.vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && cd ~/Documents/Repositories/spinybacked-orbweaver-eval/evaluation/is && otelcol-contrib --config otelcol-config.yaml > /tmp/otelcol.log 2>&1' &
```

Or from within the eval repo directory:

```bash
vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && otelcol-contrib --config evaluation/is/otelcol-config.yaml > /tmp/otelcol.log 2>&1' &
```

Cleanup: `kill %1` or `pkill otelcol-contrib` (unchanged from current workflow).

---

### Post-Commit Hook Fix (spinybacked-orbweaver)

The hook at `.git/hooks/post-commit` in `spinybacked-orbweaver` uses the simplified form that calls `commit-story` directly without `--import examples/instrumentation.js`, so no OTel spans are emitted for commits in this repo. Replace with the `find_package_dir()` pattern from `commit-story-v2`:

```bash
#!/bin/bash
# commit-story post-commit hook
# Generates a journal entry for each commit

resolve_path() {
  if command -v realpath >/dev/null 2>&1; then realpath "$1"
  elif command -v greadlink >/dev/null 2>&1; then greadlink -f "$1"
  else cd "$1" && pwd -P; fi
}

find_package_dir() {
  local repo_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || return
  if [[ -f "$repo_root/src/index.js" ]] && grep -q '"commit-story"' "$repo_root/package.json" 2>/dev/null; then
    echo "$repo_root"; return
  fi
  local pkg_link="$repo_root/node_modules/commit-story"
  if [[ -L "$pkg_link" ]]; then resolve_path "$pkg_link"; return; fi
  if [[ -d "$pkg_link" ]]; then echo "$pkg_link"; return; fi
}

(
  PKG_DIR="$(find_package_dir)"
  if [[ -z "$PKG_DIR" || ! -f "$PKG_DIR/src/index.js" ]]; then npx commit-story; exit; fi
  NODE_ARGS=("$PKG_DIR/src/index.js")
  if [[ -f "$PKG_DIR/examples/instrumentation.js" ]]; then
    NODE_ARGS=("--import" "$PKG_DIR/examples/instrumentation.js" "${NODE_ARGS[@]}")
  fi
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  if [[ -f "$REPO_ROOT/.vals.yaml" ]] && command -v vals >/dev/null 2>&1; then
    vals exec -f "$REPO_ROOT/.vals.yaml" -- node "${NODE_ARGS[@]}"
  else
    node "${NODE_ARGS[@]}"
  fi
) &
```

---

## Sources

- [Set Up the OTel Collector with Datadog Exporter](https://docs.datadoghq.com/opentelemetry/setup/collector_exporter/install/) — official install guide; minimum config fields
- [Datadog Exporter README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/datadogexporter/README.md) — connector requirement, known gotchas (413 errors, deprecated Zorkian client)
- [OTLP Ingestion by the Datadog Agent](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/) — Agent port reconfiguration; `otlp_config.receiver.protocols.http.endpoint`
- [Datadog OTLP Intake Endpoint](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/) — direct ingestion; traces are Preview-only, not yet GA
- [Install OTel Collector on macOS](https://www.sumologic.com/help/docs/send-data/opentelemetry-collector/install-collector/macos/) — launchd daemon pattern for permanent Collector setup
- [Datadog Exporter example config](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/exporter/datadogexporter/examples/collector.yaml) — full reference YAML with connector setup
