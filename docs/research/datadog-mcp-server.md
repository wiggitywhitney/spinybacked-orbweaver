# Research: Datadog MCP Server for Claude Code

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-06

## Update Log

| Date | Summary |
|------|---------|
| 2026-06-05 | Initial research — installation, auth, APM tools, secrets injection |
| 2026-06-06 | Added live verification section (commit-story spans in APM); fixed "two APM tools" to three; clarified env block bug status |

## Findings

### Summary

The Datadog MCP server provides Claude Code with tools to query APM traces, logs, metrics, monitors, and dashboards from Datadog. The recommended path for Claude Code is the official `datadog@claude-plugins-official` plugin, which uses OAuth browser auth and requires no API key configuration. For key-based auth, `vals exec` **cannot** wrap an MCP server subprocess — the only viable injection paths are env vars in `~/.zshrc` or the plugin's built-in key-based env var support.

---

### Surprises & Gotchas

🟡 **`vals exec` cannot wrap MCP server subprocesses.** MCP servers are long-running processes spawned by Claude Code itself at session start — not launched by a user command. `vals exec` wraps a command and exits, so it has no way to inject env vars into a process Claude Code will later spawn. There is no `vals exec`-native solution here.

🟡 **The `env` block in `settings.json` has a known bug where it is silently ignored** and env vars are not passed to spawned MCP server subprocesses. The Claude Code issue was closed as a duplicate of another open issue; fix status unknown as of June 2026. The workaround is to set the vars in `~/.zshrc` so they're inherited from the parent shell.

🟢 **OAuth (the default) sidesteps the API key problem entirely.** The OAuth flow is browser-based; no credentials touch the AI provider. For a user already authenticated with Datadog in their browser, this is zero-config.

🟡 **Multiple `/reload-plugins` calls required** — reload after installation _and_ again after `/ddsetup` completes.

🟡 **The dedicated `apm` toolset is in Preview** and requires sign-up to access. The `core` toolset already includes three APM tools (`get_datadog_trace`, `search_datadog_spans`, `search_datadog_service_dependencies`) that don't require Preview access.

🔴 **Multi-org warning.** If you use multiple Datadog organizations under one account, you must be careful during OAuth not to select the wrong organization. There is no post-auth org-switch without re-running `/ddsetup`.

🟡 **Remove any existing Datadog MCP server entries** from `.mcp.json` or `settings.json` before installing the plugin to avoid conflicts.

---

### Installation (Official Plugin — Recommended)

```text
/plugin install datadog@claude-plugins-official
```

Requires Claude Code v2.1.30+. After install:
1. `/reload-plugins`
2. `/ddsetup` — select your Datadog region (US1, US3, US5, EU), complete OAuth
3. `/reload-plugins` again
4. `/ddtoolsets` — enable or disable product groups

**Source:** [github.com/datadog-labs/claude-code-plugin](https://github.com/datadog-labs/claude-code-plugin) 🟢 high confidence

---

### Authentication

**OAuth (default, recommended):**
- Browser-based, no credentials sent to AI provider
- Handles multi-org selection during auth flow
- Managed by `/ddsetup`; re-run to re-authenticate

**Key-based auth (alternative):**

Three env vars required:
- `DD_MCP_DOMAIN` — domain only, e.g. `mcp.datadoghq.com` (**not** a URL — do not include `https://`)
- `DD_API_KEY`
- `DD_APPLICATION_KEY`

With key auth, `/ddsetup` is not required. **Source says:** "When using key authentication, /ddsetup is not required — the plugin connects directly." ([github.com/datadog-labs/claude-code-plugin](https://github.com/datadog-labs/claude-code-plugin)) 🟢 high confidence

---

### Enterprise/Org Account Differences

All actions respect existing Datadog RBAC permissions — Application keys inherit the permissions of the user who created them. If a user can't see something in the Datadog UI, the API can't access it through the MCP server either.

For multi-org accounts: be careful to select the correct organization during OAuth. There is no post-auth org-switch without re-running `/ddsetup`. 🟡 medium confidence

---

### Secrets Injection for MCP Servers

`vals exec` wraps a process and exits — it cannot inject secrets into a subprocess that Claude Code will spawn independently later. Options ranked:

1. **OAuth (best)** — no secrets injection needed at all
2. **`~/.zshrc` env var export** — `export DD_API_KEY=...` makes the value available to all child processes including Claude Code's MCP spawns. Avoids the `env` block bug.
3. **`settings.json` `env` block** — documented as the intended approach but silently ignored in practice. The Claude Code bug was closed as a duplicate of another open issue; fix status unknown as of June 2026.

🟡 medium confidence — env block bug status unknown; OAuth path confirmed working

---

### APM Tools Available

**Core toolset** (no Preview sign-up needed, requires `APM Read` permission):

| Tool | Purpose |
|------|---------|
| `get_datadog_trace` | Fetch complete trace by trace ID |
| `search_datadog_spans` | Search spans by service, time, resource, tags |
| `search_datadog_service_dependencies` | Service dependency graph |

**Note:** `get_datadog_trace` may truncate output — large traces with thousands of spans may be truncated without a way to retrieve all spans.

**APM toolset (Preview — requires sign-up)**:

| Tool | Purpose |
|------|---------|
| `apm_search_spans` | Pagination + tag filtering |
| `apm_query_trace` | Filter/aggregate spans within a trace |
| `apm_discover_span_tags` | Discover available tag keys |
| `apm_latency_bottleneck_summary` | Latency analysis by self-time |
| `apm_search_watchdog_stories` | AI-detected anomalies |
| `apm_get_recommendation` | Optimization suggestions |

🟢 high confidence — fetched from official tools reference page

---

### Toolsets Configuration

Enable via `/ddtoolsets` (plugin) or `DD_MCP_TOOLSETS` env var. Use `toolsets=all` for all GA tools. Available toolsets: `core`, `apm`, `synthetics`, `software-delivery`, `security`, `llmobs`, `feature-flags`, and more.

---

### Recommendation

Use the official Claude Code plugin with OAuth:
```text
/plugin install datadog@claude-plugins-official
```
Then `/ddsetup` → select Datadog region → OAuth in browser. This sidesteps the `vals exec` incompatibility, avoids the `env` block bug, and is the approach Datadog officially supports. Enable the `core` toolset to start (APM Read gives you `get_datadog_trace` and `search_datadog_spans` without Preview sign-up).

If headless/automated key-based auth is needed, export `DD_API_KEY`, `DD_APPLICATION_KEY`, and `DD_MCP_DOMAIN` in `~/.zshrc` — not in `settings.json` (env block bug).

---

### Caveats

- The plugin is in Preview status
- The `apm` toolset (advanced APM tools) is separately in Preview and requires sign-up
- Large traces with thousands of spans may be truncated by `get_datadog_trace`
- OAuth requires browser access — not suitable for headless sessions
- Must be on Claude Code v2.1.30+

---

### Live Verification — commit-story Traces in APM

Verified via `search_datadog_spans` query (`service:commit-story*`, last 30 days) after MCP server was authenticated.

**Result:** 1,196 spans found, all from June 4, 2026.

**Key findings:**
- Service name is `commit-story` (not `commit-story-v2` — the OTel resource attribute `service.name` is set in the SDK bootstrap, not derived from the repo name)
- Custom attributes in `commit_story.*` namespace: `commit_story.journal.*`, `commit_story.summary.*`, `commit_story.context.*`
- LLM call spans carry `gen_ai.*` attributes: `gen_ai.request.model` (claude-haiku-4-5-20251001), `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.id`
- Ingested via local Datadog Agent, `ingestion_reason: probabilistic`, `env: development`

**The eval run gap:** commit-story traces reach APM via the local Datadog Agent on port 4318. During IS scoring runs, the Agent is stopped to free port 4318 for the OTel Collector — so eval traces go to the file exporter only and never appear in APM. Issue #899 addresses this by adding a Datadog exporter to the OTel Collector config so eval traces bypass the port conflict.

[APM Trace Explorer — commit-story spans](https://app.datadoghq.com/apm/traces?end=1780779974567&historicalData=true&paused=true&query=service%3Acommit-story%2A&start=1778187974567)

---

## Sources
- [Datadog MCP Server Tools](https://docs.datadoghq.com/mcp_server/tools/) — official tools reference; fetched directly
- [github.com/datadog-labs/claude-code-plugin](https://github.com/datadog-labs/claude-code-plugin) — official plugin repo; installation, auth, env vars
- [I tried the Datadog Claude Code plugin](https://dev.classmethod.jp/en/articles/datadog-claude-code-plugin/) — hands-on setup walkthrough; multi-reload gotcha, multi-org warning
- [Datadog MCP Server blog post](https://www.datadoghq.com/blog/datadog-remote-mcp-server/) — overview of server architecture
- [Claude Code GitHub Issue #28332](https://github.com/anthropics/claude-code/issues/28332) — env block silently ignored bug; closed as duplicate, fix status unknown
