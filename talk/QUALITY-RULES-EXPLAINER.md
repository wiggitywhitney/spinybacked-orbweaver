# Quality Rules — What's Validated and Where It Comes From

Reference document for the talk. Explains the relationship between the Instrumentation Score spec, the code-level evaluation rubric, and what spiny-orb actually validates at each level.

---

## Five Levels of Rule Enforcement

Not all rules are enforced the same way. The audience needs to understand these levels:

### Level 1: Automated Validators (in the agent's fix loop)

The agent gets real-time feedback and retries on violations. These are the rules the agent actually "learns from" during a run.

| Rule | Name | Dimension | Gate? |
|------|------|-----------|-------|
| NDS-001 | Compilation / Syntax Validation Succeeds | Non-Destructiveness | Gate |
| NDS-003 | Non-Instrumentation Lines Unchanged | Non-Destructiveness | Gate |
| NDS-004 | Public API Signatures Preserved | Non-Destructiveness | |
| NDS-005 | Error Handling Behavior Preserved | Non-Destructiveness | |
| NDS-006 | Module System Consistency | Non-Destructiveness | Gate |
| API-001 | Only @opentelemetry/api Imports | API-Only Dependency | Gate |
| API-002 | Correct Dependency Declaration | API-Only Dependency | |
| API-003 | No Vendor-Specific SDKs | API-Only Dependency | |
| API-004 | No SDK-Internal Imports | API-Only Dependency | |
| COV-001 | Entry Points Have Spans | Coverage | |
| COV-002 | Outbound Calls Have Spans | Coverage | |
| COV-003 | Failable Operations Have Error Visibility | Coverage | |
| COV-004 | Long-Running / Async Operations Have Spans | Coverage | |
| COV-005 | Domain-Specific Attributes Present | Coverage | |
| COV-006 | Auto-Instrumentation Preferred Over Manual Spans | Coverage | |
| RST-001 | No Spans on Utility Functions | Restraint | |
| RST-002 | No Spans on Trivial Accessors | Restraint | |
| RST-003 | No Duplicate Spans on Thin Wrappers | Restraint | |
| RST-004 | No Spans on Internal Implementation Details | Restraint | |
| RST-005 | No Re-Instrumentation of Already-Instrumented Code | Restraint | |
| SCH-001 | Span Names Match Registry Operations | Schema Fidelity | |
| SCH-002 | Attribute Keys Match Registry Names | Schema Fidelity | |
| SCH-003 | Attribute Values Conform to Registry Types | Schema Fidelity | |
| SCH-004 | No Redundant Schema Entries | Schema Fidelity | |
| CDQ-001 | Spans Closed in All Code Paths | Code Quality | |
| CDQ-005 | Async Context Maintained | Code Quality | |
| CDQ-006 | Expensive Attribute Computation Guarded | Code Quality | |
| CDQ-008 | Consistent Tracer Naming Convention | Code Quality | |

**28 rules** with automated validators.

### Level 2: Prompt Guidance (no validator catches violations)

The agent is told these rules in the system prompt but there's no automated check. If the LLM ignores the guidance, the violation passes through uncaught.

| Rule | Name | Dimension | Why no validator |
|------|------|-----------|-----------------|
| CDQ-002 | Tracer Acquired Correctly | Code Quality | Semantic check (is the name meaningful?), addressed via prompt guidance (PR #154) |
| CDQ-003 | Standard Error Recording Pattern | Code Quality | Pattern matching is fragile, addressed via prompt guidance (PRs #146, #157) |
| CDQ-007 | No Unbounded or PII Attributes | Code Quality | Hard to automate statically — requires understanding what constitutes PII or unbounded data |

**3 rules** with prompt-only enforcement.

### Level 3: Run-Level Checks (coordinator, not per-file)

Checked by the coordinator at checkpoints during the run, not by the per-file validation loop.

| Rule | Name | Dimension | How |
|------|------|-----------|-----|
| NDS-002 | All Pre-Existing Tests Pass | Non-Destructiveness (Gate) | Test suite runs at every 5-file checkpoint and at end of run |

**1 rule** at run level.

### Level 4: Evaluated Externally (the eval rubric)

All 32 rules are evaluated during evaluation runs (the commit-story-v2-eval process). The eval rubric checks rules that spiny-orb may or may not enforce internally. This is the independent quality assessment layer — it catches things the agent missed.

The eval process has caught prompt-only violations that spiny-orb didn't: attribute-type conformance issues (SCH-003 in the rubric) persisted for 2 runs despite prompt guidance before being caught by the evaluator.

### Level 5: Out of Scope (runtime/operational)

The Instrumentation Score spec's 19 rules (RES, SPA, MET, LOG, SDK) evaluate OTLP telemetry streams at runtime. Spiny-orb doesn't implement these — they require running the instrumented code and analyzing the telemetry output.

| Prefix | Category | Count | Why out of scope |
|--------|----------|-------|-----------------|
| RES | Resource Attributes | 5 | Runtime resource detection (service.instance.id, k8s.pod.uid) |
| SPA | Spans | 5 | Runtime trace analysis (orphan spans, durations, cardinality) |
| MET | Metrics | 6 | Spiny-orb doesn't add metrics |
| LOG | Logs | 2 | Spiny-orb doesn't add logs |
| SDK | SDK Configuration | 1 | Runtime/version compatibility |

**19 rules** out of scope.

---

## For the Talk: The Honest Version

When you say "validated against quality rules," the accurate framing is:

> "The agent's inner loop validates against 28 rules that can be checked statically — non-destructiveness, span coverage, restraint, schema fidelity, code quality. Three more rules are enforced through prompt guidance. The test suite runs at checkpoints to catch regressions. And I evaluate every run independently against the full 32-rule rubric to catch anything the agent missed."

Not all 32 rules are equal. The automated validators are the agent's real-time feedback loop. The prompt guidance rules are "best effort." The eval catches the gaps.

---

## How the 32 Rules Relate to the Instrumentation Score Spec

### What the framework borrowed from IS

The evaluation framework — how rules are **structured**, not what they **check** — is modeled on the IS spec:

| Element | IS Spec | Code-Level Rubric |
|---------|---------|-------------------|
| Rule ID syntax | `PREFIX-NNN` (e.g., RES-001) | Same format (e.g., NDS-001) |
| Dimension grouping | Rules clustered by concern area | Same pattern |
| Impact levels | Critical, Important, Normal, Low | IS's exact scale |
| Scoring model | Boolean pass/fail per rule | Same model |

### What the rules check: mostly independent

5 of 32 rules have IS counterparts — the rest are original.

| Code-Level Rule | IS Rule | Relationship |
|-----------------|---------|-------------|
| **RST-001** (No spans on utilities) | SPA-001 (≤10 INTERNAL spans/trace) | Direct static counterpart — prevents over-instrumentation that SPA-001 catches at runtime |
| **RST-002** (No spans on accessors) | SPA-005 (≤20 spans <5ms) | Indirect — spanning trivial functions creates the short-duration spans SPA-005 catches |
| **RST-003** (No duplicate spans on wrappers) | SPA-001 | Same concern (span count), different mechanism |
| **SCH-001** (Span naming quality) | SPA-003 (Bounded cardinality) | Partial overlap — both address naming, different criteria |
| **CDQ-002** (Tracer name correctness) | RES-005 (service.name present) | Indirect — related concern (service identity), different mechanism |

**27 rules have NO IS counterpart:**

- **NDS (6 rules)**: Non-destructiveness is entirely original. The IS spec doesn't care if the agent broke the build — it only sees telemetry output.
- **COV (6 rules)**: Coverage decisions are original. IS doesn't evaluate whether the right code paths were instrumented.
- **API (4 rules)**: Dependency model is original. IS doesn't check package.json.
- **SCH-002, SCH-003, SCH-004**: Schema attribute compliance (beyond naming) is original.
- **CDQ-001, CDQ-003, CDQ-005, CDQ-006, CDQ-007, CDQ-008**: Code quality patterns are original.

### The sources behind the 32 rules

The rubric cites its sources per-dimension:

| Dimension | Primary Sources |
|-----------|----------------|
| NDS (Non-Destructiveness) | Academic survey of 10 industrial microservice systems ([PMC8629732](https://pmc.ncbi.nlm.nih.gov/articles/PMC8629732/)) |
| COV (Coverage) | [OTel Library Instrumentation Guidelines](https://opentelemetry.io/docs/concepts/instrumentation/libraries/), academic survey |
| RST (Restraint) | [Honeycomb Practitioner's Guide](https://jeremymorrell.dev/blog/a-practitioners-guide-to-wide-events/), [Elastic OTel Best Practices](https://www.elastic.co/observability-labs/blog/best-practices-instrumenting-opentelemetry), IS spec SPA-001/SPA-005 |
| API (API-Only Dependency) | [OTel Client Design Principles](https://opentelemetry.io/docs/specs/otel/library-guidelines/), [OTel Library Guidelines](https://opentelemetry.io/docs/concepts/instrumentation/libraries/) |
| SCH (Schema Fidelity) | [OTel Weaver Blog](https://opentelemetry.io/blog/2025/otel-weaver/), [Grafana: Instrumentation Quality](https://grafana.com/docs/grafana-cloud/monitor-applications/application-observability/setup/instrumentation-quality/) |
| CDQ (Code Quality) | Ben Sigelman ([SE Radio](https://se-radio.net/2018/09/se-radio-episode-337-ben-sigelman-on-distributed-tracing/)), [OTel Library Guidelines](https://opentelemetry.io/docs/concepts/instrumentation/libraries/), [Better Stack Best Practices](https://betterstack.com/community/guides/observability/opentelemetry-best-practices/) |

---

## Framing Guidance

**What IS accurate:**

- "Informed by OTel community best practices — the Library Guidelines, the Instrumentation Score spec, vendor documentation, and academic research"
- "The framework structure follows the IS spec pattern; the rules are original"
- "5 of the 32 rules are static counterparts to IS runtime checks"
- "28 rules are automated validators in the agent's fix loop; 3 are prompt guidance; 1 is a run-level check"

**What to avoid:**

- ~~"32 rules derived from the Instrumentation Score spec"~~ — overstates the relationship. Only 5 have IS counterparts.
- ~~"Adapted from the IS spec for static analysis"~~ — implies the rules are IS rules translated, not original work
- ~~"Based on community standards"~~ — too vague, sounds like borrowed work

**Note on CDQ-005:** The rubric defines CDQ-005 as "Async Context Maintained." Spiny-orb previously had an internal validator also named CDQ-005 but for "Count Attribute Types" — a different concern. PR #286 removed the spiny-orb CDQ-005 validator to resolve this naming conflict. The count attribute type concern is correctly covered by SCH-003 (attribute values conform to registry types).
