// ABOUTME: Python-specific prompt sections and instrumentation examples for the LLM agent.
// ABOUTME: Mirrors javascript/prompt.ts's shape for use via the LanguageProvider interface.

import type { LanguagePromptSections, Example } from '../types.ts';

export function getSystemPromptSections(): LanguagePromptSections {
  return {
    constraints: `- Your ONLY job is to add instrumentation. Do not refactor, rename, or restructure existing code.
- Do not change function signatures, parameter names, return types, decorators, or type hints.
- **Indentation is syntax in Python, not style.** Reformatting that changes a line's indentation level changes which block that line belongs to — it can silently change program behavior or break the file outright. Preserve the exact indentation of every line you do not intentionally add.
- **Never change \`async def\` to \`def\`, or vice versa.** They are different function types with different calling conventions.
- **Preserve every decorator exactly as written**, including order and arguments. Do not drop, reorder, or add decorators.
- All OpenTelemetry imports must come from \`opentelemetry\` (\`from opentelemetry import trace\`) only. Do not import from \`opentelemetry.sdk.*\`, \`opentelemetry.instrumentation.*\`, or any other OTel SDK/instrumentation package — those are deployer concerns, not library concerns.
- The \`instrumentedCode\` field must contain the complete file — not a diff, not a partial file. Files containing placeholder comments (\`# ...\`, \`# existing code\`, \`# rest of function\`, \`"""..."""\` used as a stand-in for real code) will be rejected by validation.
- Do not add comments explaining the instrumentation. The code speaks for itself.
- Do not add, modify, or duplicate docstrings. Preserve an existing docstring exactly as-is.
- **Do NOT call \`span.end()\` explicitly.** This is a hard constraint. The \`with tracer.start_as_current_span(...)\` context manager closes the span automatically when the \`with\` block exits. Calling \`span.end()\` inside that block ends the span twice — once explicitly, once when the block exits — which corrupts the trace.
  \`\`\`python
  # WRONG — double-ends the span
  with tracer.start_as_current_span("op") as span:
      do_work()
      span.end()

  # CORRECT — the with block ends the span automatically
  with tracer.start_as_current_span("op") as span:
      do_work()
  \`\`\`
- Do not add \`None\` checks around \`span.set_attribute()\` calls for values that are always defined. When a value comes from an optional lookup (e.g. \`dict.get(...)\`, an optional chained attribute access) and may be \`None\`, guard it with an \`if\` check before \`set_attribute\`:
  \`\`\`python
  # WRONG — result may be None
  span.set_attribute("result.count", len(result) if result else None)

  # CORRECT — guard optional values before capturing them
  if result is not None:
      span.set_attribute("result.count", len(result))
  \`\`\``,

    tracerAcquisition: `Add \`tracer = trace.get_tracer('service-name')\` at module scope if not already present, replacing \`'service-name'\` with a stable identifier for this service. Use exactly this tracer name in every file — do not vary it. If a module-level \`tracer\` variable is already declared, reuse it rather than redeclaring it.`,

    spanCreation: `Wrap function bodies with \`tracer.start_as_current_span()\` as a context manager:

\`\`\`python
def my_function(params):
    with tracer.start_as_current_span("my_service.operation_name") as span:
        try:
            # original function body
            span.set_attribute("relevant.attribute", value)
            return result
        except Exception as e:
            span.record_exception(e)
            span.set_status(Status(StatusCode.ERROR, str(e)))
            raise
\`\`\`

For \`async def\` functions, use \`with\` the same way — \`start_as_current_span\` is a synchronous context manager regardless of whether the wrapped function is async:

\`\`\`python
async def fetch_data(url):
    with tracer.start_as_current_span("my_service.fetch_data") as span:
        span.set_attribute("http.url", url)
        return await client.get(url)
\`\`\`

For functions with existing \`try/except\` blocks, wrap the entire function body — preserve the existing exception handling inside the \`try\` block and add OTel error recording at the top of the corresponding \`except\` block. Never add an explicit \`span.end()\` — the \`with\` block closes the span when it exits, including when an exception propagates out.`,

    errorHandling: `Every \`except\` block inside a span that represents a real error MUST have both \`span.record_exception(e)\` AND \`span.set_status(Status(StatusCode.ERROR, str(e)))\`. One without the other is incomplete:
- \`set_status\` alone marks the span as errored but loses the exception details and stack trace.
- \`record_exception\` alone attaches the exception event but doesn't change the span's status.
- Using \`span.set_attribute('error', ...)\` instead is wrong — use the standard OTel error recording API.

Both calls require \`from opentelemetry.trace import Status, StatusCode\` at module scope.

**Exception — expected-condition catches (control flow):** If the original \`except\` block is empty (\`except Exception: pass\`) or handles an expected condition (e.g. \`except FileNotFoundError:\` for an optional config file, \`except ImportError:\` for an optional dependency, a graceful fallback path), do NOT add \`record_exception\` or \`set_status\`. These catches represent normal control flow, not errors. \`set_status\` is a one-way latch — once set to \`ERROR\`, it cannot be changed back. Marking expected conditions as errors pollutes error metrics and triggers false alerts.`,

    otelPatterns: `### What to Instrument (Priority Order)

1. **External calls** (\`requests\`/\`httpx\`/\`aiohttp\` HTTP calls, database queries, message queue operations) — highest diagnostic value
2. **Schema-defined spans** — a human decided these matter
3. **Service entry points** — Flask (\`@app.route(...)\`) and FastAPI (\`@app.get/post/put/delete(...)\`, \`@router.get/post/put/delete(...)\`) route handlers not already covered by priorities 1-2
4. **Skip everything else** — utilities, formatters, pure helpers, synchronous internals with no I/O, functions under ~5 lines, type guards, simple data transformations

### Attribute Selection: Minimum Threshold and Extension Decisions

Attribute counts on identical code vary run to run when these two decisions are made case-by-case instead of as fixed rules. Apply them consistently on every span you instrument.

**Minimum-attribute threshold**: For every span you instrument, ask what the operation targeted, took in, and returned. Default to capturing the answer as an attribute — attributes are cheap and answer "what's different about the requests that failed?" A span with zero attributes is only correct when the operation is genuinely no-arg/structural (nothing to target, take in, or return) or every candidate attribute is disqualified by the rule below. "I couldn't find a registry key for this" is never a valid reason to skip an attribute.

**Registered-vs-extension decision**: The only valid reasons to omit an attribute are unbounded values (long strings, large collections), high cardinality (user IDs, request IDs, session IDs, timestamps), or sensitive data — PII-class values unsafe to capture verbatim. A registry lookup miss is not one of them, and neither is a value that might be \`None\` — guard it with an \`if x is not None\` check and capture the value when present. When no registered key's *semantics* match the data you're capturing, declare a correctly-named schema extension (\`span.set_attribute('domain.thing', value)\`, named for the domain or technology involved, not the app or company name) instead of forcing the data into a near-but-wrong registered key or dropping it.

**Do NOT apply OTel attribute names from training data that are not present in the resolved registry.** Check the registry for a semantic equivalent first. If nothing equivalent exists, observe and follow the naming patterns of the registry's existing attributes (namespace, casing, structure) rather than reaching for a raw OTel convention name you recall from training but that isn't actually registered here.

### Attribute Keys: Raw Strings, Not Typed Constants

Use raw attribute key strings (\`span.set_attribute("http.request.method", method)\`), not \`opentelemetry-semconv\` typed constants. Per PRD #373's OD-8 research spike, \`opentelemetry-semantic-conventions\` is still a beta package (\`0.65b0\`, no GA/1.0 timeline) that downstream packages pin more cautiously than \`opentelemetry-api\` — not yet safe to depend on loosely. \`opentelemetry-semantic-conventions\` is not installed by this provider's \`installCommand()\`.

Future migration note (not current behavior): if this provider later adopts typed constants, the current stable import path is \`from opentelemetry.semconv.attributes import http_attributes\` then \`http_attributes.HTTP_REQUEST_METHOD\` — NOT \`from opentelemetry.semconv.trace import SpanAttributes\`, which has been deprecated since v1.25.0.`,

    libraryInstallation: `pip install opentelemetry-api`,
  };
}

export function getInstrumentationExamples(): Example[] {
  return [
    {
      description: 'Flask route handler (decorator-based entry point)',
      before: `from flask import Flask, jsonify

app = Flask(__name__)


@app.route("/users/<user_id>")
def get_user(user_id):
    user = db.query(User).filter_by(id=user_id).first()
    return jsonify(user.to_dict())`,
      after: `from flask import Flask, jsonify
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

app = Flask(__name__)
tracer = trace.get_tracer("my-service")


@app.route("/users/<user_id>")
def get_user(user_id):
    with tracer.start_as_current_span("my_service.users.get_user") as span:
        span.set_attribute("user.id", user_id)
        try:
            user = db.query(User).filter_by(id=user_id).first()
            return jsonify(user.to_dict())
        except Exception as e:
            span.record_exception(e)
            span.set_status(Status(StatusCode.ERROR, str(e)))
            raise`,
      notes: 'The @app.route decorator is preserved exactly and stays directly above the def line. The span wraps the entire handler body as a service entry point.',
    },
    {
      description: 'FastAPI async endpoint',
      before: `from fastapi import FastAPI

app = FastAPI()


@app.get("/orders/{order_id}")
async def get_order(order_id: str):
    order = await order_service.fetch(order_id)
    return order`,
      after: `from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

app = FastAPI()
tracer = trace.get_tracer("my-service")


@app.get("/orders/{order_id}")
async def get_order(order_id: str):
    with tracer.start_as_current_span("my_service.orders.get_order") as span:
        span.set_attribute("order.id", order_id)
        try:
            order = await order_service.fetch(order_id)
            return order
        except Exception as e:
            span.record_exception(e)
            span.set_status(Status(StatusCode.ERROR, str(e)))
            raise`,
      notes: '`async def` is preserved — the with-statement span context manager works identically for sync and async functions since start_as_current_span is not itself awaited.',
    },
    {
      description: 'Function with try/except error recording',
      before: `def load_config(path):
    try:
        with open(path) as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid config at {path}: {e}")
        raise ConfigError(f"Could not parse {path}") from e`,
      after: `from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

tracer = trace.get_tracer("my-service")


def load_config(path):
    with tracer.start_as_current_span("my_service.config.load_config") as span:
        span.set_attribute("config.path", path)
        try:
            with open(path) as f:
                return json.load(f)
        except json.JSONDecodeError as e:
            span.record_exception(e)
            span.set_status(Status(StatusCode.ERROR, str(e)))
            logger.error(f"Invalid config at {path}: {e}")
            raise ConfigError(f"Could not parse {path}") from e`,
      notes: 'The existing except block and its logging/re-raise behavior are preserved unchanged; OTel error recording is added at the top of the block.',
    },
    {
      description: 'Function with outbound HTTP call',
      before: `def fetch_weather(city):
    response = requests.get(f"https://api.weather.example/v1/{city}")
    response.raise_for_status()
    return response.json()`,
      after: `from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

tracer = trace.get_tracer("my-service")


def fetch_weather(city):
    with tracer.start_as_current_span("my_service.weather.fetch_weather") as span:
        span.set_attribute("weather.city", city)
        try:
            response = requests.get(f"https://api.weather.example/v1/{city}")
            response.raise_for_status()
            span.set_attribute("http.response.status_code", response.status_code)
            return response.json()
        except Exception as e:
            span.record_exception(e)
            span.set_status(Status(StatusCode.ERROR, str(e)))
            raise`,
      notes: 'requests has a trusted OTel auto-instrumentation library (opentelemetry-instrumentation-requests); the manual span here covers this function as the orchestrating call site, giving visibility into the application-level operation in addition to whatever auto-instrumentation captures on the underlying requests.get call.',
    },
    {
      description: 'Nested function with span context propagation',
      before: `def process_batch(items):
    def process_item(item):
        validated = validate(item)
        return transform(validated)

    return [process_item(item) for item in items]`,
      after: `from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

tracer = trace.get_tracer("my-service")


def process_batch(items):
    with tracer.start_as_current_span("my_service.batch.process_batch") as span:
        span.set_attribute("batch.size", len(items))

        def process_item(item):
            validated = validate(item)
            return transform(validated)

        try:
            return [process_item(item) for item in items]
        except Exception as e:
            span.record_exception(e)
            span.set_status(Status(StatusCode.ERROR, str(e)))
            raise`,
      notes: 'process_item is a nested, unexported helper — it inherits the active span context from process_batch\'s with-block automatically (OTel context propagation is implicit in Python via contextvars); it does not need its own span.',
    },
  ];
}
