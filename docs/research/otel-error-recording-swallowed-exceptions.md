# Research: OpenTelemetry Error Recording for Swallowed Exceptions (COV-003)

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-09-29

## Update Log

| Date | Summary |
|------|---------|
| 2026-09-29 | Initial research (PRD #373 follow-up to the CodeRabbit finding on Python COV-003; Decision D-COV003-1) |
| 2026-09-29 | Clarified recommendation 2 after reading JavaScript's `isExpectedConditionCatch`: the Python equivalent exempts every swallowing `except`, leaving COV-003 with only the raw `start_span()` re-raise case |

## Findings

### Summary
The OTel specification does not support tightening COV-003 (error recording present in catch blocks) to require the exception event, or to require both calls. Span status `ERROR` is the primary normative signal, and the exception event is a weaker recommendation that OTel is moving toward logs. So the narrow question resolves to **keep either-call and correct `docs/rules-reference.md`**. The bigger finding is about scope. The spec says errors that were handled so the operation could complete gracefully "SHOULD NOT be recorded on spans", and Python COV-003 as built requires recording on those catches. Running the real checkers showed Python COV-003 and NDS-007 (expected-condition catch blocks must not gain error recording) cannot both pass on a graceful-degradation `except` inside a span.

### Surprises & Gotchas

- **The rule pair is unsatisfiable in Python.** For an `except FileNotFoundError: return None` inside a span, leaving it untouched fails COV-003, and adding `span.record_exception(exc)` fails NDS-007. Verified by running both real checkers (Findings 5 and 6).
- **The spec says not to record handled errors on spans at all.** This is the opposite of what Python COV-003 currently demands for a swallowing `except`.
- **The exception-on-spans convention is deprecated.** The page carries a "Deprecated" marker and points to exceptions as log records. The `exception.escaped` attribute is deprecated with the reason "It's no longer recommended to record exceptions that are handled and do not escape the scope of a span."
- **JS COV-003's failure message asks for both calls but the check accepts any one.** The message says to add `span.recordException(error)` and `span.setStatus(...)`, while the check passes on `.recordException(`, `.setStatus(`, or `setAttribute("error"`. The last pattern includes the closing quote, so `setAttribute("error.type", ...)`, the attribute the spec says to set, does not match.
- **`docs/rules-reference.md` documents both calls as required.** Neither implementation requires both.

### Findings

**1. Span status `ERROR` is the primary normative signal** 🟢 high
**Source says:** For an operation that ends with an error, instrumentation "SHOULD set the span status code to `Error`" and "SHOULD set the [`error.type`]" attribute. If an exception caused the failure, the status description "SHOULD be set to the exception message." Span status "MUST be left unset if the instrumented operation has ended without any errors." ([OTel: Recording errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/))
**Interpretation:** Status plus `error.type` is what the spec asks for on a failed operation. Status-only is not described as incomplete.

**2. Handled errors should not be recorded on spans** 🟢 high
**Source says:** Errors that were retried or handled "SHOULD NOT be recorded on spans or metrics that describe this operation." ([OTel: Recording errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/)) The exceptions-on-spans page says of `exception.escaped`: "It's no longer recommended to record exceptions that are handled and do not escape the scope of a span." ([OTel: Exceptions on spans](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-spans/))
**Interpretation:** A graceful-degradation catch (returns a default, continues, ignores a missing file) should leave the span alone. This matches the existing JavaScript `isExpectedConditionCatch` exemption, which `docs/rules-reference.md` already calls "spec-correct."

**3. The exception event is a weaker, conditional recommendation, and is moving to logs** 🟢 high
**Source says:** An exception "SHOULD be recorded as an [`Event`]" only when it "remains unhandled when the span ends" and "causes the span status to be set to ERROR." The event name "MUST be `exception`", and `exception.type`, `exception.message`, and `exception.stacktrace` are recommended or conditionally required. ([OTel: Exceptions](https://opentelemetry.io/docs/specs/otel/trace/exceptions/)) The recording-errors page says instrumentation "SHOULD record this exception as a [log record]", and the exceptions-on-spans page is marked "Deprecated." ([Recording errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/), [Exceptions on spans](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-spans/))
**Interpretation:** Requiring the exception event, or requiring both calls, would enforce something the spec treats as optional and the ecosystem is moving away from.

**4. `RecordException` and `SetStatus` are independent calls** 🟢 high
**Source says:** RecordException "is a specialized variant of `AddEvent`" and its section "makes no statement about span status." `Description` "MUST only be used with the `Error` `StatusCode` value." ([OTel: Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/))
**Interpretation:** The spec does not tie the two together, so "either" is a coherent bar.

**5. The Python SDK records both automatically, but only for exceptions that leave the `with` block** 🟢 high
Installed `opentelemetry-sdk` 1.35.0: `use_span()` defaults `record_exception=True` and `set_status_on_exception=True`. Inside `except Exception as exc:` it calls `span.record_exception(exc)` and `span.set_status(Status(StatusCode.ERROR, description=f"{type(exc).__name__}: {exc}"))`. `record_exception` builds `exception.type`, `exception.message`, and `exception.stacktrace`. A swallowed exception never reaches that handler.
**Interpretation:** A swallowed exception gets nothing automatically, which is why a manual call is the only way to get any recording on a swallowed failure. It does not mean every swallowed exception should get one (Finding 2).

**6. Running the real checkers shows COV-003 and NDS-007 contradict each other** 🟢 high
Probe on `except FileNotFoundError: return None` inside `with tracer.start_as_current_span(...) as span:`, run against the real Python checkers on this branch:
- Except untouched: COV-003 fails ("swallows an exception without recording it on the span"), NDS-007 passes.
- `span.record_exception(exc)` added: COV-003 passes, NDS-007 fails ("Error recording added to an except block that handles an expected condition").
No variant passes both. NDS-007 treats any except without a re-raise as an expected condition (it reuses COV-003's `containsReraise`), while COV-003 treats the same shape as a failure needing a record. JavaScript avoids this because COV-003 exempts expected-condition catches (`isExpectedConditionCatch`), and JS NDS-007 uses the same predicate.
**Interpretation:** This is a real defect in the Python provider, independent of the either-or question, and it is the spec-consistent side (NDS-007) that Python COV-003 contradicts.

**7. Real instrumentation re-raises, and does not record on swallow** 🟡 medium (one library examined)
**Source says:** In `opentelemetry-instrumentation-requests`, `instrumented_send` catches `Exception`, stores it, and later re-raises it with `raise exception.with_traceback(exception.__traceback__)` inside the `start_as_current_span` block. It calls neither `record_exception` nor `set_status(ERROR)` itself. It sets `ERROR_TYPE` as an attribute under the new semconv opt-in. ([requests instrumentation](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/instrumentation/opentelemetry-instrumentation-requests/src/opentelemetry/instrumentation/requests/__init__.py))
**Interpretation:** The library relies on the SDK's automatic handling by re-raising, which is the pattern OD-4 already exempts. No swallow-and-record example was found, so this sub-question stays open.

**8. Backends: status is the error signal, and an exception event is optional** 🟡 medium
**Source says:** Datadog's OpenTelemetry API support page shows `span.setStatus(ERROR, "Some error details...")` under "To set an error on a span" and `recordException` as a separate API. It does not say a `recordException` call is required for an error to appear or for stack traces to be captured. ([Datadog: OpenTelemetry API support](https://docs.datadoghq.com/opentelemetry/instrument/dd_sdks/api_support/))
**Interpretation:** Status-only marks the span as an error in Datadog. The exception event adds type, message and stack detail. Search results (not fetched) said Datadog Error Tracking needs `error.stack`, `error.message`, and `error.type`, and that another backend counts only ERROR-status spans as errors; neither was verified from the source, so the richness argument for keeping the exception event stays medium confidence.

### Conflicting Findings
- **Source A says:** Spans "SHOULD NOT" carry records of handled errors ([Recording errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/)).
- **Source B says (project):** `~/.claude/rules/opentelemetry-python-gotchas.md` states a swallowed exception's manual `record_exception()` and `set_status()` calls "ARE needed here, or the error goes completely unrecorded on the span."
- **Interpretation:** Both are true for different swallows. The rule file is right for a swallow that hides a real failure of the span's operation. Finding 2 is right for graceful degradation. COV-003 currently cannot tell the two apart in Python.

### Recommendation
1. **Narrow question: keep either-call and correct the documentation.** Correct `docs/rules-reference.md` to say `recordException` or `setStatus(ERROR)` (JavaScript also accepts an `error` attribute). Do not tighten to the exception event or to both: no spec sentence supports either.
2. **Fix the Python COV-003 and NDS-007 contradiction as a separate, test-first change.** JavaScript's `isExpectedConditionCatch` treats any catch that does not rethrow as handled gracefully, so the equivalent Python exemption exempts every swallowing `except`. COV-003 is then left to flag only a re-raising `except` where nothing records automatically (a raw `start_span()` span with no context manager), which is the Python analog of JavaScript's rethrow-needs-recording rule. NDS-007 keeps forbidding recording on swallows, so the two rules divide catches the same way as in JavaScript. This supersedes the swallow half of OD-4's 2026-09-18 correction, which chose to flag every non-re-raising except.
3. **Optional follow-ups, lower priority:** make JS COV-003 accept `setAttribute("error.type", ...)`, and make its failure message match what it actually requires.

### Caveats
- JavaScript's "no automatic recording in `startActiveSpan`" was not re-verified: the SDK source URL returned 404 and the JS docs fetch truncated before the section. It rests on the project's earlier rule file and on JS COV-003's own design.
- The exceptions-on-spans page is deprecated and the recording-errors guidance is marked Development in places, so wording may change.
- Only one instrumentation library was examined. The Datadog error-tracking requirements come from an unfetched search summary.
- The COV-003 and NDS-007 probe used one example. Other exception shapes (logging then swallowing, nested handlers) were not tried.

## Sources
- [OTel: Recording errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/) — status ERROR, `error.type`, and the "SHOULD NOT be recorded" wording for handled errors
- [OTel: Exceptions](https://opentelemetry.io/docs/specs/otel/trace/exceptions/) — exception event conditions and event name
- [OTel: Exceptions on spans](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-spans/) — deprecated page, `exception.escaped` deprecation
- [OTel: Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/) — `SetStatus` and `RecordException` semantics
- [Datadog: OpenTelemetry API support](https://docs.datadoghq.com/opentelemetry/instrument/dd_sdks/api_support/) — `setStatus` and `recordException` as separate APIs
- [opentelemetry-instrumentation-requests](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/instrumentation/opentelemetry-instrumentation-requests/src/opentelemetry/instrumentation/requests/__init__.py) — real catch-and-re-raise handling
- Local: installed `opentelemetry-sdk` 1.35.0 source (`use_span`, `Span.record_exception`), and this repo's `src/languages/{python,javascript}/rules/cov003.ts` and `nds007.ts`
