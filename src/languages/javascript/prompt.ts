// ABOUTME: JavaScript-specific prompt sections and instrumentation examples for the LLM agent.
// ABOUTME: Extracted from src/agent/prompt.ts (PRD #371 B1) for use via the LanguageProvider interface.

import type { LanguagePromptSections, Example } from '../types.ts';

/**
 * Formatted examples section string for inclusion in the current buildSystemPrompt template.
 * Used by src/agent/prompt.ts until B2 migrates prompt assembly through the LanguageProvider
 * interface. Exported so the shared prompt builder can import it rather than define it inline.
 */
export const EXAMPLES_SECTION = `## Examples

<examples>
<example id="1" title="Basic async function instrumentation">
<before>
import { Pool } from 'pg';

const pool = new Pool();

export async function getUsers(req, res) {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
}
</before>
<after>
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Pool } from 'pg';

const pool = new Pool();
const tracer = trace.getTracer('my-service');

export async function getUsers(req, res) {
  return tracer.startActiveSpan('my_service.users.get_users', async (span) => {
    try {
      const result = await pool.query('SELECT * FROM users');
      span.setAttribute('db.row_count', result.rows.length);
      res.json(result.rows);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
</after>
<notes>
librariesNeeded: [{ package: "@opentelemetry/instrumentation-pg", importName: "PgInstrumentation" }]
The handler gets a manual span as a service entry point. The pg.query call is covered by auto-instrumentation.
</notes>
</example>

<example id="2" title="Async function with existing try/catch">
<before>
import { readFile } from 'node:fs/promises';

export async function loadConfig(path) {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to load config:', error);
    throw new Error(\`Config load failed: \${error.message}\`);
  }
}
</before>
<after>
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { readFile } from 'node:fs/promises';

const tracer = trace.getTracer('my-service');

export async function loadConfig(path) {
  return tracer.startActiveSpan('my_service.config.load_config', async (span) => {
    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      console.error('Failed to load config:', error);
      throw new Error(\`Config load failed: \${error.message}\`);
    } finally {
      span.end();
    }
  });
}
</after>
<notes>
The existing try/catch is preserved. OTel error recording is added at the top of the catch block before the existing error handling. The span wraps the entire function body.
</notes>
</example>

<example id="3" title="Already instrumented — skip">
<before>
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function handleRequest(req, res) {
  return tracer.startActiveSpan('my_service.requests.handle_request', async (span) => {
    try {
      const result = await processData(req.body);
      span.setAttribute('result.count', result.length);
      res.json(result);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      res.status(500).json({ error: error.message });
    } finally {
      span.end();
    }
  });
}
</before>
<after>
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function handleRequest(req, res) {
  return tracer.startActiveSpan('my_service.requests.handle_request', async (span) => {
    try {
      const result = await processData(req.body);
      span.setAttribute('result.count', result.length);
      res.json(result);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      res.status(500).json({ error: error.message });
    } finally {
      span.end();
    }
  });
}
</after>
<notes>
The function already has OTel instrumentation (tracer.startActiveSpan pattern). No changes made. Report in notes that the function was skipped.
</notes>
</example>

<example id="4" title="Variable shadowing — use suffixed names">
<before>
export async function processSpan(data) {
  const span = data.timeSpan;
  const duration = span.end - span.start;
  return { duration, unit: 'ms' };
}
</before>
<after>
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function processSpan(data) {
  return tracer.startActiveSpan('my_service.spans.process_span', async (otelSpan) => {
    try {
      const span = data.timeSpan;
      const duration = span.end - span.start;
      return { duration, unit: 'ms' };
    } catch (error) {
      otelSpan.recordException(error);
      otelSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      otelSpan.end();
    }
  });
}
</after>
<notes>
The variable name "span" is already used in this function scope. The OTel span callback parameter uses "otelSpan" to avoid shadowing.
</notes>
</example>

<example id="5" title="Auto-instrumentation library detection">
<before>
import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();

export async function getUsers(req, res) {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
}

app.get('/users', getUsers);
</before>
<after>
import { trace, SpanStatusCode } from '@opentelemetry/api';
import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();
const tracer = trace.getTracer('my-service');

export async function getUsers(req, res) {
  return tracer.startActiveSpan('my_service.users.get_users', async (span) => {
    try {
      const result = await pool.query('SELECT * FROM users');
      span.setAttribute('db.row_count', result.rows.length);
      res.json(result.rows);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

app.get('/users', getUsers);
</after>
<notes>
Both express and pg have auto-instrumentation libraries. Recorded in librariesNeeded: [{ package: "@opentelemetry/instrumentation-express", importName: "ExpressInstrumentation" }, { package: "@opentelemetry/instrumentation-pg", importName: "PgInstrumentation" }]. The handler function getUsers still gets a manual span as a service entry point.
</notes>
</example>
</examples>`;

/**
 * Returns JavaScript-specific sections for the shared LLM instrumentation system prompt.
 * The coordinator merges these with language-agnostic sections in B2.
 */
export function getSystemPromptSections(): LanguagePromptSections {
  return {
    constraints: `- Your ONLY job is to add instrumentation. Do not refactor, rename, or restructure existing code.
- Do not change function signatures, parameter names, return types, or export declarations.
- Do not modify existing error handling (try/catch/finally blocks) except to wrap them in span lifecycle management.
- All OpenTelemetry imports must come from \`@opentelemetry/api\` only. Do not import from \`@opentelemetry/sdk-*\`, \`@opentelemetry/instrumentation-*\`, or any other \`@opentelemetry/*\` package.
- The \`instrumentedCode\` field must contain the complete file — not a diff, not a partial file. Files containing placeholder comments (\`// ...\`, \`// existing code\`, \`// rest of function\`, \`/* ... */\`) will be rejected by validation.
- Do not add comments explaining the instrumentation. The code speaks for itself.
- Do not add, modify, or duplicate JSDoc comments. Preserve existing JSDoc exactly as-is. If a function has a JSDoc block, keep it unchanged — do not regenerate or rewrite it.
- Do not add null/undefined checks around \`span.setAttribute()\` calls for values that are always defined. However, when accessing optional properties with \`?.\` (optional chaining), the result may be \`undefined\` — guard these with an \`if\` check before \`setAttribute\`:
  \`\`\`javascript
  // WRONG — entries?.length may be undefined
  span.setAttribute('result.count', entries?.length);

  // CORRECT — guard optional values with != null (covers both null and undefined)
  if (entries != null) {
    span.setAttribute('result.count', entries.length);
  }
  \`\`\`
- When guarding a variable before accessing its properties, always use \`!= null\` (loose inequality), not \`!== undefined\` (strict). \`!== undefined\` passes when the value is \`null\`, causing a TypeError on property access at runtime.
- **Do not modify the content of existing template literals.** If you need to capture a template literal value as a span attribute, add \`span.setAttribute()\` **after** the template literal assignment using the already-assigned variable — never inline a span context expression within the template expression itself.
  \`\`\`javascript
  // WRONG — modifies the template literal content, triggers NDS-003
  const systemContent = \`\${traceId}\n\${guidelines}\n\${sectionPrompt}\`;

  // CORRECT — capture the template literal value first, then set the attribute after
  const systemContent = \`\${guidelines}\n\${sectionPrompt}\`;
  span.setAttribute('ai.system_prompt', systemContent);
  \`\`\`
- **Return-value capture is allowed.** When you need to call \`setAttribute\` on a return value, you may extract the expression to a \`const\`:
  \`\`\`javascript
  // ALLOWED — capturing a value that exists and will be returned
  const result = computeResult();
  span.setAttribute('result.count', result.length);
  return result;
  \`\`\`
  This is the ONLY non-instrumentation code change the validator permits. Use it only for extracting a value that is already being returned so you can call \`setAttribute\` before returning it.

  Do NOT initialize new variables to accumulate data (e.g., \`const names = []\`, \`const count = 0\`). Every \`const\` you add must capture a value that already exists in the function — no new computation or accumulation is permitted.

  \`\`\`javascript
  // WRONG — initializing an accumulation variable (NDS-003 violation)
  const sectionNames = [];
  sections.forEach(s => sectionNames.push(s.name));
  span.setAttribute('sections', sectionNames.join(','));
  \`\`\`
- **Do not call string methods directly on property-access expressions.** When extracting a value for a span attribute, never assume an object field holds a string. Calling \`.split()\`, \`.slice()\`, \`.replace()\`, or similar string methods directly on \`obj.field\` will crash at runtime if the field is a \`Date\`, number, or other non-string type. When extracting a date string from a timestamp field, use \`new Date(value).toISOString().split('T')[0]\` — this handles both \`Date\` objects and ISO string inputs safely. For other fields, use \`String(value)\` to coerce explicitly.
  \`\`\`javascript
  // WRONG — crashes if commit.timestamp is a Date object
  span.setAttribute('date', commit.timestamp.split('T')[0]);

  // CORRECT — handles both Date objects and ISO strings
  span.setAttribute('date', new Date(commit.timestamp).toISOString().split('T')[0]);
  \`\`\``,

    tracerAcquisition: `Add \`const tracer = trace.getTracer('service-name');\` at module scope if not already present, replacing \`'service-name'\` with a stable identifier for this service. Use exactly this tracer name in every file — do not vary it. If a tracer variable is already declared, reuse it.`,

    spanCreation: `Wrap function bodies with \`tracer.startActiveSpan()\`:

\`\`\`javascript
export async function myFunction(params) {
  return tracer.startActiveSpan('my_service.operation_name', async (span) => {
    try {
      // original function body
      span.setAttribute('relevant.attribute', value);
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
\`\`\`

For functions with existing try/catch blocks, wrap the entire function body — preserve the existing error handling inside the try block and add OTel error recording at the top of the catch block.`,

    errorHandling: `Every catch block inside a span MUST have both \`span.recordException(error)\` AND \`span.setStatus({ code: SpanStatusCode.ERROR })\`. One without the other is incomplete:
- \`setStatus\` alone marks the span as errored but loses the stack trace and exception details.
- \`recordException\` alone attaches the exception event but doesn't change the span's status code.
- Using \`span.setAttribute('error', ...)\` instead is wrong — use the standard OTel error recording API.

**Exception — expected-condition catches (control flow):** If the original catch block is empty (\`catch {}\` or \`catch (_e) {}\`) or handles an expected condition (e.g., file-not-found ENOENT checks, optional feature detection, graceful fallback paths), do NOT add \`recordException\` or \`setStatus\`. These catches represent normal control flow, not errors. \`setStatus\` is a one-way latch — once set to ERROR, it cannot be changed back. Marking expected conditions as errors pollutes error metrics and triggers false alerts.`,

    otelPatterns: `### Auto-Instrumentation Library Detection (Path 1)

When a file imports a framework with an available auto-instrumentation library, record the library need in \`librariesNeeded\` instead of adding manual spans on those specific framework calls. A function may still receive a manual span as a service entry point even if it calls auto-instrumented libraries.

### What to Instrument (Priority Order)

1. **External calls** (DB queries, HTTP requests, gRPC calls, message queue operations) — highest diagnostic value
2. **Schema-defined spans** — a human decided these matter
3. **Service entry points** — exported async functions not already covered by priorities 1-2
4. **Skip everything else** — utilities, formatters, pure helpers, synchronous internals, functions under ~5 lines, type guards, simple data transformations

### Variable Shadowing

Before using variables named \`span\` or \`tracer\` in a scope, check if those names are already used locally. If a conflict exists, use \`otelSpan\` or \`otelTracer\` as the parameter name.

### Auto-Instrumentation Library Allowlist

These framework packages have trusted auto-instrumentation libraries. When detected in imports, record the library need in \`librariesNeeded\`.

**IMPORTANT**: Auto-instrumentation covers low-level framework calls (HTTP requests, DB queries, LLM API calls) but does NOT cover application-level orchestration logic. You should STILL add manual spans to functions that orchestrate these calls — the auto-instrumented calls become child spans of your manual spans, giving visibility into both the application flow and the framework internals.

**Core (@opentelemetry/auto-instrumentations-node):**
pg, mysql, mysql2, mongodb, redis, ioredis, express, fastify, koa, @hapi/hapi, @grpc/grpc-js, http, https, node:http, node:https, mongoose, kafkajs, pino

**OpenLLMetry (individual @traceloop/instrumentation-* packages):**
| Framework Import | Instrumentation Package | Import Name | Covers |
|---|---|---|---|
| @anthropic-ai/sdk | @traceloop/instrumentation-anthropic | AnthropicInstrumentation | API calls (messages.create). NOT application logic calling the SDK. |
| openai | @traceloop/instrumentation-openai | OpenAIInstrumentation | API calls (chat.completions.create). NOT application logic calling the SDK. |
| @aws-sdk/client-bedrock-runtime | @traceloop/instrumentation-bedrock | BedrockInstrumentation | Bedrock API calls. NOT application orchestration. |
| @google-cloud/vertexai | @traceloop/instrumentation-vertexai | VertexAIInstrumentation | Vertex AI API calls. NOT application orchestration. |
| cohere-ai | @traceloop/instrumentation-cohere | CohereInstrumentation | Cohere API calls. NOT application orchestration. |
| together-ai | @traceloop/instrumentation-together | TogetherInstrumentation | Together AI API calls. NOT application orchestration. |
| langchain / @langchain/* | @traceloop/instrumentation-langchain | LangChainInstrumentation | model.invoke(), chain.invoke() calls. NOT custom graph nodes, state transitions, or orchestration functions. |
| llamaindex | @traceloop/instrumentation-llamaindex | LlamaIndexInstrumentation | LlamaIndex query/retrieval calls. NOT application orchestration. |
| @modelcontextprotocol/sdk | @traceloop/instrumentation-mcp | MCPInstrumentation | MCP tool calls and protocol messages. NOT application handlers. |
| @pinecone-database/pinecone | @traceloop/instrumentation-pinecone | PineconeInstrumentation | Vector DB operations (upsert, query). NOT application logic. |
| chromadb | @traceloop/instrumentation-chromadb | ChromaDBInstrumentation | Vector DB operations. NOT application logic. |
| @qdrant/js-client-rest | @traceloop/instrumentation-qdrant | QdrantInstrumentation | Vector DB operations. NOT application logic. |`,

    libraryInstallation: `npm install @opentelemetry/api`,
  };
}

/**
 * Returns JavaScript instrumentation examples for the LLM system prompt.
 * Covers entry point spans, existing try/catch, already-instrumented skip,
 * variable shadowing, and auto-instrumentation library detection.
 */
export function getInstrumentationExamples(): Example[] {
  return [
    {
      description: 'Basic async function instrumentation',
      before: `import { Pool } from 'pg';

const pool = new Pool();

export async function getUsers(req, res) {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
}`,
      after: `import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Pool } from 'pg';

const pool = new Pool();
const tracer = trace.getTracer('my-service');

export async function getUsers(req, res) {
  return tracer.startActiveSpan('my_service.users.get_users', async (span) => {
    try {
      const result = await pool.query('SELECT * FROM users');
      span.setAttribute('db.row_count', result.rows.length);
      res.json(result.rows);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}`,
      notes: `librariesNeeded: [{ package: "@opentelemetry/instrumentation-pg", importName: "PgInstrumentation" }]
The handler gets a manual span as a service entry point. The pg.query call is covered by auto-instrumentation.`,
    },
    {
      description: 'Async function with existing try/catch',
      before: `import { readFile } from 'node:fs/promises';

export async function loadConfig(path) {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to load config:', error);
    throw new Error(\`Config load failed: \${error.message}\`);
  }
}`,
      after: `import { trace, SpanStatusCode } from '@opentelemetry/api';
import { readFile } from 'node:fs/promises';

const tracer = trace.getTracer('my-service');

export async function loadConfig(path) {
  return tracer.startActiveSpan('my_service.config.load_config', async (span) => {
    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      console.error('Failed to load config:', error);
      throw new Error(\`Config load failed: \${error.message}\`);
    } finally {
      span.end();
    }
  });
}`,
    },
    {
      description: 'Already instrumented — skip',
      before: `import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function handleRequest(req, res) {
  return tracer.startActiveSpan('my_service.requests.handle_request', async (span) => {
    try {
      const result = await processData(req.body);
      span.setAttribute('result.count', result.length);
      res.json(result);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      res.status(500).json({ error: error.message });
    } finally {
      span.end();
    }
  });
}`,
      after: `import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function handleRequest(req, res) {
  return tracer.startActiveSpan('my_service.requests.handle_request', async (span) => {
    try {
      const result = await processData(req.body);
      span.setAttribute('result.count', result.length);
      res.json(result);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      res.status(500).json({ error: error.message });
    } finally {
      span.end();
    }
  });
}`,
    },
    {
      description: 'Variable shadowing — use suffixed names',
      before: `export async function processSpan(data) {
  const span = data.timeSpan;
  const duration = span.end - span.start;
  return { duration, unit: 'ms' };
}`,
      after: `import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function processSpan(data) {
  return tracer.startActiveSpan('my_service.spans.process_span', async (otelSpan) => {
    try {
      const span = data.timeSpan;
      const duration = span.end - span.start;
      return { duration, unit: 'ms' };
    } catch (error) {
      otelSpan.recordException(error);
      otelSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      otelSpan.end();
    }
  });
}`,
    },
    {
      description: 'Auto-instrumentation library detection',
      before: `import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();

export async function getUsers(req, res) {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
}

app.get('/users', getUsers);`,
      after: `import { trace, SpanStatusCode } from '@opentelemetry/api';
import express from 'express';
import { Pool } from 'pg';

const app = express();
const pool = new Pool();
const tracer = trace.getTracer('my-service');

export async function getUsers(req, res) {
  return tracer.startActiveSpan('my_service.users.get_users', async (span) => {
    try {
      const result = await pool.query('SELECT * FROM users');
      span.setAttribute('db.row_count', result.rows.length);
      res.json(result.rows);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

app.get('/users', getUsers);`,
      notes: `Both express and pg have auto-instrumentation libraries. Recorded in librariesNeeded: [{ package: "@opentelemetry/instrumentation-express", importName: "ExpressInstrumentation" }, { package: "@opentelemetry/instrumentation-pg", importName: "PgInstrumentation" }]. The handler function getUsers still gets a manual span as a service entry point.`,
    },
  ];
}
