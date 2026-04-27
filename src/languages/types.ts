// ABOUTME: Language-agnostic type definitions for the multi-language provider interface.
// ABOUTME: Defines LanguageProvider and all supporting types for the shared instrumentation pipeline.

import type { CheckResult, ValidateFileInput } from '../validation/types.ts';
import type { FunctionResult } from '../fix-loop/types.ts';
import type { TokenUsage } from '../agent/schema.ts';

// Re-export FunctionResult so LanguageProvider method signatures can reference it
// without callers needing to import from fix-loop directly.
export type { FunctionResult };

/**
 * Classification of a function's role in the codebase.
 *
 * Used by Tier 2 coverage checks (COV-001) to determine whether a function
 * should be instrumented. Providers return this from `classifyFunction()`.
 *
 * `'unknown'` enables checkers to abstain when classification evidence is
 * insufficient (e.g., a parameter named `req` that could be any type).
 * A checker that receives `'unknown'` neither flags the function as a
 * violation nor marks it as compliant.
 */
export type FunctionClassification =
  | 'entry-point'
  | 'outbound-call'
  | 'thin-wrapper'
  | 'utility'
  | 'internal-detail'
  | 'unknown';

/**
 * Language-agnostic classification data for a single function.
 *
 * Replaces the JS-specific `FunctionInfo` in `src/ast/function-classification.ts`
 * for use in the shared pipeline. The JS-specific version is migrated in PRD B.
 *
 * Differences from JS-specific version:
 * - Adds `endLine` (was calculated but not stored in the JS version)
 */
export interface FunctionInfo {
  /** Function name (or variable name for arrow functions). */
  name: string;
  /** Starting line number in the source file (1-based). */
  startLine: number;
  /** Ending line number in the source file (1-based, inclusive). */
  endLine: number;
  /** Whether the function is exported from the module. */
  isExported: boolean;
  /**
   * Whether the function is async.
   *
   * Go caveat: Go has no `async` keyword. Functions using goroutines or channels
   * are not async in the JavaScript sense. The Go provider populates this field
   * as `false` for all functions until PRD E resolves the Go context pattern.
   */
  isAsync: boolean;
  /** Number of lines in the function body (inclusive of opening/closing braces). */
  lineCount: number;
}

/**
 * Language-agnostic import declaration information.
 *
 * Replaces the JS-specific `ImportInfo` in `src/ast/import-detection.ts`.
 * The minimal shared contract that covers JS/TS, Python, and Go import styles:
 *
 * - JS/TS: `import { a, b } from '@opentelemetry/api'`
 *   → `moduleSpecifier='@opentelemetry/api'`, `importedNames=['a','b']`
 * - Python: `from opentelemetry import trace`
 *   → `moduleSpecifier='opentelemetry'`, `importedNames=['trace']`
 * - Go: `import otel "go.opentelemetry.io/otel"`
 *   → `moduleSpecifier='go.opentelemetry.io/otel'`, `importedNames=[]`, `alias='otel'`
 * - Go namespace: `import "go.opentelemetry.io/otel"`
 *   → `moduleSpecifier='go.opentelemetry.io/otel'`, `importedNames=[]`, `alias=undefined`
 */
export interface ImportInfo {
  /** Module path or package specifier (e.g. `'@opentelemetry/api'`, `'opentelemetry'`, `'go.opentelemetry.io/otel/trace'`). */
  moduleSpecifier: string;
  /** Named items imported from the module. Empty array indicates a namespace/wildcard import or a Go-style package import. */
  importedNames: string[];
  /** Import alias, if present (e.g. `'otel'` in Go's `import otel "go.opentelemetry.io/otel"`). */
  alias: string | undefined;
  /** Line number where the import appears (1-based). */
  lineNumber: number;
}

/**
 * An exported symbol from a source file.
 *
 * New type with no equivalent in the existing JS-specific code.
 * Used by the shared pipeline to understand a file's public API surface,
 * which informs coverage checks and context building.
 */
export interface ExportInfo {
  /** Exported symbol name. */
  name: string;
  /** Line number where the export appears (1-based). */
  lineNumber: number;
  /** Whether this is the default export (`export default`). */
  isDefault: boolean;
}

/**
 * A function extracted from a source file for per-function instrumentation.
 *
 * Language-agnostic replacement for the JS-specific `ExtractedFunction` in
 * `src/fix-loop/function-extraction.ts`. Key differences:
 * - `contextHeader: string` replaces `buildContext: (sourceFile: SourceFile) => string`
 *   (pre-built at extraction time; eliminates ts-morph SourceFile dependency)
 * - `docComment: string | null` replaces `jsDoc: string | null`
 *   (language-agnostic name covers JS JSDoc, Python docstrings, Go `//` comment blocks)
 * - `referencedConstants` is dropped (JS/TS specific concept; Go/Python providers omit it)
 */
export interface ExtractedFunction {
  /** Function name. */
  name: string;
  /**
   * Whether the function is async.
   *
   * Go caveat: populated as `false` until PRD E resolves Go context pattern.
   */
  isAsync: boolean;
  /** Whether the function is exported from the module. */
  isExported: boolean;
  /** Full source text of the function (including export keyword and doc comment). */
  sourceText: string;
  /**
   * Language-agnostic doc comment, if present.
   *
   * JS/TS: JSDoc block (`/** ... *\/`). Python: docstring (`'''...'''`). Go: comment block above declaration (`// ...`).
   */
  docComment: string | null;
  /** Names of imported identifiers referenced in the function body. */
  referencedImports: string[];
  /**
   * Self-contained code context for the LLM, pre-built at extraction time.
   *
   * Includes relevant imports and the function itself. Replaces the ts-morph
   * closure `buildContext: (sourceFile: SourceFile) => string` from the JS version.
   */
  contextHeader: string;
  /** Start line in the original file (1-based). */
  startLine: number;
  /** End line in the original file (1-based, inclusive). */
  endLine: number;
}

/**
 * Language-specific sections injected into the shared LLM system prompt.
 *
 * Each field is a prose string written by the provider that teaches the LLM
 * how to write idiomatic OTel instrumentation for the target language.
 */
export interface LanguagePromptSections {
  /** Language-specific constraints and rules (e.g. span naming conventions). */
  constraints: string;
  /** How OTel patterns look in this language (e.g. context propagation idioms). */
  otelPatterns: string;
  /** How to acquire a tracer (e.g. `"trace.getTracer('my-service')"`). */
  tracerAcquisition: string;
  /** How to create and end spans in this language. */
  spanCreation: string;
  /** How to handle errors in instrumented code (e.g. `span.recordException`). */
  errorHandling: string;
  /** How to install OTel packages (e.g. `"npm install @opentelemetry/api"`). */
  libraryInstallation: string;
}

/**
 * A before/after instrumentation example for the LLM system prompt.
 */
export interface Example {
  /** Human-readable description of what this example demonstrates. */
  description: string;
  /** Source code before instrumentation. */
  before: string;
  /** Source code after instrumentation. */
  after: string;
  /** Optional explanation of non-obvious decisions (librariesNeeded, skip rationale, etc.). */
  notes?: string;
}

/**
 * A single span creation pattern detected in a source file.
 *
 * Language-agnostic: `patternName` is the actual OTel API call found in the source,
 * which is language-specific (e.g., 'startActiveSpan' or 'startSpan' for JS/TS).
 */
export interface DetectedSpanPattern {
  /** OTel span creation call name found in the source (e.g., 'startActiveSpan', 'startSpan'). */
  patternName: string;
  /** Line number where the pattern appears (1-based). */
  lineNumber: number;
  /** Name of the enclosing function, if identifiable. */
  enclosingFunction: string | undefined;
}

/**
 * Result of richer OTel instrumentation detection.
 *
 * Language-agnostic replacement for the JS-specific `OTelImportDetectionResult`
 * for callers that need span-pattern details (line numbers, enclosing function names).
 * Returned by `LanguageProvider.detectOTelInstrumentation()`.
 *
 * The existing `detectExistingInstrumentation()` method (returns `boolean`) remains
 * for callers that only need a presence check.
 */
export interface InstrumentationDetectionResult {
  /** Whether any OTel span patterns were detected in the source file. */
  hasExistingInstrumentation: boolean;
  /** All span creation patterns found, with location and enclosing function data. */
  spanPatterns: DetectedSpanPattern[];
}

/**
 * The full contract every language provider must implement.
 *
 * Providers are registered with the coordinator and selected by file extension.
 * The coordinator calls provider methods during the instrumentation pipeline;
 * providers never call each other or back into the coordinator.
 *
 * Async/sync split (Decision 10):
 * - Methods that spawn external processes (`checkSyntax`, `formatCode`, `lintCheck`)
 *   return `Promise<T>` — they shell out to language toolchains.
 * - Methods that are pure in-memory operations (`findFunctions`, `findImports`, etc.)
 *   are synchronous — they receive source text and return parsed data, no I/O.
 */
export interface LanguageProvider {
  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /**
   * Stable language identifier used as a key throughout the pipeline.
   * Examples: `'javascript'`, `'typescript'`, `'python'`, `'go'`
   */
  id: string;

  /**
   * Human-readable language name for display in logs and output.
   * Examples: `'JavaScript'`, `'TypeScript'`, `'Python'`, `'Go'`
   */
  displayName: string;

  /**
   * File extensions this provider handles (lowercase, with leading dot).
   * Examples: `['.js', '.jsx']`, `['.py']`, `['.go']`
   */
  fileExtensions: string[];

  // -------------------------------------------------------------------------
  // File discovery
  // -------------------------------------------------------------------------

  /**
   * Glob pattern for discovering source files this provider can instrument.
   * Example: `'**\/*.{js,jsx}'`, `'**\/*.py'`, `'**\/*.go'`
   */
  globPattern: string;

  /**
   * Glob patterns for paths to exclude from discovery.
   * Example: `['**\/node_modules\/**', '**\/*.min.js']`
   */
  defaultExclude: string[];

  // -------------------------------------------------------------------------
  // Tier 1: Syntax validation
  // -------------------------------------------------------------------------

  /**
   * Check that a file contains syntactically valid source code.
   *
   * Spawns the language's syntax checker (e.g. `node --check` for JS,
   * `python3 -c "import ast; ast.parse(...)"` for Python, `go build` for Go).
   * Returns a `CheckResult` with `ruleId: 'NDS-001'`.
   *
   * @param filePath - Absolute path to the file on disk
   */
  checkSyntax(filePath: string): Promise<CheckResult>;

  // -------------------------------------------------------------------------
  // Tier 1: Formatting
  // -------------------------------------------------------------------------

  /**
   * Format source code according to the language's standard formatter.
   *
   * Spawns the formatter (e.g. Prettier for JS/TS, Black for Python, `gofmt` for Go).
   * Returns the formatted source text. If the formatter is not installed or
   * formatting fails, returns the original source unchanged and logs a warning.
   *
   * @param source - Source code text to format
   * @param configDir - Directory to search for formatter config files
   */
  formatCode(source: string, configDir: string): Promise<string>;

  // -------------------------------------------------------------------------
  // Tier 1: Linting
  // -------------------------------------------------------------------------

  /**
   * Lint the instrumented code for style and correctness issues introduced
   * by instrumentation (not pre-existing issues in the original code).
   *
   * Spawns the linter (e.g. ESLint for JS/TS, Ruff for Python, `go vet` for Go).
   * Returns a `CheckResult` with `ruleId: 'LINT'`.
   *
   * @param original - Original source code before instrumentation
   * @param instrumented - Instrumented source code to check
   */
  lintCheck(original: string, instrumented: string): Promise<CheckResult>;

  // -------------------------------------------------------------------------
  // AST analysis (synchronous — pure in-memory)
  // -------------------------------------------------------------------------

  /**
   * Parse source text and return all function definitions.
   *
   * @param source - Source code text
   * @returns Array of `FunctionInfo` for every function found
   */
  findFunctions(source: string): FunctionInfo[];

  /**
   * Parse source text and return all import declarations.
   *
   * @param source - Source code text
   * @returns Array of `ImportInfo` for every import found
   */
  findImports(source: string): ImportInfo[];

  /**
   * Parse source text and return all exported symbols.
   *
   * @param source - Source code text
   * @returns Array of `ExportInfo` for every export found
   */
  findExports(source: string): ExportInfo[];

  /**
   * Classify a function's role in the codebase.
   *
   * Returns `'unknown'` when evidence is insufficient to classify confidently.
   * A checker that receives `'unknown'` abstains (neither flags nor approves).
   *
   * @param fn - Function to classify
   */
  classifyFunction(fn: FunctionInfo): FunctionClassification;

  /**
   * Detect whether a source file already contains OTel instrumentation.
   *
   * Used as a fast pre-check before running the full analysis pipeline.
   *
   * @param source - Source code text
   * @returns `true` if any OTel span patterns are detected
   */
  detectExistingInstrumentation(source: string): boolean;

  /**
   * Detect existing OTel instrumentation and return detailed span-pattern information.
   *
   * Returns a richer result than `detectExistingInstrumentation()` — includes the
   * line number and enclosing function name for each pattern found. Callers that need
   * to build context-aware LLM prompts or make precise per-function skip decisions
   * should use this method.
   *
   * Example:
   * ```typescript
   * const result = provider.detectOTelInstrumentation(source);
   * if (result.hasExistingInstrumentation) {
   *   const names = result.spanPatterns.map(
   *     p => `${p.patternName} in ${p.enclosingFunction ?? '<module>'} at line ${p.lineNumber}`
   *   );
   *   // names: ["startActiveSpan in handleRequest at line 12", ...]
   * }
   * ```
   *
   * @param source - Source code text
   */
  detectOTelInstrumentation(source: string): InstrumentationDetectionResult;

  // -------------------------------------------------------------------------
  // Function-level fallback
  // -------------------------------------------------------------------------

  /**
   * Extract functions from source text for per-function instrumentation.
   *
   * Called when whole-file instrumentation fails and the fix loop falls back
   * to instrumenting function by function.
   *
   * @param source - Source code text
   * @returns Array of extracted functions ready for per-function LLM calls
   */
  extractFunctions(source: string): ExtractedFunction[];

  /**
   * Reassemble a file from individually instrumented functions.
   *
   * Takes the original source and replaces each extracted function's text
   * with the corresponding `FunctionResult.instrumentedCode`. Functions
   * that failed instrumentation are left as-is from the original.
   *
   * @param original - Original source code before instrumentation
   * @param extracted - The functions that were extracted (in extraction order)
   * @param results - The instrumentation results, one per extracted function
   * @returns Reassembled source with successfully instrumented functions replaced
   */
  reassembleFunctions(
    original: string,
    extracted: ExtractedFunction[],
    results: FunctionResult[],
  ): string;

  /**
   * Ensure tracer initialization (`const tracer = trace.getTracer(...)`) appears
   * after all import statements, not between them.
   *
   * The LLM sometimes places the tracer init between import lines. For languages
   * with module-level import blocks (JS/TS: ES modules, Python: top-level imports,
   * Go: import declarations), having non-import statements between imports may be
   * a syntax error or style violation. Providers that do not need this fixup
   * should return the code unchanged.
   *
   * @param code - Instrumented code that may have misplaced tracer init
   * @returns Code with tracer init moved after the last import (or unchanged)
   */
  ensureTracerAfterImports(code: string): string;

  /**
   * Return a language-specific formatter constraint string for the LLM prompt.
   *
   * For JavaScript and TypeScript, reads the project's Prettier config from
   * `package.json` and returns formatting directives. For other languages,
   * returns an empty string.
   *
   * @param filePath - Absolute path to the file being instrumented
   * @returns Formatter constraint text, or empty string if none applies
   */
  getFormatterConstraint(filePath: string): Promise<string>;

  // -------------------------------------------------------------------------
  // LLM prompt context
  // -------------------------------------------------------------------------

  /**
   * Provide language-specific sections for the shared LLM system prompt.
   *
   * The coordinator merges these sections into the base system prompt to
   * give the LLM language-specific instrumentation guidance.
   */
  getSystemPromptSections(): LanguagePromptSections;

  /**
   * Provide before/after instrumentation examples for the LLM system prompt.
   *
   * Examples are included verbatim in the prompt. At least one complete
   * example (entry point with span, attribute, error handling) is required.
   */
  getInstrumentationExamples(): Example[];

  // -------------------------------------------------------------------------
  // OTel specifics
  // -------------------------------------------------------------------------

  /**
   * Regex pattern that matches an OTel import in source text.
   *
   * Used as a fast pre-check: `provider.otelImportPattern.test(source)`.
   * Each provider supplies a pattern appropriate for its language:
   * - JS: `/from ['"]@opentelemetry\/api['"]/`
   * - Python: `/from opentelemetry import/`
   * - Go: `/go\.opentelemetry\.io\/otel/`
   */
  otelImportPattern: RegExp;

  /**
   * The OTel API package identifier for this language.
   * Examples: `'@opentelemetry/api'`, `'opentelemetry-api'`, `'go.opentelemetry.io/otel'`
   */
  otelApiPackage: string;

  /**
   * The typed semantic conventions package for this language, or `null` if none exists.
   *
   * All current target languages (JS/TS, Python, Go) have official semconv packages.
   * `null` would apply to a language with no published semconv constants library.
   *
   * Examples:
   * - JS/TS: `'@opentelemetry/semantic-conventions'`
   * - Python: `'opentelemetry-semantic-conventions'`
   * - Go: `'go.opentelemetry.io/otel/semconv/v1.26.0'`
   *
   * Note: Whether to actually instruct the LLM to use typed constants is a per-provider
   * prompt decision deferred to each provider PRD. This property provides the package
   * name for that decision.
   */
  otelSemconvPackage: string | null;

  /**
   * Human-readable display string showing how to acquire a tracer in this language.
   *
   * Used in LLM prompt context to show the tracer acquisition pattern.
   * This is a display value for the LLM, NOT a regex for source text detection.
   *
   * Examples: `"trace.getTracer('my-service')"`, `"trace.get_tracer('my-service')"`,
   * `"otel.Tracer('my-service')"`
   */
  tracerAcquisitionPattern: string;

  /**
   * Regex pattern that matches a span creation call in source text.
   *
   * Used to detect existing instrumentation. Each provider supplies a
   * language-appropriate pattern:
   * - JS: `/\.startActiveSpan\s*\(|\.startSpan\s*\(/`
   * - Python: `/with tracer\.start_as_current_span\(|tracer\.start_span\(/`
   * - Go: `/tracer\.Start\(/`
   */
  spanCreationPattern: RegExp;

  // -------------------------------------------------------------------------
  // Package management
  // -------------------------------------------------------------------------

  /**
   * The package manager used by this language ecosystem.
   * Examples: `'npm'`, `'pip'`, `'go'`
   */
  packageManager: string;

  /**
   * Build the shell command to install OTel packages.
   *
   * Returns a shell command string — does NOT execute it. Execution is the
   * coordinator's responsibility (enables dry-run, confirmation prompts, etc.).
   *
   * @param packages - Package identifiers to install
   * @returns Shell command string, e.g. `"npm install @opentelemetry/api @opentelemetry/sdk-node"`
   */
  installCommand(packages: string[]): string;

  /**
   * The language-appropriate dependency manifest filename.
   * Examples: `'package.json'`, `'pyproject.toml'`, `'go.mod'`
   */
  dependencyFile: string;

  // -------------------------------------------------------------------------
  // Project metadata
  // -------------------------------------------------------------------------

  /**
   * Read the project name from the language-appropriate manifest file.
   *
   * Used by the coordinator to set the tracer naming fallback when the user
   * has not configured an explicit service name.
   *
   * @param projectDir - Absolute path to the project root directory
   * @returns Project name if the manifest exists and contains a name, `undefined` if manifest is absent
   * @throws If the manifest file exists but cannot be parsed (parse errors are bugs, not expected absences)
   */
  readProjectName(projectDir: string): Promise<string | undefined>;

  // -------------------------------------------------------------------------
  // Feature parity check
  // -------------------------------------------------------------------------

  /**
   * Report whether this provider has implemented a specific validation rule.
   *
   * Used by the automated parity check (Part 7.4 of the research doc) to
   * assert that a provider which registers for a language has explicitly
   * implemented or marked as not-applicable every one of the 26 rule IDs.
   * A provider that silently omits a rule causes false confidence.
   *
   * @param ruleId - Rule identifier (e.g. `'COV-001'`, `'NDS-003'`)
   * @returns `true` if the provider implements this rule; `false` if explicitly not-applicable
   */
  hasImplementation(ruleId: string): boolean;
}

/**
 * Input to a per-language validation rule check.
 *
 * Extends `ValidateFileInput` with language context so Tier 2 checkers
 * can call provider methods (e.g. `classifyFunction()` for COV-001).
 *
 * Defined after `LanguageProvider` to avoid a forward reference.
 */
export interface RuleInput extends ValidateFileInput {
  /** Language identifier for the file being validated (e.g. `'javascript'`). */
  language: string;
  /**
   * The language provider for this file.
   *
   * Tier 2 checkers that need language-specific analysis (e.g. COV-001 needs
   * `classifyFunction()`) call the provider rather than re-instantiating it.
   */
  provider: LanguageProvider;
}

/**
 * Result returned by a `ValidationRule.check()` call.
 *
 * Supports three forms to match the range of existing checker return types:
 * - Single `CheckResult`: simple checkers with one finding or a single passing result
 * - `CheckResult[]`: checkers that produce multiple findings (one per issue)
 * - `{ results, judgeTokenUsage }`: checkers that call an LLM judge (SCH-001, SCH-004)
 *
 * The validation chain normalizes all three forms via `unpackRuleResult()`.
 */
export type RuleCheckResult =
  | CheckResult
  | CheckResult[]
  | { results: CheckResult | CheckResult[]; judgeTokenUsage?: TokenUsage[] };

/**
 * A single validation rule in the shared validation chain.
 *
 * Rules are registered with the validation chain and keyed by `ruleId`.
 * The chain calls `applicableTo()` first; if the rule applies to the
 * current language, it calls `check()` and collects the `CheckResult`.
 *
 * Internal type — not exported from `plugin-api.ts`. Plugin authors implement
 * `LanguageProvider`, not `ValidationRule`.
 */
export interface ValidationRule {
  /** Rule identifier matching the scoring checklist spec (e.g. `'COV-001'`, `'NDS-003'`). */
  ruleId: string;
  /** The quality dimension this rule enforces (e.g. `'Coverage'`, `'Non-destructive'`). */
  dimension: string;
  /** Whether a failing check reverts the file (`true`) or is advisory (`false`). */
  blocking: boolean;
  /**
   * Whether this rule applies to a given language.
   *
   * Rules that are language-universal return `true` for all languages.
   * Rules that only apply to specific languages (e.g. a JS-specific pattern check)
   * return `false` for others, causing the validation chain to skip them.
   *
   * @param language - Language identifier (e.g. `'javascript'`, `'python'`)
   */
  applicableTo(language: string): boolean;
  /**
   * Run the check and return the result.
   *
   * May return a single result, an array of results, or an object that includes
   * LLM judge token usage for cost tracking. The chain normalizes all forms.
   *
   * @param input - File content, config, and language context
   */
  check(input: RuleInput): RuleCheckResult | Promise<RuleCheckResult>;
}
