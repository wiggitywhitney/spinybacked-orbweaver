# Research: Datadog Agent OTLP Port Configuration

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-18

## Update Log

| Date | Summary |
|------|---------|
| 2026-06-18 | Initial research — how to disable Agent OTLP HTTP receiver on port 4318; actual datadog.yaml state on this machine |

## Findings

### Summary

The Agent's OTLP HTTP receiver is explicitly enabled in `/opt/datadog-agent/etc/datadog.yaml` on port 4318. Disabling it requires removing the `http:` block from `otlp_config.receiver.protocols`. The receiver is **off by default** — only enabled because enterprise IT explicitly configured it (Jan 2024, EITOE-915). Removing the HTTP block is safe; it has no effect on trace/metric collection unless something is actively sending OTLP-HTTP to the Agent, which nothing in this setup is.

---

### Surprises & Gotchas

**The OTLP receiver is off by default — something explicitly turned it on.** The `otlp_config` section in the file was added intentionally by enterprise IT in Jan 2024. The HTTP block may not be required by any current workflow.

**Source says:** "The OTLP receiver only activates when an endpoint is explicitly configured." ([OTLP Ingestion by the Datadog Agent](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/))
**Interpretation:** Omitting the `http:` block entirely frees port 4318 — no other flag or disable key needed.

**Disabling HTTP leaves gRPC (4317) intact.** The current config has both HTTP (4318) and gRPC (4317). Removing only the `http:` block leaves gRPC untouched. This is the minimum safe change.

**`traces.enabled`, `metrics.enabled`, and `logs.enabled` are about what the OTLP receiver does with ingested data — not whether it listens.** These flags don't control which protocols are bound. Removing the `http:` block under `protocols:` is what stops port 4318 from being opened.

**No restart shortcut.** Agent must be fully restarted (not just reloaded) for OTLP port changes to take effect: `datadog-agent restart`.

---

### Current State (verified on this machine)

File: `/opt/datadog-agent/etc/datadog.yaml`, line 98:

```yaml
# OTLP Configuration for OpenTelemetry ingestion
otlp_config:
  receiver:
    protocols:
      http:
        endpoint: 0.0.0.0:4318    # opens port 4318
      grpc:
        endpoint: 0.0.0.0:4317
  traces:
    enabled: true
  metrics:
    enabled: true
  logs:
    enabled: true
```

### Target State (to free port 4318)

Remove only the `http:` block:

```yaml
# OTLP Configuration for OpenTelemetry ingestion
otlp_config:
  receiver:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
  traces:
    enabled: true
  metrics:
    enabled: true
  logs:
    enabled: true
```

### Safety Assessment

🟢 high confidence — safe to remove.

**Source says:** "Disabling HTTP is safe if your instrumented applications use gRPC instead. Your application must have `OTEL_EXPORTER_OTLP_ENDPOINT` pointing to whichever protocol remains active. Without a matching receiver, your application does not send telemetry data to the Agent." ([OTLP Ingestion by the Datadog Agent](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/))

In this setup, `otelcol-contrib` owns OTLP collection and forwards to Datadog via the Datadog exporter. Nothing sends directly to the Agent's OTLP port, so disabling it has zero impact on traces or metrics.

### Verification Steps

After restarting the Agent:

```bash
lsof -i :4318   # should return empty — no process on this port
datadog-agent status | grep -i otlp   # should show no HTTP receiver
```

### Caveats

- The Agent config is enterprise IT managed. Edit only the `http:` block — don't restructure the file.
- If a future tool sends OTLP-HTTP directly to the Agent, it would need to switch to gRPC (4317) or use `otelcol-contrib` instead.
- Do not set `enabled: false` on the whole `otlp_config` — that key may not exist, and the minimum edit is safer.

---

## Sources

- [OTLP Ingestion by the Datadog Agent](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest_in_the_agent/) — official docs; confirms OTLP is off by default, HTTP disabled by omitting `http:` block
- [OTLP Receiver config reference](https://docs.datadoghq.com/opentelemetry/config/otlp_receiver/) — OTel Collector receiver format used by the Agent
- Prior research: `docs/research/otel-to-datadog-forwarding.md` — confirms `otlp_config.receiver.protocols.http.endpoint` is the key; 🟢 high confidence
