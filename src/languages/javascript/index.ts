// ABOUTME: JavaScriptProvider — the LanguageProvider implementation for JavaScript (.js, .jsx).
// ABOUTME: Delegates to the JS-specific ast, validation, extraction, reassembly, and prompt modules.

import { Project, SyntaxKind } from 'ts-morph';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  LanguageProvider,
  FunctionInfo,
  ImportInfo,
  ExportInfo,
  ExtractedFunction,
  FunctionClassification,
  LanguagePromptSections,
  Example,
  InstrumentationDetectionResult,
  PreScanResult,
  PreScanSubOperationGroup,
} from '../types.ts';
import type { CheckResult } from '../../validation/types.ts';
import type { FunctionResult } from '../../fix-loop/types.ts';
import { classifyFunctions, detectOTelImports } from './ast.ts';
import { checkSyntax, checkLint, formatCode, buildPrettierConstraint } from './validation.ts';
import { extractExportedFunctions } from './extraction.ts';
import { reassembleFunctions as reassembleFunctionsImpl, ensureTracerAfterImports as ensureTracerAfterImportsImpl } from './reassembly.ts';
import { getSystemPromptSections, getInstrumentationExamples } from './prompt.ts';
import { registerRule } from '../../validation/rule-registry.ts';
import { hasDirectProcessExit } from './rules/cov004.ts';
import { cov001Rule } from './rules/cov001.ts';
import { cov002Rule } from './rules/cov002.ts';
import { cov003Rule } from './rules/cov003.ts';
import { cov004Rule } from './rules/cov004.ts';
import { cov005Rule } from './rules/cov005.ts';
import { cov006Rule } from './rules/cov006.ts';
import { rst001Rule } from './rules/rst001.ts';
import { rst002Rule } from './rules/rst002.ts';
import { rst003Rule } from './rules/rst003.ts';
import { rst004Rule } from './rules/rst004.ts';
import { rst005Rule } from './rules/rst005.ts';
import { rst006Rule } from './rules/rst006.ts';
import { nds003Rule } from './rules/nds003.ts';
import { nds004Rule } from './rules/nds004.ts';
import { nds005Rule } from './rules/nds005.ts';
import { nds006Rule } from './rules/nds006.ts';
import { nds007Rule } from './rules/nds007.ts';
import { cdq001Rule } from './rules/cdq001.ts';
import { cdq006Rule } from './rules/cdq006.ts';
import { cdq007Rule } from './rules/cdq007.ts';
import { cdq009Rule } from './rules/cdq009.ts';
import { cdq010Rule } from './rules/cdq010.ts';
import { api001Rule, api004Rule } from './rules/api001.ts';
import { api002Rule } from './rules/api002.ts';
import { sch001Rule } from './rules/sch001.ts';
import { sch002Rule } from './rules/sch002.ts';
import { sch003Rule } from './rules/sch003.ts';
import { sch004Rule } from './rules/sch004.ts';
import { cdq008Rule } from '../../validation/tier2/cdq008.ts';

/**
 * All ValidationRule instances this provider registers.
 * Covers 30 rules total: 29 per-file Tier 2 rules (including API-004 from api001.ts; API-003 deleted)
 * plus CDQ-008 (shared cross-file rule registered here for parity tracking).
 *
 * NDS-001 (syntax) and LINT are not ValidationRule objects — they are
 * dispatched directly through provider.checkSyntax() and provider.lintCheck()
 * in the validation chain's Tier 1 section.
 */
const JS_RULES = [
  cov001Rule, cov002Rule, cov003Rule, cov004Rule, cov005Rule, cov006Rule,
  rst001Rule, rst002Rule, rst003Rule, rst004Rule, rst005Rule, rst006Rule,
  nds003Rule, nds004Rule, nds005Rule, nds006Rule, nds007Rule,
  cdq001Rule, cdq006Rule, cdq007Rule, cdq008Rule, cdq009Rule, cdq010Rule,
  api001Rule, api002Rule, api004Rule,
  sch001Rule, sch002Rule, sch003Rule, sch004Rule,
] as const;

/**
 * JavaScript language provider.
 *
 * Implements the LanguageProvider contract for JavaScript (.js, .jsx) files.
 * All methods delegate to the JS-specific modules created in B1:
 * - ast.ts: function classification, import detection, OTel detection
 * - validation.ts: syntax checking (node --check), lint checking (Prettier)
 * - extraction.ts: per-function extraction for the fix loop fallback
 * - reassembly.ts: function reassembly after per-function instrumentation
 * - prompt.ts: JS-specific LLM prompt sections and examples
 */
export class JavaScriptProvider implements LanguageProvider {
  constructor() {
    // Register all JS ValidationRules with the shared rule registry.
    // This populates the registry so the validation chain can dispatch
    // through getRulesForLanguage('javascript') instead of direct imports.
    for (const rule of JS_RULES) {
      registerRule(rule, 'javascript');
    }
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  readonly id = 'javascript';
  readonly displayName = 'JavaScript';
  readonly fileExtensions: string[] = ['.js', '.jsx'];

  // ── File discovery ────────────────────────────────────────────────────────

  readonly globPattern = '**/*.{js,jsx}';
  readonly defaultExclude: string[] = [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    '**/*.min.js',
  ];

  // ── OTel specifics ────────────────────────────────────────────────────────

  readonly otelImportPattern = /from\s+['"]@opentelemetry\/api['"]/;
  readonly otelApiPackage = '@opentelemetry/api';
  readonly otelSemconvPackage: string | null = '@opentelemetry/semantic-conventions';
  readonly tracerAcquisitionPattern = "trace.getTracer('my-service')";
  readonly spanCreationPattern = /\.startActiveSpan\s*\(|\.startSpan\s*\(/;

  // ── Package management ────────────────────────────────────────────────────

  readonly packageManager = 'npm';
  readonly dependencyFile = 'package.json';

  // ── Tier 1: Syntax validation ─────────────────────────────────────────────

  checkSyntax(filePath: string): Promise<CheckResult> {
    return Promise.resolve(checkSyntax(filePath));
  }

  // ── Tier 1: Formatting ────────────────────────────────────────────────────

  formatCode(source: string, configDir: string): Promise<string> {
    return formatCode(source, configDir);
  }

  // ── Tier 1: Linting ───────────────────────────────────────────────────────

  lintCheck(original: string, instrumented: string): Promise<CheckResult> {
    // The underlying checkLint needs a filePath for Prettier config resolution
    // and parser detection. Without the actual file path (not in the interface),
    // use 'file.js' so Prettier applies the babel parser and looks for
    // .prettierrc starting from the process working directory.
    return checkLint(original, instrumented, 'file.js');
  }

  // ── AST analysis (synchronous) ────────────────────────────────────────────

  findFunctions(source: string): FunctionInfo[] {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', source);
    return classifyFunctions(sourceFile).map(fn => ({
      name: fn.name,
      startLine: fn.startLine,
      endLine: fn.startLine + fn.lineCount - 1,
      isExported: fn.isExported,
      isAsync: fn.isAsync,
      lineCount: fn.lineCount,
    }));
  }

  findImports(source: string): ImportInfo[] {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', source);
    return sourceFile.getImportDeclarations().map(decl => {
      const namedImports = decl.getNamedImports().map(n => n.getName());
      const defaultImport = decl.getDefaultImport()?.getText();
      const namespaceImport = decl.getNamespaceImport()?.getText();

      // Language-agnostic ImportInfo uses importedNames for named and default
      // imports, and alias for namespace imports (matching Go's import alias).
      const importedNames = [...namedImports];
      if (defaultImport !== undefined) importedNames.push(defaultImport);

      return {
        moduleSpecifier: decl.getModuleSpecifierValue(),
        importedNames,
        alias: namespaceImport ?? undefined,
        lineNumber: decl.getStartLineNumber(),
      };
    });
  }

  findExports(source: string): ExportInfo[] {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', source);
    const exports: ExportInfo[] = [];
    const seen = new Set<string>();

    // Named function declarations: export function foo() {}
    // export default function foo() {} — tracked under key 'default' to prevent
    // getDefaultExportSymbol() from adding a second entry for the same declaration.
    for (const fn of sourceFile.getFunctions()) {
      if (fn.isExported()) {
        const name = fn.getName() ?? '<anonymous>';
        const isDefault = fn.isDefaultExport();
        const seenKey = isDefault ? 'default' : name;
        if (seen.has(seenKey)) continue;
        seen.add(seenKey);
        exports.push({ name, lineNumber: fn.getStartLineNumber(), isDefault });
      }
    }

    // Variable statements: export const foo = ...
    for (const varStatement of sourceFile.getVariableStatements()) {
      if (varStatement.isExported()) {
        for (const decl of varStatement.getDeclarations()) {
          const name = decl.getName();
          if (seen.has(name)) continue;
          seen.add(name);
          exports.push({ name, lineNumber: varStatement.getStartLineNumber(), isDefault: false });
        }
      }
    }

    // Re-export blocks: export { foo, bar }
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      if (!exportDecl.isNamespaceExport()) {
        for (const named of exportDecl.getNamedExports()) {
          const name = named.getNameNode().getText();
          if (seen.has(name)) continue;
          seen.add(name);
          exports.push({ name, lineNumber: exportDecl.getStartLineNumber(), isDefault: false });
        }
      }
    }

    // Default exports: export default <expression>
    // Skip when getFunctions() already registered the default (e.g. export default function foo() {})
    if (!seen.has('default')) {
      const defaultExportSymbol = sourceFile.getDefaultExportSymbol();
      if (defaultExportSymbol !== undefined) {
        const declarations = defaultExportSymbol.getDeclarations();
        if (declarations.length > 0) {
          const decl = declarations[0];
          if (decl !== undefined) {
            seen.add('default');
            exports.push({ name: 'default', lineNumber: decl.getStartLineNumber(), isDefault: true });
          }
        }
      }
    }

    return exports;
  }

  classifyFunction(_fn: FunctionInfo): FunctionClassification {
    // Returns 'unknown' for all functions: classification requires parameter
    // names and framework call patterns (context beyond FunctionInfo alone).
    // Tier 2 checkers (COV-001 etc.) perform their own classification directly
    // using ts-morph on the full source. This method satisfies the interface
    // contract and allows checkers to abstain when they receive 'unknown'.
    return 'unknown';
  }

  detectExistingInstrumentation(source: string): boolean {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', source);
    const result = detectOTelImports(sourceFile);
    return result.hasOTelImports || result.existingSpanPatterns.length > 0;
  }

  detectOTelInstrumentation(source: string): InstrumentationDetectionResult {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', source);
    const result = detectOTelImports(sourceFile);
    return {
      hasExistingInstrumentation: result.existingSpanPatterns.length > 0,
      spanPatterns: result.existingSpanPatterns.map(p => ({
        patternName: p.pattern,
        lineNumber: p.lineNumber,
        enclosingFunction: p.enclosingFunction,
      })),
    };
  }

  // ── Function-level fallback ────────────────────────────────────────────────

  extractFunctions(source: string): ExtractedFunction[] {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', source);
    const jsExtracted = extractExportedFunctions(sourceFile);

    // Map JS-specific ExtractedFunction to the language-agnostic type:
    // - jsDoc → docComment
    // - buildContext(sourceFile) → contextHeader (pre-built at extraction time)
    // - referencedConstants is dropped (JS/TS-specific concept)
    return jsExtracted.map(fn => ({
      name: fn.name,
      isAsync: fn.isAsync,
      isExported: fn.isExported,
      sourceText: fn.sourceText,
      docComment: fn.jsDoc,
      referencedImports: fn.referencedImports,
      contextHeader: fn.buildContext(sourceFile),
      startLine: fn.startLine,
      endLine: fn.endLine,
    }));
  }

  reassembleFunctions(
    original: string,
    extracted: ExtractedFunction[],
    results: FunctionResult[],
  ): string {
    // Extract only the fields reassembleFunctionsImpl uses (name, startLine, endLine).
    // This makes the dependency on the JS-specific type explicit: if the implementation
    // ever reads additional fields, the type error surfaces here rather than at runtime.
    type JsExtracted = Parameters<typeof reassembleFunctionsImpl>[1];
    const adapted = extracted.map(fn => ({
      name: fn.name,
      startLine: fn.startLine,
      endLine: fn.endLine,
      sourceText: fn.sourceText,
    })) as unknown as JsExtracted;
    return reassembleFunctionsImpl(original, adapted, results);
  }

  ensureTracerAfterImports(code: string): string {
    return ensureTracerAfterImportsImpl(code);
  }

  getFormatterConstraint(filePath: string): Promise<string> {
    return buildPrettierConstraint(filePath);
  }

  // ── LLM prompt context ────────────────────────────────────────────────────

  getSystemPromptSections(): LanguagePromptSections {
    return getSystemPromptSections();
  }

  getInstrumentationExamples(): Example[] {
    return getInstrumentationExamples();
  }

  // ── Package management ────────────────────────────────────────────────────

  installCommand(packages: string[]): string {
    return `npm install ${packages.join(' ')}`;
  }

  // ── Project metadata ──────────────────────────────────────────────────────

  async readProjectName(projectDir: string): Promise<string | undefined> {
    try {
      const content = await readFile(join(projectDir, 'package.json'), 'utf-8');
      // Parse errors (SyntaxError) propagate — corrupt package.json is a bug,
      // not a normal absence. Non-JSON strings throw at JSON.parse.
      const pkg = JSON.parse(content) as { name?: string };
      return pkg.name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // package.json doesn't exist — non-fatal, tracer name falls back to default.
        return undefined;
      }
      throw error;
    }
  }

  // ── Pre-instrumentation analysis ──────────────────────────────────────────

  preInstrumentationAnalysis(originalCode: string): PreScanResult {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', originalCode);

    // classifyFunctions returns metadata for both function declarations and
    // variable-assigned arrow/function expressions.
    const classified = classifyFunctions(sourceFile);

    // Build a name → node map covering both FunctionDeclaration nodes and
    // variable-assigned ArrowFunction/FunctionExpression nodes. The wide
    // import('ts-morph').Node type lets hasDirectProcessExit work on both.
    const fnNodeByName = new Map<string, import('ts-morph').Node>();
    for (const node of sourceFile.getFunctions()) {
      const name = node.getName();
      if (name) fnNodeByName.set(name, node);
    }
    for (const varStatement of sourceFile.getVariableStatements()) {
      for (const decl of varStatement.getDeclarations()) {
        const initializer = decl.getInitializer();
        if (!initializer) continue;
        const kind = initializer.getKind();
        if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) {
          fnNodeByName.set(decl.getName(), initializer);
        }
      }
    }

    // hasInstrumentableFunctions: false when there are no async functions at all.
    // Re-export files and all-sync utility files can be skipped without an LLM call.
    const hasInstrumentableFunctions = classified.some(fn => fn.isAsync);

    const entryPointsNeedingSpans: PreScanResult['entryPointsNeedingSpans'] = [];
    const processExitEntryPoints: PreScanResult['processExitEntryPoints'] = [];
    const asyncFunctionsNeedingSpans: PreScanResult['asyncFunctionsNeedingSpans'] = [];
    const pureSyncFunctions: PreScanResult['pureSyncFunctions'] = [];
    const unexportedFunctions: PreScanResult['unexportedFunctions'] = [];
    const outboundCallsNeedingSpans: PreScanResult['outboundCallsNeedingSpans'] = [];

    const entryPointNames = new Set<string>();

    // COV-001 + RST-006: identify entry points and process.exit() constraints
    for (const fn of classified) {
      const isEntryPoint = fn.isAsync && (fn.isExported || fn.name === 'main');
      if (!isEntryPoint) continue;

      entryPointNames.add(fn.name);
      entryPointsNeedingSpans.push({ name: fn.name, startLine: fn.startLine });

      const fnNode = fnNodeByName.get(fn.name);
      if (fnNode && hasDirectProcessExit(fnNode)) {
        // Detect inner try/catch blocks that must be preserved when the function is wrapped.
        const innerTryStatements = fnNode.getDescendantsOfKind(SyntaxKind.TryStatement);
        let constraintNote: string;
        if (innerTryStatements.length > 0) {
          const blockWord = innerTryStatements.length === 1 ? 'block' : 'blocks';
          const lineWord = innerTryStatements.length === 1 ? 'line' : 'lines';
          const lineList = innerTryStatements.map(t => t.getStartLineNumber()).join(', ');
          const preserveWord = innerTryStatements.length === 1 ? 'it' : 'them';
          // Process-first: CRITICAL constraint up front, then how-to, then don'ts.
          constraintNote =
            `CRITICAL: \`${fn.name}\` (line ${fn.startLine}) contains ${innerTryStatements.length} inner try/catch ${blockWord} at ${lineWord} ${lineList} — preserve ${preserveWord} exactly. ` +
            `Wrap the function by placing ALL original lines unchanged between \`try {\` and \`} finally { span.end(); }\`. ` +
            `Do NOT remove, merge, hoist, or omit any original line including the inner try/catch. ` +
            `Requires a span — COV-001. Has direct process.exit() calls: ` +
            `do NOT add span.end() before individual process.exit() calls. ` +
            `Do NOT add intermediate variables for setAttribute.`;
        } else {
          constraintNote =
            `Entry point \`${fn.name}\` (line ${fn.startLine}) requires a span — COV-001. ` +
            `Has direct process.exit() calls: place all original lines unchanged inside ` +
            `the try block (startActiveSpan → try { [all original lines here] } finally { span.end() }). ` +
            `Do NOT add span.end() before individual process.exit() calls — the finally block handles all exit paths. ` +
            `Do NOT add intermediate variables for setAttribute — use only variables already in scope.`;
        }
        processExitEntryPoints.push({ name: fn.name, startLine: fn.startLine, constraintNote });
      }
    }

    // COV-004 / RST-001 / RST-004: classify non-entry-point functions
    for (const fn of classified) {
      if (entryPointNames.has(fn.name)) continue;

      if (fn.isAsync) {
        // COV-004: async non-entry-point functions need spans — but apply the same
        // process.exit() exception as the prompt rule: if the function calls
        // process.exit() directly in its body, skip it (instrument sub-ops instead).
        const fnNode = fnNodeByName.get(fn.name);
        if (!fnNode || !hasDirectProcessExit(fnNode)) {
          asyncFunctionsNeedingSpans.push({ name: fn.name, startLine: fn.startLine });
        }
      } else {
        // RST-001: pure sync functions — no I/O to trace
        pureSyncFunctions.push({ name: fn.name, startLine: fn.startLine });
      }

      // RST-004: unexported functions are internal implementation details
      if (!fn.isExported) {
        unexportedFunctions.push({ name: fn.name, startLine: fn.startLine });
      }
    }

    // COV-002: detect outbound calls (HTTP, DB, messaging) in async function bodies.
    // Text-based pattern search — sufficient for advisory pre-scan guidance.
    const OUTBOUND_KEYWORDS = [
      { text: 'fetch(', label: 'fetch' },
      { text: 'axios.', label: 'axios' },
      { text: 'http.request(', label: 'http.request' },
      { text: 'https.request(', label: 'https.request' },
      { text: '.query(', label: 'db.query' },
      { text: '.execute(', label: 'db.execute' },
      { text: 'mongoose.', label: 'mongoose' },
      { text: 'prisma.', label: 'prisma' },
      { text: 'knex(', label: 'knex' },
      { text: 'sequelize.', label: 'sequelize' },
      { text: 'redis.', label: 'redis' },
      { text: '.sendToQueue(', label: 'amqp.sendToQueue' },
      { text: '.publish(', label: 'amqp.publish' },
    ];

    for (const fn of classified) {
      if (!fn.isAsync) continue;
      const fnNode = fnNodeByName.get(fn.name);
      if (!fnNode) continue;
      const bodyText = fnNode.getText();
      const calls = OUTBOUND_KEYWORDS
        .filter(kw => bodyText.includes(kw.text))
        .map(kw => ({ line: fn.startLine, callText: kw.label }));
      if (calls.length > 0) {
        outboundCallsNeedingSpans.push({ functionName: fn.name, calls });
      }
    }

    // M3: Local import analysis — per-entry-point sub-operation breakdown.
    // Build a map of imported name → source module from all import declarations.
    const namedImportMap = new Map<string, string>();
    for (const importDecl of sourceFile.getImportDeclarations()) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      for (const namedImport of importDecl.getNamedImports()) {
        namedImportMap.set(namedImport.getName(), moduleSpecifier);
      }
      const defaultImport = importDecl.getDefaultImport();
      if (defaultImport) {
        namedImportMap.set(defaultImport.getText(), moduleSpecifier);
      }
    }

    // Build a set of locally-defined function names (function declarations +
    // variable-assigned arrow/function expressions at file scope).
    const localFunctionNames = new Set<string>();
    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();
      if (name) localFunctionNames.add(name);
    }
    for (const varStatement of sourceFile.getVariableStatements()) {
      for (const decl of varStatement.getDeclarations()) {
        const initializer = decl.getInitializer();
        if (!initializer) continue;
        const kind = initializer.getKind();
        if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) {
          localFunctionNames.add(decl.getName());
        }
      }
    }

    // For each entry-point function, walk its call expressions to find identifier-callee
    // calls (not method calls). Categorize each as local or imported.
    const entryPointSubOperations: PreScanSubOperationGroup[] = [];
    for (const ep of entryPointsNeedingSpans) {
      const fnNode = fnNodeByName.get(ep.name);
      if (!fnNode) continue;

      const localSubOperations: string[] = [];
      const importedSubOperationMap = new Map<string, string>(); // name → sourceModule

      const callExprs = fnNode.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const callExpr of callExprs) {
        const callee = callExpr.getExpression();
        // Only plain identifier calls (e.g., `foo()`) — skip method calls like `obj.method()`
        if (callee.getKind() !== SyntaxKind.Identifier) continue;
        const calleeName = callee.getText();
        // Skip self-calls
        if (calleeName === ep.name) continue;
        // Skip if already seen
        if (localSubOperations.includes(calleeName) || importedSubOperationMap.has(calleeName)) continue;

        if (namedImportMap.has(calleeName)) {
          importedSubOperationMap.set(calleeName, namedImportMap.get(calleeName)!);
        } else if (localFunctionNames.has(calleeName)) {
          localSubOperations.push(calleeName);
        }
        // If neither local nor imported, omit per scope constraint.
      }

      const importedSubOperations = Array.from(importedSubOperationMap.entries()).map(
        ([name, sourceModule]) => ({ name, sourceModule }),
      );

      // Only emit a group when there is something to report.
      if (localSubOperations.length > 0 || importedSubOperations.length > 0) {
        entryPointSubOperations.push({ entryPointName: ep.name, localSubOperations, importedSubOperations });
      }
    }

    return {
      hasInstrumentableFunctions,
      entryPointsNeedingSpans,
      processExitEntryPoints,
      asyncFunctionsNeedingSpans,
      pureSyncFunctions,
      unexportedFunctions,
      outboundCallsNeedingSpans,
      entryPointSubOperations,
    };
  }

  // ── Feature parity check ──────────────────────────────────────────────────

  hasImplementation(ruleId: string): boolean {
    // Check whether this provider has registered a ValidationRule for the given ID.
    // The constructor registers all JS rules; this query reflects actual coverage.
    return JS_RULES.some(rule => rule.ruleId === ruleId);
  }
}
