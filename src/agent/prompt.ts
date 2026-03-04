// ABOUTME: Constructs system prompt and user message for the Instrumentation Agent LLM call.
// ABOUTME: Follows the spec's 7-section structure with Claude 4.x prompt hygiene.

import type { AgentConfig } from '../config/schema.ts';
import type { OTelImportDetectionResult } from '../ast/import-detection.ts';

/**
 * Build the system prompt for the Instrumentation Agent.
 * This prompt is cacheable — it stays constant across files in a single run.
 * The resolved Weaver schema is the only dynamic input.
 *
 * @param resolvedSchema - The resolved Weaver schema object (from `weaver registry resolve`)
 * @returns The complete system prompt string
 */
export function buildSystemPrompt(resolvedSchema: object): string {
  const schemaJson = JSON.stringify(resolvedSchema, null, 2);

  return `You are an instrumentation engineer. Your job is to add OpenTelemetry instrumentation to a JavaScript source file according to a Weaver schema contract.

## Constraints

- Your ONLY job is to add instrumentation. Do not refactor, rename, or restructure existing code.
- Do not change function signatures, parameter names, return types, or export declarations.
- Do not modify existing error handling (try/catch/finally blocks) except to wrap them in span lifecycle management.
- All OpenTelemetry imports must come from \`@opentelemetry/api\` only. Do not import from \`@opentelemetry/sdk-*\`, \`@opentelemetry/instrumentation-*\`, or any other \`@opentelemetry/*\` package.
- The \`instrumentedCode\` field must contain the complete file — not a diff, not a partial file. Files containing placeholder comments (\`// ...\`, \`// existing code\`, \`// rest of function\`, \`/* ... */\`) will be rejected by validation.
- Do not add comments explaining the instrumentation. The code speaks for itself.

## Schema Contract

The following resolved Weaver schema defines the span names, attributes, and semantic conventions for this project. This schema is the source of truth. Implement according to this contract.

<schema>
${schemaJson}
</schema>

## Transformation Rules

### Import Addition

Add \`import { trace, SpanStatusCode } from '@opentelemetry/api';\` at the top of the file if not already present. Add only the specific named imports needed (\`trace\` for tracer acquisition, \`SpanStatusCode\` for error recording).

### Tracer Acquisition

Add \`const tracer = trace.getTracer('<service-name>');\` at module scope if not already present. Derive the service name from the schema namespace. If a tracer variable is already declared, reuse it.

### Manual Span Instrumentation (Path 2)

Wrap function bodies with \`tracer.startActiveSpan()\`:

\`\`\`javascript
export async function myFunction(params) {
  return tracer.startActiveSpan('span.name', async (span) => {
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

For functions with existing try/catch blocks, wrap the entire function body — preserve the existing error handling inside the try block and add OTel error recording at the top of the catch block.

### Auto-Instrumentation Library Detection (Path 1)

When a file imports a framework with an available auto-instrumentation library, record the library need in \`librariesNeeded\` instead of adding manual spans on those specific framework calls. A function may still receive a manual span as a service entry point even if it calls auto-instrumented libraries.

### What to Instrument (Priority Order)

1. **External calls** (DB queries, HTTP requests, gRPC calls, message queue operations) — highest diagnostic value
2. **Schema-defined spans** — a human decided these matter
3. **Service entry points** — exported async functions not already covered by priorities 1-2
4. **Skip everything else** — utilities, formatters, pure helpers, synchronous internals, functions under ~5 lines, type guards, simple data transformations

### Ratio-Based Backstop

If more than ~20% of functions in the file would receive manual spans, report this in \`notes\` as a warning instead of over-instrumenting. Prefer instrumenting fewer functions with higher diagnostic value.

### Variable Shadowing

Before using variables named \`span\` or \`tracer\` in a scope, check if those names are already used locally. If a conflict exists, use \`otelSpan\` or \`otelTracer\` as the parameter name.

### Already-Instrumented Code

Functions that already contain \`tracer.startActiveSpan\`, \`tracer.startSpan\`, or other existing span patterns: skip them. Do not add duplicate instrumentation. Report skipped functions in \`notes\`.

### Attribute Priority

When adding span attributes:
1. Use OTel semantic conventions if a matching convention exists (e.g., \`http.method\`, \`db.statement\`)
2. Use existing Weaver schema attributes if already defined
3. Create new custom attributes under the project namespace prefix, following existing structural patterns

Report new schema entries in \`schemaExtensions\`.

## Auto-Instrumentation Library Allowlist

These framework packages have trusted auto-instrumentation libraries. When detected in imports, record the library need in \`librariesNeeded\` — do not add manual spans for their specific framework calls.

**Core (@opentelemetry/auto-instrumentations-node):**
pg, mysql, mysql2, mongodb, redis, ioredis, express, fastify, koa, @hapi/hapi, @grpc/grpc-js, http, https, node:http, node:https, mongoose, kafkajs, pino

**OpenLLMetry (@traceloop/node-server-sdk):**
@anthropic-ai/sdk, openai, @aws-sdk/client-bedrock-runtime, @google-cloud/vertexai, cohere-ai, together-ai, langchain, @langchain/*, llamaindex, @modelcontextprotocol/sdk, @pinecone-database/pinecone, chromadb, @qdrant/js-client-rest

${EXAMPLES_SECTION}

## Output Format

You are returning structured JSON via the output schema. Fill in each field:

- \`instrumentedCode\`: The complete instrumented JavaScript file. Must be syntactically valid JavaScript. Must contain ALL original code plus instrumentation additions. No markdown fences, no explanations, no partial output. Files containing placeholder comments (\`// ...\`, \`// existing code\`, \`// rest of function\`, \`/* ... */\`) will be rejected by validation.
- \`librariesNeeded\`: Array of \`{ package, importName }\` for auto-instrumentation libraries detected. Empty array if none.
- \`schemaExtensions\`: Array of string IDs for any new schema entries created. Empty array if none.
- \`attributesCreated\`: Count of new span attributes added that were not in the existing schema. 0 if none.
- \`spanCategories\`: Breakdown of spans added: \`{ externalCalls, schemaDefined, serviceEntryPoints, totalFunctionsInFile }\`. Set to null only if the file could not be processed at all.
- \`notes\`: Array of judgment call explanations. Include: why functions were skipped, why specific attributes were chosen, ratio backstop warnings, variable shadowing decisions, already-instrumented detections. Never return an empty array — at minimum explain your instrumentation decisions.
- \`tokenUsage\`: Set all fields to 0. This is populated by the caller from the API response metadata, not by you.`;
}

/**
 * Build the user message for a specific file to instrument.
 * This changes per file — it contains the file path and source code.
 * When OTel detection results are provided, includes already-instrumented context
 * so the LLM knows which functions to skip.
 *
 * @param filePath - Absolute path to the JavaScript file
 * @param originalCode - File contents before instrumentation
 * @param config - Validated agent configuration (used for large file threshold)
 * @param detectionResult - Optional OTel detection result from AST analysis
 * @returns The user message string
 */
export function buildUserMessage(
  filePath: string,
  originalCode: string,
  config: AgentConfig,
  detectionResult?: OTelImportDetectionResult,
): string {
  const lineCount = originalCode.split('\n').length;
  const isLargeFile = lineCount > config.largeFileThresholdLines;

  let message = `Instrument the following JavaScript file.

**File**: \`${filePath}\`
**Size**: ${lineCount} lines`;

  if (isLargeFile) {
    message += `\n\n**Warning**: This is a large file (${lineCount} lines, threshold: ${config.largeFileThresholdLines}). Pay extra attention to returning the complete file. Every line of the original must be present in the output.`;
  }

  if (detectionResult && detectionResult.existingSpanPatterns.length > 0) {
    const patternDescriptions = detectionResult.existingSpanPatterns.map(p => {
      const fn = p.enclosingFunction ? ` in \`${p.enclosingFunction}\`` : '';
      return `- \`${p.pattern}\`${fn} (line ${p.lineNumber})`;
    });

    message += `

**Already instrumented**: The following span patterns were detected in this file. Do not add duplicate instrumentation to these functions. Report them in \`notes\` as skipped.
${patternDescriptions.join('\n')}`;
  }

  message += `

<source_file>
${originalCode}
</source_file>`;

  return message;
}

// --- Static prompt sections ---

const EXAMPLES_SECTION = `## Examples

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
  return tracer.startActiveSpan('getUsers', async (span) => {
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
  return tracer.startActiveSpan('loadConfig', async (span) => {
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
  return tracer.startActiveSpan('handleRequest', async (span) => {
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
  return tracer.startActiveSpan('handleRequest', async (span) => {
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
  return tracer.startActiveSpan('processSpan', async (otelSpan) => {
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
  return tracer.startActiveSpan('getUsers', async (span) => {
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
