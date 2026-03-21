# Quality Rules — What's Validated and Where It Comes From

Reference document for the talk. Explains the relationship between the Instrumentation Score spec, the code-level evaluation rubric, and what spiny-orb actually validates.

---

## Three Layers of Rules

### 1. Instrumentation Score Spec (19 rules) — Runtime, Not Ours

The [Instrumentation Score](https://github.com/instrumentation-score/spec) is a community-driven 0-100 standard by OllyGarden, with contributions from Dash0, New Relic, Splunk, Datadog, and Grafana Labs. It evaluates OTLP telemetry streams at runtime.

**Prefixes**: RES (Resource Attributes), SPA (Spans), MET (Metrics), LOG (Logs), SDK (SDK Configuration)

**Spiny-orb doesn't implement these.** They require running the instrumented code and analyzing the telemetry output. They're a separate evaluation concern — complementary to what spiny-orb does.

### 2. Code-Level Evaluation Rubric (32 rules) — Static, Whitney's Original

The evaluation rubric in `research/evaluation-rubric.md` evaluates the **source code** produced by the agent. These rules exist because AI-generated instrumentation has concerns that the IS spec doesn't address: did the agent break the build? Did it instrument the right functions? Did it follow the schema?

**Prefixes**: NDS (Non-Destructiveness), COV (Coverage), RST (Restraint), API (API-Only Dependency), SCH (Schema Fidelity), CDQ (Code Quality)

### 3. What Spiny-Orb Actually Validates (subset of #2)

Not all 32 rubric rules are implemented as automated validators in spiny-orb. The breakdown:

| Enforcement | Rules | How |
|-------------|-------|-----|
| **Automated validators** (in the fix loop) | NDS-001, NDS-003, NDS-004, NDS-005, NDS-006, API-001, COV-001–COV-006, RST-001–RST-005, API-002–API-004, SCH-001–SCH-004, CDQ-001, CDQ-005, CDQ-006, CDQ-008 | Agent gets real-time feedback, retries on violations |
| **Prompt guidance** (no validator) | CDQ-002 (tracer naming), CDQ-003 (error recording pattern), CDQ-007 (unbounded/PII attributes) | Agent is told the rules but violations aren't caught automatically |
| **Run-level checks** (coordinator, not per-file) | NDS-002 (tests pass) | Test suite runs at checkpoints, not per-file validation |

**For the talk**: "The agent's inner loop validates against the subset that can be checked statically — non-destructiveness, coverage, restraint, schema fidelity. Other rules are enforced through prompt guidance."

---

## How the Rubric Relates to the IS Spec

The evaluation framework — how rules are structured, scored, and categorized — is **modeled on** the IS spec:

| Element | IS Spec | Code-Level Rubric |
|---------|---------|-------------------|
| Rule ID format | `PREFIX-NNN` (e.g., RES-001) | Same format (e.g., NDS-001) |
| Dimension grouping | Rules clustered by concern | Same pattern |
| Impact levels | Critical, Important, Normal, Low | Same scale |
| Scoring model | Boolean pass/fail per rule | Same model |

But the **actual rules** are mostly independent:

### Rules with IS counterparts (5 of 32)

| Your Rule | IS Rule | Relationship |
|-----------|---------|-------------|
| **RST-001** (No spans on utilities) | SPA-001 (≤10 INTERNAL spans per trace) | Direct static counterpart — prevents over-instrumentation that SPA-001 catches at runtime |
| **RST-002** (No spans on accessors) | SPA-005 (≤20 spans with duration <5ms) | Indirect — spanning trivial functions creates the short-duration spans SPA-005 catches |
| **RST-003** (No duplicate spans on wrappers) | SPA-001 | Same concern, different mechanism |
| **SCH-001** (Span naming quality) | SPA-003 (Bounded cardinality) | Partial overlap — both check naming, different criteria |
| **CDQ-002** (Tracer name correctness) | RES-005 (service.name present) | Indirect — related concern (service identity), different mechanism |

### Rules with NO IS counterpart (27 of 32)

- **NDS-001 through NDS-006**: Non-destructiveness is entirely original. IS doesn't care if the agent broke the build.
- **COV-001 through COV-006**: Coverage decisions are original. IS doesn't evaluate whether the right code paths were instrumented.
- **API-001 through API-004**: Dependency model is original. IS doesn't check package.json.
- **SCH-002 through SCH-004**: Schema attribute compliance is original (beyond naming).
- **CDQ-001, CDQ-003, CDQ-005 through CDQ-008**: Code quality patterns are original.

---

## The Accurate Framing

**For the talk:**

> "32 code-level quality rules. The evaluation framework is structured after the Instrumentation Score spec — same impact levels, same pass/fail model. But the rules themselves address a different concern: evaluating AI-generated source code, not runtime telemetry. About 5 rules are static counterparts to IS runtime checks; the other 27 are original — covering non-destructiveness, coverage decisions, restraint, schema fidelity, and code quality patterns that only matter when an AI agent is writing your instrumentation."

**What NOT to say:**

- ~~"32 rules derived from the Instrumentation Score spec"~~ — overstates the relationship
- ~~"Adapted from the IS spec for static analysis"~~ — implies the rules are IS rules translated, not original work
- ~~"Based on community standards"~~ — too vague, sounds like borrowed work

**What IS accurate:**

- "Informed by OTel community best practices — the Library Guidelines, the Instrumentation Score spec, vendor documentation, and academic research"
- "The framework structure follows the IS spec pattern; the rules are original"
- "5 of the 32 rules are static counterparts to IS runtime checks"
