# Code-Level Telemetry Value — Research for Slide 9

Research conducted 2026-03-22. Focused on concrete benefits for platform engineers.

---

## Summary

Three categories of value, with citable evidence for each.

### 1. Understand Code Behavior

**Source says:** "Code-Level Observability allows you to track the execution of each function, capturing call details, parameters, and execution context. This approach allows you not only to detect symptoms of a problem but also to quickly determine its root cause right in the source code." ([BitDive / Medium](https://medium.com/@frolikov123/code-level-observability-deep-code-level-visibility-vs-7b9f904d1081))

**Source says:** "Code-based solutions allow you to get deeper insight and rich telemetry from your application itself." ([OTel Docs](https://opentelemetry.io/docs/concepts/instrumentation/))

**Source says:** "With code-level insights plus infrastructure observability, we can connect infrastructure signals to business outcomes." ([Whitney's CNCF blog](https://www.cncf.io/blog/2025/11/07/code-level-telemetry-instrumentation-from-oh-hell-no-to-worth-it/))

### 2. Troubleshoot Faster

**Source says:** "Splunk customers can go from issue detection to understanding the cause in under four minutes 90% of the time." ([Splunk](https://www.splunk.com/en_us/blog/devops/using-observability-to-reduce-mttr.html))

**Source says:** SaaS platform serving 50K+ businesses went from 2-hour MTTR to 12 minutes after instrumenting 40+ microservices with OpenTelemetry (custom business metrics + distributed tracing). 10x reduction. ([Armovera Case Study](https://armovera.com/case-study-mttr-reduction.html))

**Source says:** incident.io engineers tag spans with user/org IDs, enabling them to "find all traces where they queried a specific table" and "often detect bugs faster than their customers can report them." ([incident.io blog](https://incident.io/blog/observability-as-a-superpower))

**Source says:** "MTTR captures your team's ability to detect, respond to, and learn from incidents. Fast recovery time signals strong observability." ([DORA metrics guide](https://getdx.com/blog/dora-metrics/))

**Stat:** Up to 54% reduction in MTTR for organizations adopting observability (Splunk Research). 40% MTTR reduction is widely cited across multiple sources.

### 3. Prove Platform Engineering Value

**Source says:** "40.9% of platform initiatives can't demonstrate measurable value within their first year." And "nearly 30% of platform teams don't measure success at all." ([The Register, citing 2025 State of Platform Engineering Report Vol 4](https://www.theregister.com/2026/02/11/metrics_that_matter_platform/))

**Source says:** "We can prove our value with Service Level Objectives (SLOs) like '99% of checkouts complete within 2 seconds.'" ([Whitney's CNCF blog](https://www.cncf.io/blog/2025/11/07/code-level-telemetry-instrumentation-from-oh-hell-no-to-worth-it/))

**Source says:** "SLOs move the conversation from 'uptime' to 'user experience,' and from 'more monitoring' to 'fewer, better alerts.'" ([Platform Engineering org](https://platformengineering.org/talks-library/observability-and-measuring-slos))

**Source says:** "Gartner predicts that by 2026, nearly 80% of software engineering organizations will have dedicated platform teams." ([Gartner via multiple sources](https://slavikdev.com/platform-engineering-trends-2026/))

**Source says:** Google Cloud research shows "elite performers on DORA metrics are 2x more likely to exceed organizational goals related to profitability, productivity, and customer satisfaction." ([Faros AI / DORA](https://www.faros.ai/blog/key-takeaways-from-the-dora-report-2025))

**Source says:** Organizations report 2.6x average ROI from observability spending. 63% plan to increase investment. ([IBM Observability Trends 2026](https://www.ibm.com/think/insights/observability-trends))

---

## Slide-Worthy Phrasings (for Whitney to choose from)

### Understand
- "Connect infrastructure signals to business outcomes"
- "See what's happening inside your business logic, not just at the edges"

### Troubleshoot
- "Go from alert to root cause in minutes, not hours"
- "40% MTTR reduction with proper instrumentation" (widely cited)

### Prove value
- "41% of platform teams can't demonstrate value in year one — because they can't measure what they can't see"
- "SLOs like '99% of checkouts complete in 2 seconds' — that's how you prove your platform works"

---

## Sources

- [Code-level telemetry instrumentation — CNCF (Whitney Lee)](https://www.cncf.io/blog/2025/11/07/code-level-telemetry-instrumentation-from-oh-hell-no-to-worth-it/)
- [A platform engineer's guide to proving value — The Register](https://www.theregister.com/2026/02/11/metrics_that_matter_platform/)
- [Observability Trends 2026 — IBM](https://www.ibm.com/think/insights/observability-trends)
- [DORA Report 2025 Key Takeaways — Faros AI](https://www.faros.ai/blog/key-takeaways-from-the-dora-report-2025)
- [Observability as a superpower — incident.io](https://incident.io/blog/observability-as-a-superpower)
- [MTTR Reduction Case Study — Armovera](https://armovera.com/case-study-mttr-reduction.html)
- [Using Observability to Reduce MTTR — Splunk](https://www.splunk.com/en_us/blog/devops/using-observability-to-reduce-mttr.html)
- [Code-Level Observability — BitDive / Medium](https://medium.com/@frolikov123/code-level-observability-deep-code-level-visibility-vs-7b9f904d1081)
- [How to Implement Custom OpenTelemetry Spans — OneUptime](https://oneuptime.com/blog/post/2026-02-02-opentelemetry-custom-spans/view)
- [Observability and Measuring SLOs — Platform Engineering](https://platformengineering.org/talks-library/observability-and-measuring-slos)
- [Charity Majors on Observability — The Bike Shed](https://bikeshed.thoughtbot.com/302)
