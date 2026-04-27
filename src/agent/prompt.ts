// ABOUTME: Constructs system prompt and user message for the Instrumentation Agent LLM call.
// ABOUTME: Follows the spec's 7-section structure with Claude 4.x prompt hygiene.

import type { AgentConfig } from '../config/schema.ts';
import type { LanguageProvider, Example, InstrumentationDetectionResult, PreScanResult } from '../languages/types.ts';

/**
 * Format a list of instrumentation examples into the XML block used in the system prompt.
 *
 * @param examples - Examples from provider.getInstrumentationExamples()
 * @returns Formatted `## Examples` section string
 */
function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatExamplesSection(examples: Example[]): string {
  const formatted = examples.map((ex, i) => {
    const notesPart = ex.notes
      ? `\n<notes>\n${ex.notes.replace(/&/g, '&amp;').replace(/</g, '&lt;')}\n</notes>`
      : '';
    return `<example id="${i + 1}" title="${escapeXmlAttr(ex.description)}">
<before>
${ex.before}
</before>
<after>
${ex.after}
</after>${notesPart}
</example>`;
  }).join('\n\n');

  return `## Examples

<examples>
${formatted}
</examples>`;
}

/**
 * Extract all unique attribute names from a resolved schema object.
 * Mirrors the logic in registry-types.ts getAllAttributeNames without
 * importing validation-layer types into the prompt module.
 */
function extractAttributeNames(schema: object): string[] {
  const groups = (schema as Record<string, unknown>).groups;
  if (!Array.isArray(groups)) return [];
  const names = new Set<string>();
  for (const group of groups) {
    if (group == null || typeof group !== 'object') continue;
    const attrs = (group as Record<string, unknown>).attributes;
    if (!Array.isArray(attrs)) continue;
    for (const attr of attrs) {
      if (attr == null || typeof attr !== 'object') continue;
      const name = (attr as Record<string, unknown>).name;
      if (typeof name === 'string') names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Build the system prompt for the Instrumentation Agent.
 *
 * This prompt is cacheable — it stays constant across files in a single run.
 * The resolved Weaver schema and language provider are the only dynamic inputs.
 *
 * @param resolvedSchema - The resolved Weaver schema object (from `weaver registry resolve`)
 * @param projectName - Optional project name used as tracer name fallback when schema namespace is absent
 * @param provider - Language provider supplying language-specific prompt sections and examples
 * @returns The complete system prompt string
 */
export function buildSystemPrompt(
  resolvedSchema: object,
  projectName: string | undefined,
  provider: LanguageProvider,
): string {
  const activeProvider = provider;
  const sections = activeProvider.getSystemPromptSections();
  const examples = activeProvider.getInstrumentationExamples();

  const schemaJson = JSON.stringify(resolvedSchema, null, 2);
  const rawNamespace = (resolvedSchema as Record<string, unknown>).namespace;
  const tracerName =
    typeof rawNamespace === 'string' && rawNamespace.trim().length > 0
      ? rawNamespace
      : (projectName ?? 'unknown_service');
  const tracerNameLiteral = JSON.stringify(tracerName);
  const attributeNames = extractAttributeNames(resolvedSchema);

  return `You are an instrumentation engineer. Your job is to add OpenTelemetry instrumentation to a ${activeProvider.displayName} source file according to a Weaver schema contract.

## Constraints

${sections.constraints}

## Schema Contract

The following resolved Weaver schema defines the span names, attributes, and semantic conventions for this project. This schema is the source of truth. Implement according to this contract.

<schema>
${schemaJson}
</schema>

## Transformation Rules

### Import Addition

Add \`import { trace, SpanStatusCode } from '@opentelemetry/api';\` at the top of the file if not already present. Add only the specific named imports needed (\`trace\` for tracer acquisition, \`SpanStatusCode\` for error recording).

### Tracer Acquisition

Add \`const tracer = trace.getTracer(${tracerNameLiteral});\` at module scope if not already present. Use exactly this tracer name in every file — do not vary it. If a tracer variable is already declared, reuse it.

### Manual Span Instrumentation (Path 2)

${sections.spanCreation}

### Error Handling

${sections.errorHandling}

### Span Naming

When choosing a span name for \`tracer.startActiveSpan()\`:

1. **Check the schema first.** Look at groups with \`"type": "span"\` in the schema above. Each has an \`id\` field like \`span.my_service.operation_name\`. **Strip the \`span.\` prefix** — the \`span.\` is a Weaver registry convention, not part of the runtime span name. Use just \`my_service.operation_name\` in \`tracer.startActiveSpan()\`. Schema-defined names are authoritative — a human decided what these operations should be called.
2. **Invent a name only if no schema span matches.** All invented span names MUST start with the schema's namespace prefix (the first segment of existing span names, e.g., \`commit_story\`). Use \`<namespace>.<category>.<operation>\` format. Do NOT invent new top-level prefixes — \`context.gather\`, \`mcp.start\`, \`summary.generate\` are wrong; \`commit_story.context.gather\`, \`commit_story.mcp.start\`, \`commit_story.summary.generate\` are correct.
3. **Report new span names in \`schemaExtensions\`.** Any span name not already in the schema is a schema extension. Use dot-separated format: \`span.<namespace>.<category>.<name>\`. Do NOT use colons — \`span:foo.bar\` is invalid; \`span.foo.bar\` is correct.

### Ratio-Based Backstop

If more than ~20% of functions in the file would receive manual spans, report this in \`notes\` as a warning instead of over-instrumenting. Prefer instrumenting fewer functions with higher diagnostic value.

${sections.otelPatterns}

### Already-Instrumented Code

Functions that already contain \`tracer.startActiveSpan\`, \`tracer.startSpan\`, or other existing span patterns: skip them. Do not add duplicate instrumentation. Report skipped functions in \`notes\`.

### Attribute Priority

When adding span attributes, you MUST exhaust registered keys before inventing new ones. Unregistered attribute keys reduce schema fidelity and make telemetry difficult to query consistently.

1. **OTel semantic conventions first**: Use a matching convention if one exists (e.g., \`http.method\`, \`db.statement\`)
2. **Weaver schema attributes second**: Check ALL registered attribute keys in the schema for semantic equivalence — not just exact name matches. A registered key that captures the same concept under a different name is the correct choice.
3. **Invent only as a last resort**: Create new custom attributes under the project namespace prefix ONLY when no registered key fits. In \`schemaExtensions\`, include a rationale for why no existing key matched — this helps humans review and promote useful extensions into the registry.
${attributeNames.length > 0 ? `
**Registered attribute keys from this project's schema** (prefer these — unregistered keys trigger SCH-002 rejection unless reported as a schemaExtension):
${attributeNames.map(n => `\`${n}\``).join(', ')}
` : ''}
Report ALL new schema entries in \`schemaExtensions\`. For each extension, explain in \`notes\` why no existing key was a semantic match.

### Schema-Uncovered Files (COV-005)

When a file has NO registry-defined attributes for its spans, you MUST still add contextual attributes. **A span with zero attributes is a COV-005 violation** — it provides no diagnostic value beyond existence. Derive 1-2 domain-relevant attributes per span from:
- **Function parameters**: Input values that identify the operation (IDs, paths, names, counts). Example: \`span.setAttribute('config.path', path)\` for a config-loading function.
- **Return values**: Output characteristics that aid debugging (result counts, status indicators, sizes). Example: \`span.setAttribute('result.count', items.length)\`.
- **Service metadata**: For server/entry-point spans, include \`service.name\` or transport type.

Every span MUST have at least one \`setAttribute\` call. Even without registry guidance, function signatures reveal what data matters.

### Attribute Type Safety

OpenTelemetry attributes must be primitive types: string, number, boolean, or arrays of these. Do NOT pass objects directly to \`span.setAttribute()\`. Common violations:
- **Date objects**: Convert to ISO strings with \`.toISOString()\` before setting (e.g., \`span.setAttribute('task.created_at', date.toISOString())\`)
- **Objects/Maps**: Extract specific primitive fields instead of passing the whole object
- **Arrays of objects**: Map to arrays of primitive values first

## Scoring Checklist

Your output is scored against these rules. Violating gate rules causes immediate rejection and retry. Quality rules affect the instrumentation score.

### Gate Rules (violation = rejection)

- **NDS-001**: Output must be syntactically valid ${activeProvider.displayName}
- **NDS-002**: Pre-existing tests must still pass after your changes
- **NDS-003**: Do NOT modify, remove, or reorder any non-instrumentation code. Only add instrumentation. Removing original code — including try/catch blocks, conditionals, or any other lines you did not write — causes immediate rejection, even if the removed code appears "redundant" or conflicts with your instrumentation approach. Valid instrumentation never requires removing original code. If your approach requires removing something, the approach is wrong — ADD instrumentation that works within the existing structure instead.

  **Return-value capture exception**: When you need \`span.setAttribute()\` to receive a return value, you may rewrite \`return asyncExpr\` as \`const result = await asyncExpr; span.setAttribute('attr.name', result.field); return result;\`. Rules: (1) the original call expression must be preserved exactly — only the statement form changes from \`return\` to \`const … = await\`; (2) the captured variable must be immediately used in a \`span.setAttribute()\` call before the \`return\`; (3) do NOT use this for synchronous expressions or to restructure multi-statement returns or chains.
- **API-001**: Import only from \`@opentelemetry/api\`. No SDK, exporter, or instrumentation-* imports.
- **NDS-006**: Match the target project's module system. ESM project → ESM imports. CJS project → require().

### Non-Destructiveness

- **NDS-004**: Do NOT change exported function signatures — parameters, return types, or export declarations.
- **NDS-005**: Do NOT restructure existing try/catch/finally blocks, reorder catch clauses, or change throw behavior. When adding a span wrapper, all original try/catch blocks must survive intact — either as the outer structure (with \`span.end()\` added to their finally) or as nested blocks inside the outer span try. Never remove or merge an inner try/catch to simplify the span wrapper structure.

  **Pattern A — original try/catch becomes the outer wrapper** (add \`span.end()\` to its finally):
  \`\`\`js
  tracer.startActiveSpan('op', async (span) => {
    try {
      // original try body — unchanged
    } catch (err) {
      // original catch body — unchanged
    } finally {
      span.end(); // only addition
    }
  });
  \`\`\`

  **Pattern B — wrapping a function that has inner try/catch blocks** (keep them nested inside):
  \`\`\`js
  tracer.startActiveSpan('op', async (span) => {
    try {
      // ... other original code ...
      try {           // inner try/catch preserved exactly as-is
        const result = await someOp();
      } catch (err) {
        // original catch body — unchanged, even if it's a graceful-degradation catch
      }
      // ... more original code ...
    } finally {
      span.end();
    }
  });
  \`\`\`
- **NDS-007**: Do NOT add \`recordException()\` or \`setStatus(ERROR)\` to catch blocks that handle expected conditions gracefully — catch blocks that return a default value, return empty, or swallow the error without propagating it. These are graceful-degradation catches, not failures. Adding error recording to them creates false alerts. When in doubt: if the original catch does not propagate the error (no \`throw\`, no \`next(err)\`, no \`reject(err)\`, no \`return Promise.reject(err)\`), do not add error recording to it.

### Coverage

- **COV-001**: Entry points (route handlers, request handlers, CLI entry points, main functions, top-level dispatchers, exported async service functions) MUST have spans. Every application has at least one root span — CLI apps should have a root span on the main/entry function. **Root span requirements override RST-003 thin-wrapper exclusions** — a main() function that delegates to another function still needs a span. **COV-001 takes priority over RST-006** — when a function is both an async entry point and calls \`process.exit()\` directly, add the span. Use the minimal wrapper only: \`startActiveSpan → try { original body } finally { span.end() }\`. Do NOT add \`span.end()\` before individual \`process.exit()\` calls (NDS-005 violation). Do NOT declare new intermediate variables for \`setAttribute\` (NDS-003 violation). Use only variables already in scope.
- **COV-002**: Outbound calls (DB queries, HTTP requests, gRPC, message queues) MUST have spans.
- **COV-003**: Every failable operation inside a span MUST have error recording (\`recordException\` + \`setStatus\`).
- **COV-004**: Long-running or async I/O operations should have spans. When multiple sibling functions share the same structure (e.g., async functions that receive state, call an LLM, and return state), instrument ALL of them consistently — do not instrument some and skip others. **Context propagation is NOT a valid COV-004 exemption for exported async functions.** Each exported async function must have its own span, even if called from within an instrumented parent. The only valid reason to skip an exported async function under COV-004 is RST-001 (it is synchronous with no I/O). **Exception — \`process.exit()\` functions: if the function calls \`process.exit()\` directly in its body (not only inside catch or finally blocks), do not add a span — \`process.exit()\` bypasses the span's \`finally\` block; instrument the async sub-operations inside it instead (RST-006).** RST-004 applies only to unexported functions and does not exempt exported ones.
- **COV-005**: Use registry-defined attributes when the schema defines them for a span.
- **COV-006**: Prefer auto-instrumentation libraries over manual spans for supported frameworks. Do NOT manually wrap calls that a library already covers.

### Restraint

- **RST-001**: Do NOT add spans to pure synchronous data transformations (no I/O, no async, no network/disk access) regardless of export status — especially when called from a parent that already has a span. Being exported does not make a function instrumentable.
- **RST-002**: Do NOT add spans to trivial accessors (getters/setters, single-property returns).
- **RST-003**: Do NOT add spans to thin wrappers (single return delegating to another function).
- **RST-004**: Do NOT add spans to unexported internal functions. **RST-004 takes precedence over COV-004**: when an exported function orchestrates unexported helpers that perform I/O, instrument the exported orchestrator, not the helpers. The helpers' I/O becomes child spans of the orchestrator's span through context propagation. Only instrument an unexported I/O function when no exported orchestrator span covers that execution path.
- **RST-005**: Do NOT add instrumentation to functions that already have spans (\`startActiveSpan\`, \`startSpan\`, \`tracer.\`).
- **RST-006**: Do NOT add a span to an async function that calls \`process.exit()\` directly in its body. \`process.exit()\` bypasses the span's \`finally\` block, causing the span to leak at runtime and never export. Instrument the async sub-operations inside such functions instead. (Exception: if \`process.exit()\` appears only inside a \`catch\` or \`finally\` block, the function is not exempt from COV-004 and should still be spanned on the happy path.) **When RST-006 conflicts with COV-001 (the function is an async entry point), COV-001 wins — see COV-001.**

### API-Only Dependency

- **API-002**: \`@opentelemetry/api\` must be a peerDependency (libraries) or dependency (applications).
- **API-004**: Do NOT import from \`@opentelemetry/sdk-*\`, \`@opentelemetry/exporter-*\`, or \`@opentelemetry/instrumentation-*\` in source files.

### Schema Fidelity

- **SCH-001**: Use registry-defined span names when they match the operation. Do NOT invent names when the registry already defines one.
- **SCH-002**: Use registry-defined attribute keys. Check for semantic equivalence, not just exact name matches.
- **SCH-003**: Attribute values must conform to registry-defined types and constraints. Count attributes (\`*_count\`) MUST use \`type: int\` in schema extensions and pass raw numbers to \`setAttribute\` — never wrap numeric values in \`String()\`.
- **SCH-004**: Do NOT create attributes that duplicate existing registry entries under a different name. **Do NOT cite SCH-004 in advisory notes or instrumentation reasoning unless you can identify a specific existing entry in the resolved schema that would be made redundant.** If no such entry exists in the resolved schema passed in context, SCH-004 does not apply.

### Code Quality

- **CDQ-001**: Every span MUST be closed — \`span.end()\` in a \`finally\` block or use the \`startActiveSpan\` callback pattern. Do NOT place \`span.end()\` inside a \`try\` block — if an exception is thrown before it runs, the span leaks. Do NOT add \`span.end()\` immediately before \`process.exit()\` calls — the \`finally\` block handles normal exit paths; \`process.exit()\` paths leak the span at runtime (known limitation). Report leaked span paths in \`notes\` as a known limitation.
- **CDQ-002**: Acquire tracer with \`trace.getTracer()\` including a library name string.
- **CDQ-003**: Record errors with \`span.recordException(error)\` + \`span.setStatus({ code: SpanStatusCode.ERROR })\`. Do NOT use ad-hoc \`setAttribute('error', ...)\`. (Exception: expected-condition catches — see Error Handling section.)
- **CDQ-005**: For manual spans (\`startSpan\`), use \`context.with()\` to maintain async context.
- **CDQ-006**: Guard expensive attribute computation (\`JSON.stringify\`, \`.map\`, \`.reduce\`) with \`span.isRecording()\`. **Exemption: CDQ-006 does not apply to root spans or spans created at the entry point of a traced operation — these always record.** Do not add \`isRecording()\` guards to root spans or entry-point spans. Do not cite CDQ-006 violations for root spans or entry-point spans in advisory notes or instrumentation reasoning.
- **CDQ-007**: Do NOT set unbounded attributes (full object spreads, unsized arrays), PII fields, or undefined values. PII attribute names to avoid: \`author\`, \`committer\`, \`username\`, \`email\`, \`password\`, \`ssn\`, \`name\`, \`user\`. Do NOT pass raw filesystem paths (variables named \`filePath\`, \`outputDir\`, etc.) as attribute values — use \`path.basename()\` or a project-relative path instead. Watch for optional chaining (\`?.\`) in \`setAttribute\` value arguments — these can produce \`undefined\`. If the value is a member access like \`entries.length\`, guard with \`if (entries)\` or use optional chaining (\`entries?.length ?? 0\`).
- **CDQ-009**: Do NOT use \`!== undefined\` to guard a variable before accessing its property as a \`setAttribute\` value. This guard passes when the variable is \`null\` and will throw a TypeError at runtime. Use \`if (x)\` (truthy check) or \`x != null\` (covers both null and undefined) instead.
- **CDQ-010**: Do NOT call string methods (\`.split()\`, \`.slice()\`, \`.trim()\`, \`.replace()\`, \`.toLowerCase()\`, and similar string-only methods) directly on a property access expression without type coercion — unless the field's string type is evident from context (e.g., assigned from a string literal, a template literal, or a method whose name indicates a string return like \`.toString()\` or \`.getName()\`). If \`obj.field\` is not a string at runtime, this throws \`TypeError: obj.field.method is not a function\`. When the type is uncertain, use \`String(obj.field).method()\` or, for timestamps, \`new Date(obj.field).toISOString()\` instead.
- **CDQ-008**: Use the same tracer naming convention across all files. Do NOT vary the pattern.

${formatExamplesSection(examples)}

## Suggested Refactors

When you cannot instrument a function because doing so would require modifying non-instrumentation code (violating NDS-003), report the needed transform in \`suggestedRefactors\`. This gives the user actionable feedback instead of a silent failure.

**When to report**: You identify a code pattern that blocks safe instrumentation — for example, an expression that needs to be extracted to a \`const\` so \`setAttribute\` can capture it, or a function structure that needs decomposition before spans can be added.

**When NOT to report**: Do not report refactors for patterns you can work around. Only report transforms you genuinely need but cannot make without changing business logic.

Each entry in \`suggestedRefactors\` has:
- \`description\`: What the user should change, in plain English. Name the function and describe the structural change needed. Do not cite rule IDs without explaining them. Good: \`"Extract the template literal in summaryNode (line 445) to a const variable so span.setAttribute can reference the already-assigned value after the assignment"\`. Bad: \`"NDS-003 refactor needed in summaryNode"\`.
- \`diff\`: Unified diff showing the before/after (the user applies this)
- \`reason\`: One sentence explaining what the current code structure prevents — describe the structural problem, not the rule that caught it. Good: \`"The template literal assigns directly inline — adding span context before it would modify the original line, which validation rejects as a non-instrumentation change"\`. Bad: \`"NDS-003 violation"\`.
- \`unblocksRules\`: Which validation rules block instrumentation (e.g., \`["NDS-003"]\`)
- \`startLine\`: First line of the code that needs refactoring (1-based)
- \`endLine\`: Last line of the code that needs refactoring (1-based)

**Example**: A function passes a computed expression directly to a callback. You need a \`const\` to capture the value for \`setAttribute\`, but extracting it would modify non-instrumentation code:

\`\`\`json
{
  "description": "Extract computed expression to a const variable",
  "diff": "- processResult(items.filter(i => i.active).length);\\n+ const activeCount = items.filter(i => i.active).length;\\n+ processResult(activeCount);",
  "reason": "setAttribute requires a simple variable reference, not an inline expression. Extracting to const enables span.setAttribute('item.active_count', activeCount).",
  "unblocksRules": ["NDS-003"],
  "startLine": 42,
  "endLine": 42
}
\`\`\`

Return an empty array if no refactors are needed.

## Output Format

You are returning structured JSON via the output schema. Fill in each field:

- \`instrumentedCode\`: The complete instrumented ${activeProvider.displayName} file. Must be syntactically valid ${activeProvider.displayName}. Must contain ALL original code plus instrumentation additions. No markdown fences, no explanations, no partial output. Files containing placeholder comments (\`// ...\`, \`// existing code\`, \`// rest of function\`, \`/* ... */\`) will be rejected by validation.
- \`librariesNeeded\`: Array of \`{ package, importName }\` for auto-instrumentation libraries detected. Empty array if none.
- \`schemaExtensions\`: Array of dot-separated string IDs for any new schema entries created (attribute keys or span names not already in the schema). Empty array if none. Format: \`<namespace>.<category>.<name>\` for attributes, \`span.<namespace>.<category>.<name>\` for spans. Use dots as separators — NOT colons, hyphens, or slashes. Example: \`span.commit_story.summary.generate_daily\`, NOT \`span:commit_story.summary.generate_daily\`. Each extension MUST have a corresponding note in \`notes\` explaining why no existing key was a semantic match and what data the new key captures.
- \`attributesCreated\`: Count of new span attributes added that were not in the existing schema. 0 if none.
- \`spanCategories\`: Breakdown of spans added: \`{ externalCalls, schemaDefined, serviceEntryPoints, totalFunctionsInFile }\`. Set to null only if the file could not be processed at all.
- \`suggestedRefactors\`: Array of refactors the user should apply before re-running the agent. Empty array if no blocked transforms were identified. See the Suggested Refactors section above for field details.
- \`notes\`: Array of 3-5 judgment call explanations focusing on non-obvious decisions. Include: why functions were skipped, why specific attributes were chosen, ratio backstop warnings, variable shadowing decisions, already-instrumented detections. Standard patterns (span wrapping, error recording, import additions) do not need notes — only explain what is surprising or requires judgment. Return an empty array if there are no non-obvious decisions to document.

  **Write for an external reader.** Every note must be self-contained: name the function, describe what it does or what happened, and only then cite any rule — always with a plain-English explanation alongside it. A reviewer reading this PR has never seen the codebase and doesn\'t know the rule registry.

  For each decision, follow this structure: *what the function does → what happened → why (with rule in parentheses if applicable)*. Never cite a rule ID alone.

  Good:
  - \`"formatTimestamp is a pure synchronous helper with no I/O — it doesn\'t need a span (RST-001: no spans on synchronous utilities)"\`
  - \`"processEntry makes an LLM API call and is exported — it gets its own span even though it\'s called from within an already-instrumented parent (COV-004: all exported async operations must have spans)"\`
  - \`"summaryNode cannot be instrumented without modifying the template literal on line 445, which validation rejects as a non-instrumentation change (NDS-003: original code must be preserved exactly). Recommend extracting the template literal to a const before re-running"\`
  - \`"Used \'commit.sha\' for the span attribute rather than a generic \'id\' — \'commit.sha\' matches the domain terminology and the Weaver schema\'s registered key for this field"\`

  Bad:
  - \`"skipped per RST-001"\`
  - \`"NDS-003: original line 27 missing/modified"\`
  - \`"COV-004 exemption not applicable"\`
  - \`"SCH-002 violation avoided"\``;
}

/**
 * Build the user message for a specific file to instrument.
 * This changes per file — it contains the file path and source code.
 * When OTel detection results are provided, includes already-instrumented context
 * so the LLM knows which functions to skip.
 *
 * @param filePath - Absolute path to the source file
 * @param originalCode - File contents before instrumentation
 * @param config - Validated agent configuration (used for large file threshold)
 * @param provider - Language provider used to name the language in the message
 * @param detectionResult - Optional OTel detection result from AST analysis
 * @param existingSpanNames - Optional span names already declared by earlier files; agent must not reuse them
 * @param prettierConstraint - Optional prose constraint derived from the project's non-default Prettier config
 * @param preScanResult - Optional pre-instrumentation analysis findings from the deterministic AST pass
 * @returns The user message string
 */
export function buildUserMessage(
  filePath: string,
  originalCode: string,
  config: AgentConfig,
  provider: LanguageProvider,
  detectionResult?: InstrumentationDetectionResult,
  existingSpanNames?: string[],
  prettierConstraint?: string,
  preScanResult?: PreScanResult,
): string {
  const lineCount = originalCode.split('\n').length;
  const isLargeFile = lineCount > config.largeFileThresholdLines;

  let message = `Instrument the following ${provider.displayName} file.

**File**: \`${filePath}\`
**Size**: ${lineCount} lines`;

  if (isLargeFile) {
    message += `\n\n**Warning**: This is a large file (${lineCount} lines, threshold: ${config.largeFileThresholdLines}). Pay extra attention to returning the complete file. Every line of the original must be present in the output.`;
  }

  if (detectionResult && detectionResult.spanPatterns.length > 0) {
    const patternDescriptions = detectionResult.spanPatterns.map(p => {
      const fn = p.enclosingFunction ? ` in \`${p.enclosingFunction}\`` : '';
      return `- \`${p.patternName}\`${fn} (line ${p.lineNumber})`;
    });

    message += `

**Already instrumented**: The following span patterns were detected in this file. Do not add duplicate instrumentation to these functions. Report them in \`notes\` as skipped.
${patternDescriptions.join('\n')}`;
  }

  if (existingSpanNames && existingSpanNames.length > 0) {
    message += `

**Span names already in use**: The following span names were declared by earlier files in this run. Do NOT reuse these names for different operations — invent unique names instead.
${existingSpanNames.map(n => `- \`${n}\``).join('\n')}`;
  }

  const sanitizedPrettierConstraint = prettierConstraint
    ?.replace(/[\r\n]+/g, ' ')
    .replace(/[<>]/g, '')
    .trim();

  if (sanitizedPrettierConstraint) {
    message += `

**Formatting**: ${sanitizedPrettierConstraint}`;
  }

  // Inject pre-instrumentation analysis directives when findings are present.
  // This section appears before the source file block so the agent reads the
  // constraints before seeing the code.
  if (preScanResult) {
    const directives: string[] = [];

    // COV-001 entry points (+ RST-006 process.exit() constraint when applicable)
    const processExitNames = new Set(preScanResult.processExitEntryPoints.map(f => f.name));
    for (const ep of preScanResult.entryPointsNeedingSpans) {
      if (processExitNames.has(ep.name)) {
        const constraint = preScanResult.processExitEntryPoints.find(f => f.name === ep.name);
        if (constraint) directives.push(`- ${constraint.constraintNote}`);
      } else {
        directives.push(`- Entry point \`${ep.name}\` (line ${ep.startLine}) requires a span — COV-001.`);
      }
    }

    // COV-004: async non-entry-point functions needing spans
    for (const fn of preScanResult.asyncFunctionsNeedingSpans) {
      directives.push(`- \`${fn.name}\` (line ${fn.startLine}) is async — add a span (COV-004).`);
    }

    // COV-002: outbound calls needing enclosing spans
    for (const group of preScanResult.outboundCallsNeedingSpans) {
      const callList = group.calls.map(c => c.callText).join(', ');
      directives.push(`- \`${group.functionName}\` makes outbound calls (${callList}) — ensure they are covered by spans (COV-002).`);
    }

    // RST-001: pure sync functions to skip
    if (preScanResult.pureSyncFunctions.length > 0) {
      const names = preScanResult.pureSyncFunctions.map(f => `\`${f.name}\``).join(', ');
      directives.push(`- Synchronous functions — skip, no I/O to trace (RST-001): ${names}.`);
    }

    // RST-004: unexported functions to skip
    if (preScanResult.unexportedFunctions.length > 0) {
      const names = preScanResult.unexportedFunctions.map(f => `\`${f.name}\``).join(', ');
      directives.push(`- Unexported — skip unless no exported orchestrator covers this execution path (RST-004): ${names}.`);
    }

    // M3: per-entry-point sub-operation breakdown (local vs. imported)
    for (const group of preScanResult.entryPointSubOperations) {
      const localPart = group.localSubOperations.length > 0
        ? `local: ${group.localSubOperations.map(n => `\`${n}\``).join(', ')}`
        : null;
      const importedPart = group.importedSubOperations.length > 0
        ? `imported (handled elsewhere): ${group.importedSubOperations.map(s => `\`${s.name}\` from \`${s.sourceModule}\``).join(', ')}`
        : null;
      const parts = [localPart, importedPart].filter(Boolean).join('; ');
      directives.push(`- In \`${group.entryPointName}()\`, async sub-operations — ${parts}.`);
    }

    if (directives.length > 0) {
      message += `

**Pre-instrumentation analysis** (deterministic findings — apply before reading the source):
${directives.join('\n')}`;
    }
  }

  message += `

<source_file>
${originalCode}
</source_file>`;

  return message;
}

