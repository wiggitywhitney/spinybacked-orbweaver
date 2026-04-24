// ABOUTME: TypeScript-specific prompt sections and instrumentation examples for the LLM agent.
// ABOUTME: Extends JavaScript patterns with TypeScript-specific constraints (type annotations, import type, unknown catch).

import type { LanguagePromptSections, Example } from '../types.ts';

/**
 * Returns TypeScript-specific sections for the shared LLM instrumentation system prompt.
 *
 * Key differences from the JavaScript prompt:
 * - Hard constraint: do not strip type annotations or change `import type` to `import`
 * - Error handling: TypeScript catch binding is `unknown` — requires `instanceof Error` narrowing
 * - Semconv: instruct LLM to use `ATTR_*` constants from `@opentelemetry/semantic-conventions`
 *   (not the deprecated `SEMATTRS_*` prefix) per Milestone C0 research findings
 */
export function getSystemPromptSections(): LanguagePromptSections {
  return {
    constraints: `- Your ONLY job is to add instrumentation. Do not refactor, rename, or restructure existing code.
- **Files with only re-exports and no local definitions** — If the file contains ONLY import statements and re-export expressions (\`export { foo } from './foo'\`, \`export * from './bar'\`, \`export const X = imported\`) with no locally defined functions, classes, or async logic, return the original file unchanged. Do NOT add tracer imports, spans, or any instrumentation code. Files that mix re-exports with local function definitions should still be instrumented for the local functions — this rule applies only to files that are entirely pass-through.
- **HARD CONSTRAINT — type annotations**: Do not strip, remove, or simplify any TypeScript type annotation. Every parameter type, return type, generic type parameter, and type assertion must be preserved exactly as-is.
- **HARD CONSTRAINT — import type**: Do not convert \`import type { Foo }\` to \`import { Foo }\`. Type-only imports must remain type-only. If you need to import a runtime value from the same module, add a separate \`import\` statement.
- **HARD CONSTRAINT — no \`any\`**: Do not introduce \`any\` as a type. If a type is unclear, use \`unknown\` and narrow it.
- Do not change function signatures, parameter names, return types, generic parameters, or access modifiers (public/private/protected/readonly).
- Do not modify existing error handling (try/catch/finally blocks) except to wrap them in span lifecycle management.
- All OpenTelemetry imports must come from \`@opentelemetry/api\` only. Do not import from \`@opentelemetry/sdk-*\`, \`@opentelemetry/instrumentation-*\`, or any other \`@opentelemetry/*\` package.
- The \`instrumentedCode\` field must contain the complete file — not a diff, not a partial file. Files containing placeholder comments (\`// ...\`, \`// existing code\`, \`// rest of function\`, \`/* ... */\`) will be rejected by validation.
- Do not add comments explaining the instrumentation. The code speaks for itself.
- Do not add, modify, or duplicate JSDoc comments. Preserve existing JSDoc exactly as-is.
- Do not add null/undefined checks around \`span.setAttribute()\` calls for values that are always defined. However, when accessing optional properties with \`?.\` (optional chaining), the result may be \`undefined\` — guard these with an \`if\` check before \`setAttribute\`:
  \`\`\`typescript
  // WRONG — entries?.length may be undefined
  span.setAttribute('result.count', entries?.length);

  // CORRECT — guard optional values with != null (covers both null and undefined)
  if (entries != null) {
    span.setAttribute('result.count', entries.length);
  }
  \`\`\`
- When guarding a variable before accessing its properties, always use \`!= null\` (loose inequality), not \`!== undefined\` (strict). \`!== undefined\` passes when the value is \`null\`, causing a TypeError on property access at runtime.
- **Do not call string methods directly on property-access expressions.** When extracting a value for a span attribute, never assume an object field holds a string. Calling \`.split()\`, \`.slice()\`, \`.replace()\`, or similar string methods directly on \`obj.field\` will crash at runtime if the field is a \`Date\`, number, or other non-string type. When extracting a date string from a timestamp field, use \`new Date(value).toISOString().split('T')[0]\` — this handles both \`Date\` objects and ISO string inputs safely. For other fields, use \`String(value)\` to coerce explicitly.
  \`\`\`typescript
  // WRONG — crashes if commit.timestamp is a Date object
  span.setAttribute('date', commit.timestamp.split('T')[0]);

  // CORRECT — handles both Date objects and ISO strings
  span.setAttribute('date', new Date(commit.timestamp).toISOString().split('T')[0]);
  \`\`\`
- **Return-value capture is allowed.** When you need to call \`setAttribute\` on a return value, you may extract the expression to a \`const\`:
  \`\`\`typescript
  // Original: return computeResult();
  // Allowed:
  const result = computeResult();
  span.setAttribute('result.count', result.length);
  return result;
  \`\`\`
  This is the ONLY non-instrumentation code change the validator permits.
- **Semantic conventions — use typed constants.** When setting span attributes with known semantic convention names, import and use the typed constants from \`@opentelemetry/semantic-conventions\`:
  \`\`\`typescript
  import { ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_DB_SYSTEM_NAME } from '@opentelemetry/semantic-conventions';
  \`\`\`
  Do NOT use the deprecated \`SEMATTRS_*\` prefix (e.g., \`SEMATTRS_HTTP_METHOD\`) — these carry old attribute string values. Do NOT use raw strings like \`'db.system'\` — use \`ATTR_DB_SYSTEM_NAME\` (note: the attribute is \`db.system.name\`, not \`db.system\`). For RPC and messaging attributes (which are incubating), import from \`@opentelemetry/semantic-conventions/incubating\` in a separate import statement.`,

    tracerAcquisition: `Add \`const tracer = trace.getTracer('service-name');\` at module scope if not already present, replacing \`'service-name'\` with a stable identifier for this service. Use exactly this tracer name in every file — do not vary it. If a tracer variable is already declared, reuse it.`,

    spanCreation: `**Critical TypeScript constraint — match the callback's async keyword to the function being wrapped:**
- \`async function\` → use \`async (span) => { ... }\` — callback returns \`Promise<T>\`, matches.
- Synchronous \`function\` → use \`(span) => { ... }\` — callback is NOT async, returns \`T\` directly.

Do NOT use \`async (span) => { ... }\` for a synchronous function. TypeScript will reject it: \`async\` makes the callback return \`Promise<void>\` while the function signature expects \`void\`, producing a type error that fails \`tsc\`.

Correct form for an async entry point:
\`\`\`typescript
export async function myFunction(params: ParamType): Promise<ReturnType> {
  return tracer.startActiveSpan('my_service.operation_name', async (span) => {
    try {
      // original function body
      span.setAttribute('relevant.attribute', value);
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
\`\`\`

Correct form for a synchronous entry point that returns a value:
\`\`\`typescript
export function processItems(items: Item[]): ProcessResult {
  return tracer.startActiveSpan('my_service.process', (span) => {
    try {
      // original body
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
\`\`\`

Correct form for a synchronous \`void\` entry point:
\`\`\`typescript
export function handleEvent(event: Event): void {
  tracer.startActiveSpan('my_service.handle_event', (span) => {
    try {
      // original body
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
  // void functions do not return the span result — the startActiveSpan call stands alone
}
\`\`\`

For synchronous functions that return \`void\` AND perform only pure in-memory computation (no I/O, no network, no database calls) — RST-001 (No Utility Spans) applies. Skip them; do not instrument.

For functions with existing try/catch blocks, wrap the entire function body — preserve the existing error handling inside the try block and add OTel error recording at the top of the catch block.`,

    errorHandling: `TypeScript catch bindings are typed as \`unknown\` (not \`any\`). Before calling \`span.recordException(error)\`, the error must be a valid value — \`span.recordException\` accepts \`Error | string | Attributes\`. Use this pattern:

\`\`\`typescript
catch (error) {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR });
  // existing catch body unchanged
  throw error;
}
\`\`\`

Every catch block inside a span MUST have both \`span.recordException\` AND \`span.setStatus({ code: SpanStatusCode.ERROR })\`. One without the other is incomplete:
- \`setStatus\` alone marks the span as errored but loses the stack trace.
- \`recordException\` alone attaches the exception event but doesn't change the span's status code.

**Exception — expected-condition catches (control flow):** If the original catch block is empty or handles an expected condition (e.g., ENOENT checks, optional feature detection, graceful fallback paths), do NOT add \`recordException\` or \`setStatus\`. These catches represent normal control flow, not errors.`,

    otelPatterns: `### Auto-Instrumentation Library Detection (Path 1)

When a file imports a framework with an available auto-instrumentation library, record the library need in \`librariesNeeded\` instead of adding manual spans on those specific framework calls. A function may still receive a manual span as a service entry point even if it calls auto-instrumented libraries.

### What to Instrument (Priority Order)

1. **External calls** (DB queries, HTTP requests, gRPC calls, message queue operations) — highest diagnostic value
2. **Schema-defined spans** — a human decided these matter
3. **Service entry points** — exported async functions not already covered by priorities 1-2
4. **Skip everything else** — utilities, formatters, pure helpers, synchronous internals, functions under ~5 lines, type guards, simple data transformations

### TypeScript-Specific Entry Point Detection

In TypeScript/NestJS codebases, controller methods decorated with \`@Get\`, \`@Post\`, \`@Put\`, \`@Delete\`, \`@Patch\`, or similar route decorators are entry points and should receive spans. Preserve all decorators exactly — do not remove or modify them.

### Variable Shadowing

Before using variables named \`span\` or \`tracer\` in a scope, check if those names are already used locally. If a conflict exists, use \`otelSpan\` or \`otelTracer\` as the parameter name.

### Auto-Instrumentation Library Allowlist

These framework packages have trusted auto-instrumentation libraries. When detected in imports, record the library need in \`librariesNeeded\`.

**Core (@opentelemetry/auto-instrumentations-node):**
pg, mysql, mysql2, mongodb, redis, ioredis, express, fastify, koa, @hapi/hapi, @grpc/grpc-js, http, https, node:http, node:https, mongoose, kafkajs, pino

**OpenLLMetry (individual @traceloop/instrumentation-* packages):**
@anthropic-ai/sdk, openai, @aws-sdk/client-bedrock-runtime, @google-cloud/vertexai, cohere-ai, langchain, llamaindex, @modelcontextprotocol/sdk, @pinecone-database/pinecone, chromadb, @qdrant/js-client-rest`,

    libraryInstallation: `npm install @opentelemetry/api @opentelemetry/semantic-conventions`,
  };
}

/**
 * Returns TypeScript instrumentation examples for the LLM system prompt.
 *
 * Covers:
 * 1. Async function with type annotations (basic case)
 * 2. Class method with NestJS decorator (TypeScript-specific entry point)
 * 3. Generic function (verify type parameters are preserved)
 * 4. Function with import type dependencies
 * 5. TSX React component handler
 */
export function getInstrumentationExamples(): Example[] {
  return [
    {
      description: 'Async function with type annotations',
      before: `import { Pool } from 'pg';

const pool = new Pool();

export async function getUsers(req: Request, res: Response): Promise<void> {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
}`,
      after: `import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Pool } from 'pg';

const pool = new Pool();
const tracer = trace.getTracer('my-service');

export async function getUsers(req: Request, res: Response): Promise<void> {
  return tracer.startActiveSpan('my_service.users.get_users', async (span) => {
    try {
      const result = await pool.query('SELECT * FROM users');
      span.setAttribute('db.row_count', result.rows.length);
      res.json(result.rows);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}`,
      notes: `Type annotations on parameters (Request, Response) and return type (Promise<void>) are preserved exactly. The pg.query call is covered by auto-instrumentation: librariesNeeded: [{ package: "@opentelemetry/instrumentation-pg", importName: "PgInstrumentation" }]`,
    },
    {
      description: 'NestJS controller method with route decorator',
      before: `import { Controller, Get, Param } from '@nestjs/common';
import type { UserService } from './user.service.ts';

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get(':id')
  async getUser(@Param('id') id: string): Promise<User> {
    return this.userService.findById(id);
  }
}`,
      after: `import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Controller, Get, Param } from '@nestjs/common';
import type { UserService } from './user.service.ts';

const tracer = trace.getTracer('my-service');

@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get(':id')
  async getUser(@Param('id') id: string): Promise<User> {
    return tracer.startActiveSpan('my_service.users.get_user', async (span) => {
      try {
        span.setAttribute('user.id', id);
        return this.userService.findById(id);
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}`,
      notes: `All decorators (@Controller, @Get, @Param) are preserved. The class decorator and class structure are unchanged. Type annotations (string, Promise<User>) are preserved. The import type statement remains type-only.`,
    },
    {
      description: 'Generic function — type parameters preserved',
      before: `export async function fetchResource<T extends { id: string }>(
  url: string,
  transform: (raw: unknown) => T,
): Promise<T> {
  const response = await fetch(url);
  const data = await response.json();
  return transform(data);
}`,
      after: `import { trace, SpanStatusCode } from '@opentelemetry/api';
import { ATTR_URL_FULL, ATTR_HTTP_RESPONSE_STATUS_CODE } from '@opentelemetry/semantic-conventions';

const tracer = trace.getTracer('my-service');

export async function fetchResource<T extends { id: string }>(
  url: string,
  transform: (raw: unknown) => T,
): Promise<T> {
  return tracer.startActiveSpan('my_service.resources.fetch_resource', async (span) => {
    try {
      span.setAttribute(ATTR_URL_FULL, url);
      const response = await fetch(url);
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);
      const data = await response.json();
      return transform(data);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}`,
      notes: `Generic type parameter <T extends { id: string }> is preserved exactly. The constraint and transform parameter type are unchanged. Uses stable ATTR_URL_FULL and ATTR_HTTP_RESPONSE_STATUS_CODE constants from @opentelemetry/semantic-conventions.`,
    },
    {
      description: 'Function with import type dependencies',
      before: `import type { DatabaseConfig } from '../config/types.ts';
import { createPool } from 'pg';

export async function initializeDatabase(config: DatabaseConfig): Promise<void> {
  const pool = createPool(config);
  await pool.query('SELECT 1');
  return;
}`,
      after: `import { trace, SpanStatusCode } from '@opentelemetry/api';
import { ATTR_DB_SYSTEM_NAME, DB_SYSTEM_NAME_VALUE_POSTGRESQL } from '@opentelemetry/semantic-conventions';
import type { DatabaseConfig } from '../config/types.ts';
import { createPool } from 'pg';

const tracer = trace.getTracer('my-service');

export async function initializeDatabase(config: DatabaseConfig): Promise<void> {
  return tracer.startActiveSpan('my_service.database.initialize_database', async (span) => {
    try {
      span.setAttribute(ATTR_DB_SYSTEM_NAME, DB_SYSTEM_NAME_VALUE_POSTGRESQL);
      const pool = createPool(config);
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}`,
      notes: `import type stays as import type — not converted to a regular import. Uses ATTR_DB_SYSTEM_NAME (not the deprecated db.system) and the stable DB_SYSTEM_NAME_VALUE_POSTGRESQL enum value. The DatabaseConfig parameter type annotation is preserved.`,
    },
    {
      description: 'TSX React component — event handler with data fetch',
      before: `import type { FormEvent } from 'react';
import { useState } from 'react';

interface LoginProps {
  onSuccess: (userId: string) => void;
}

export async function handleLogin(event: FormEvent, email: string): Promise<string> {
  event.preventDefault();
  const response = await fetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  const data = await response.json() as { userId: string };
  return data.userId;
}`,
      after: `import { trace, SpanStatusCode } from '@opentelemetry/api';
import { ATTR_HTTP_REQUEST_METHOD, ATTR_URL_FULL, ATTR_HTTP_RESPONSE_STATUS_CODE } from '@opentelemetry/semantic-conventions';
import type { FormEvent } from 'react';
import { useState } from 'react';

const tracer = trace.getTracer('my-service');

interface LoginProps {
  onSuccess: (userId: string) => void;
}

export async function handleLogin(event: FormEvent, email: string): Promise<string> {
  return tracer.startActiveSpan('my_service.auth.handle_login', async (span) => {
    try {
      event.preventDefault();
      span.setAttribute(ATTR_HTTP_REQUEST_METHOD, 'POST');
      span.setAttribute(ATTR_URL_FULL, '/api/login');
      const response = await fetch('/api/login', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, response.status);
      const data = await response.json() as { userId: string };
      return data.userId;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}`,
      notes: `import type { FormEvent } stays as import type. The interface declaration (LoginProps) is unchanged. The type assertion (as { userId: string }) is preserved. Uses stable ATTR_* constants.`,
    },
  ];
}
