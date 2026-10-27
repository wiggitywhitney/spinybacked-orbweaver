// ABOUTME: SDK init file writing module for the coordinator.
// ABOUTME: Uses ts-morph to find NodeSDK instrumentations array and append new entries and @traceloop/* activation code, with fallback for unrecognized patterns.

import { Project, SyntaxKind, Node } from 'ts-morph';
import { writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LibraryRequirement } from '../agent/schema.ts';

/** Filename for the fallback instrumentation file when NodeSDK pattern isn't recognized. */
const FALLBACK_FILENAME = 'spiny-orb-instrumentations.js';

/** Generator name embedded in fallback file headers. */
const GENERATED_BY = 'spiny-orb';

/**
 * Result of updating the SDK init file.
 */
export interface SdkInitResult {
  /** Whether the SDK init file was successfully updated. */
  updated: boolean;
  /** Whether a fallback file was written instead. */
  fallbackWritten: boolean;
  /** Path to the fallback file, if written. */
  fallbackPath?: string;
  /** Warning message explaining the fallback, if applicable. */
  warning?: string;
}

/**
 * Read the project's package.json to check for "type": "module".
 * Returns true if ESM, false if CJS, null if package.json not found or unreadable.
 */
async function detectModuleSystemFromPackageJson(projectDir: string): Promise<boolean | null> {
  try {
    const pkgPath = join(projectDir, 'package.json');
    const pkgText = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgText);
    if (pkg.type === 'module') return true;
    return false;
  } catch {
    return null;
  }
}

/**
 * Detect whether a file uses ES module imports or CommonJS require.
 * Checks for import/export statements as ESM indicators.
 */
function isEsmFile(sourceText: string): boolean {
  return /^\s*(import|export)\s/m.test(sourceText);
}

/**
 * Find import names already present in the file text.
 * Used to avoid adding duplicate imports.
 */
function findExistingImportNames(sourceText: string): Set<string> {
  const names = new Set<string>();
  // Match ES import: import { Name } from '...'
  const esImports = sourceText.matchAll(/import\s*\{([^}]+)\}\s*from/g);
  for (const match of esImports) {
    for (const name of match[1].split(',')) {
      names.add(name.trim());
    }
  }
  // Match CJS require: const { Name } = require('...')
  const cjsRequires = sourceText.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(/g);
  for (const match of cjsRequires) {
    for (const name of match[1].split(',')) {
      names.add(name.trim());
    }
  }
  return names;
}

/**
 * Find instrumentation class names already in the instrumentations array.
 * Detects patterns like `new HttpInstrumentation()`.
 */
function findExistingInstrumentations(arrayText: string): Set<string> {
  const names = new Set<string>();
  const matches = arrayText.matchAll(/new\s+(\w+)\s*\(/g);
  for (const match of matches) {
    names.add(match[1]);
  }
  return names;
}

/**
 * How the module that `manuallyInstrument` wraps is loaded.
 * - `namespace`: the module's namespace object (`import * as x`).
 * - `default`: the module's default export (`import x`; CommonJS `require(...).default`).
 * - `named`: one named export, aliased to `binding`.
 * - `commonjs`: the CommonJS module, loaded with `createRequire` under ESM.
 */
type ModuleShape = 'namespace' | 'default' | 'named' | 'commonjs';

/**
 * Activation recorded for one @traceloop/* package: its exported class, the
 * name of the generated instance, and the module its `manuallyInstrument`
 * call wraps.
 */
interface TraceloopActivation {
  className: string;
  instanceName: string;
  specifier: string;
  shape: ModuleShape;
  /** Local name the loaded module is bound to. */
  binding: string;
  /** Export to load when `shape` is `named`. */
  exportName?: string;
  /** Argument passed to `manuallyInstrument`. */
  argument: string;
}

function activation(
  className: string,
  specifier: string,
  shape: ModuleShape,
  binding: string,
  overrides: Partial<TraceloopActivation> = {},
): TraceloopActivation {
  const instanceName = className.charAt(0).toLowerCase() + className.slice(1);
  return { className, instanceName, specifier, shape, binding, argument: binding, ...overrides };
}

/**
 * Activation for every @traceloop/* package spiny-orb generates setup code for,
 * keyed by package name. Class names, modules and arguments come from the
 * installed 0.27.0 packages: none of them activates on a bare
 * `manuallyInstrument()`, and under ESM on a current SDK the module hook alone
 * activates none of them, so each needs its own argument.
 */
const TRACELOOP_ACTIVATIONS: ReadonlyMap<string, TraceloopActivation> = new Map([
  ['@traceloop/instrumentation-anthropic', activation('AnthropicInstrumentation', '@anthropic-ai/sdk', 'namespace', 'anthropicModule')],
  ['@traceloop/instrumentation-openai', activation('OpenAIInstrumentation', 'openai', 'default', 'OpenAI')],
  ['@traceloop/instrumentation-bedrock', activation('BedrockInstrumentation', '@aws-sdk/client-bedrock-runtime', 'namespace', 'bedrockModule')],
  ['@traceloop/instrumentation-vertexai', activation('VertexAIInstrumentation', '@google-cloud/vertexai', 'namespace', 'vertexAIModule')],
  ['@traceloop/instrumentation-cohere', activation('CohereInstrumentation', 'cohere-ai', 'namespace', 'cohereModule')],
  ['@traceloop/instrumentation-together', activation('TogetherInstrumentation', 'together-ai', 'default', 'Together')],
  ['@traceloop/instrumentation-langchain', activation(
    'LangChainInstrumentation', '@langchain/core/callbacks/manager', 'namespace', 'callbackManagerModule',
    { argument: '{ callbackManagerModule }' },
  )],
  ['@traceloop/instrumentation-llamaindex', activation('LlamaIndexInstrumentation', 'llamaindex', 'namespace', 'llamaindexModule')],
  ['@traceloop/instrumentation-mcp', activation(
    'McpInstrumentation', '@modelcontextprotocol/sdk/client/index.js', 'named', 'McpClient',
    { exportName: 'Client', argument: '{ Client: McpClient }' },
  )],
  ['@traceloop/instrumentation-pinecone', activation('PineconeInstrumentation', '@pinecone-database/pinecone', 'namespace', 'pineconeModule')],
  ['@traceloop/instrumentation-qdrant', activation('QdrantInstrumentation', '@qdrant/js-client-rest', 'namespace', 'qdrantModule')],
  // The ESM namespace is read-only and this package replaces an export, so it needs the CommonJS module.
  ['@traceloop/instrumentation-google-generativeai', activation('GenAIInstrumentation', '@google/genai', 'commonjs', 'googleGenAIModule')],
]);

const TRACE_CONTENT_OPTION =
  "{ traceContent: process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === 'true' }";

const TRACE_CONTENT_COMMENT = `// Each @traceloop/* constructor below receives traceContent from
// OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT. Traceloop does not read that variable
// itself; this code bridges it. Set it to 'true' to capture prompt and completion content.`;

const FALLBACK_GATE_COMMENT = `// Each @traceloop/* instance below is always active when you import this array.
// To gate one behind a flag instead, copy the array into your own setup file without that
// package's imports, const, manuallyInstrument call and entry. Then add those lines back
// inside a conditional, such as if (process.env.YOUR_TRACELOOP_FLAG === 'true') { ... }.`;

const NODESDK_GATE_COMMENT = `// Each @traceloop/* instance below is always active.
// To gate one behind a flag instead, move that package's const and manuallyInstrument call
// inside a conditional, such as if (process.env.YOUR_TRACELOOP_FLAG === 'true') { ... },
// and add its entry to the instrumentations array only when the flag is set.`;

/** Import line for an instrumentation class. */
function classImportLine(lib: LibraryRequirement, esm: boolean): string {
  return esm
    ? `import { ${lib.importName} } from '${lib.package}';`
    : `const { ${lib.importName} } = require('${lib.package}');`;
}

/** Import lines that load the module an activation's `manuallyInstrument` call wraps. */
function moduleImportLines(act: TraceloopActivation, esm: boolean): string[] {
  const { specifier, binding } = act;
  switch (act.shape) {
    case 'namespace':
      return [esm ? `import * as ${binding} from '${specifier}';` : `const ${binding} = require('${specifier}');`];
    case 'default':
      return [esm ? `import ${binding} from '${specifier}';` : `const ${binding} = require('${specifier}').default;`];
    case 'named':
      return [esm
        ? `import { ${act.exportName} as ${binding} } from '${specifier}';`
        : `const { ${act.exportName}: ${binding} } = require('${specifier}');`];
    case 'commonjs':
      return [esm ? `import { createRequire } from 'node:module';` : `const ${binding} = require('${specifier}');`];
  }
}

/** Statements that construct an activation's instance and call `manuallyInstrument` on it. */
function activationStatements(act: TraceloopActivation, esm: boolean): string[] {
  const load = act.shape === 'commonjs' && esm
    ? [`const ${act.binding} = createRequire(import.meta.url)('${act.specifier}');`]
    : [];
  return [
    ...load,
    `const ${act.instanceName} = new ${act.className}(${TRACE_CONTENT_OPTION});`,
    `${act.instanceName}.manuallyInstrument(${act.argument});`,
  ];
}

/** Warning for a @traceloop/* package with no entry in TRACELOOP_ACTIVATIONS. */
function unrecordedWarning(pkg: string): string {
  return `spiny-orb has no recorded activation for ${pkg}, so it was left out of the generated setup.`;
}

/** Warning for a @traceloop/* package already in the NodeSDK array as an inline `new X()`. */
function inlineEntryWarning(pkg: string, act: TraceloopActivation, esm: boolean): string {
  return `${pkg} is already in the NodeSDK instrumentations array as an inline ` +
    `\`new ${act.className}(...)\`, which may not activate under ESM without a manuallyInstrument call. ` +
    `spiny-orb left it unchanged. To activate it, add these lines and replace the inline entry ` +
    `with ${act.instanceName}:\n` +
    [...moduleImportLines(act, esm), ...activationStatements(act, esm)].join('\n');
}

/**
 * Update the SDK init file with new instrumentation entries.
 *
 * Uses ts-morph to find the `new NodeSDK({ instrumentations: [...] })` pattern.
 * Appends new entries to the array and adds corresponding import statements.
 * Each @traceloop/* library is declared as a named instance that receives an
 * explicit `manuallyInstrument` call before it is listed in the array.
 * If the pattern doesn't match, writes a fallback `spiny-orb-instrumentations.js` file
 * in the same directory as the SDK init file.
 *
 * @param sdkInitFilePath - Absolute path to the SDK init file
 * @param libraries - Library requirements to add (deduplicated by package name)
 * @returns Result indicating whether the file was updated or a fallback was written
 */
export async function updateSdkInitFile(
  sdkInitFilePath: string,
  libraries: LibraryRequirement[],
  projectDir?: string,
): Promise<SdkInitResult> {
  // Deduplicate by package name
  const uniqueLibraries = deduplicateLibraries(libraries);

  if (uniqueLibraries.length === 0) {
    return { updated: false, fallbackWritten: false };
  }

  // @traceloop/* packages without a recorded activation are left out; recorded ones
  // use the recorded class name, whatever importName the agent supplied.
  const warnings: string[] = [];
  const recognizedLibraries: LibraryRequirement[] = [];
  for (const lib of uniqueLibraries) {
    const act = TRACELOOP_ACTIVATIONS.get(lib.package);
    if (act) {
      recognizedLibraries.push({ ...lib, importName: act.className });
    } else if (lib.package.startsWith('@traceloop/')) {
      warnings.push(unrecordedWarning(lib.package));
    } else {
      recognizedLibraries.push(lib);
    }
  }

  if (recognizedLibraries.length === 0) {
    return { updated: false, fallbackWritten: false, warning: joinWarnings(warnings) };
  }

  const sourceText = await readFile(sdkInitFilePath, 'utf-8');

  // package.json "type" field is the primary signal; file content is the fallback
  const pkgEsm = projectDir != null ? await detectModuleSystemFromPackageJson(projectDir) : null;
  const esm = pkgEsm ?? isEsmFile(sourceText);

  // Try to find and update the NodeSDK instrumentations array
  const updateResult = tryUpdateNodeSdkPattern(sourceText, recognizedLibraries, esm);

  if (updateResult !== null) {
    warnings.push(...updateResult.warnings);
    if (updateResult.text === sourceText) {
      // All libraries already present — no changes needed
      return { updated: false, fallbackWritten: false, warning: joinWarnings(warnings) };
    }
    await writeFile(sdkInitFilePath, updateResult.text, 'utf-8');
    return { updated: true, fallbackWritten: false, warning: joinWarnings(warnings) };
  }

  // Fallback: write spiny-orb-instrumentations.js
  const fallbackPath = join(dirname(sdkInitFilePath), FALLBACK_FILENAME);
  const fallbackContent = generateFallbackFile(recognizedLibraries, esm);
  await writeFile(fallbackPath, fallbackContent, 'utf-8');

  warnings.unshift(
    `SDK init file does not match recognized NodeSDK pattern. ` +
    `Instrumentation config written to ${FALLBACK_FILENAME} — ` +
    `integrate manually into your telemetry setup.`,
  );
  return {
    updated: false,
    fallbackWritten: true,
    fallbackPath,
    warning: joinWarnings(warnings),
  };
}

/**
 * Combine warnings into one message, or undefined when there are none.
 * Each warning starts on its own line, because some end with code lines to copy.
 */
function joinWarnings(warnings: string[]): string | undefined {
  return warnings.length > 0 ? warnings.join('\n') : undefined;
}

/**
 * Deduplicate libraries by package name, keeping the first occurrence.
 */
function deduplicateLibraries(libraries: LibraryRequirement[]): LibraryRequirement[] {
  const seen = new Set<string>();
  return libraries.filter(lib => {
    if (seen.has(lib.package)) return false;
    seen.add(lib.package);
    return true;
  });
}

/**
 * Try to find and update the NodeSDK instrumentations array pattern.
 * Returns the updated source text plus any warnings, or null if the pattern wasn't found.
 * Returns the original source text unchanged if all libraries are already present.
 */
function tryUpdateNodeSdkPattern(
  sourceText: string,
  libraries: LibraryRequirement[],
  esm: boolean,
): { text: string; warnings: string[] } | null {
  const project = new Project({ useInMemoryFileSystem: true });
  // ts-morph needs .ts extension for parsing, but it handles JS syntax fine
  const sourceFile = project.createSourceFile('sdk-init.ts', sourceText);

  // Find `new NodeSDK(...)` expression
  const newExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression);
  const nodeSdkNew = newExpressions.find(expr => {
    const exprText = expr.getExpression().getText();
    return exprText === 'NodeSDK';
  });

  if (!nodeSdkNew) return null;

  // Get the first argument (should be an object literal)
  const args = nodeSdkNew.getArguments();
  if (args.length === 0) return null;

  const firstArg = args[0];
  if (!Node.isObjectLiteralExpression(firstArg)) return null;

  // Find the instrumentations property
  const instrProp = firstArg.getProperty('instrumentations');
  if (!instrProp || !Node.isPropertyAssignment(instrProp)) return null;

  const initializer = instrProp.getInitializer();
  if (!initializer || !Node.isArrayLiteralExpression(initializer)) return null;

  // Reject arrays containing spread elements or anything other than new expressions,
  // calls, and identifiers (identifiers hold generated @traceloop/* instances)
  const elements = initializer.getElements();
  if (elements.length > 0) {
    const hasUnsupportedElement = elements.some(el =>
      Node.isSpreadElement(el) ||
      (!Node.isNewExpression(el) && !Node.isCallExpression(el) && !Node.isIdentifier(el)),
    );
    if (hasUnsupportedElement) return null;
  }

  // Determine which libraries need to be added to the array vs imported
  const arrayText = initializer.getText();
  const existingInstrumentations = findExistingInstrumentations(arrayText);
  const existingIdentifiers = new Set(elements.filter(el => Node.isIdentifier(el)).map(el => el.getText()));
  const existingImports = findExistingImportNames(sourceText);

  const warnings: string[] = [];
  const librariesForArray: LibraryRequirement[] = [];
  for (const lib of libraries) {
    const act = TRACELOOP_ACTIVATIONS.get(lib.package);
    if (act && existingIdentifiers.has(act.instanceName)) continue;
    if (existingInstrumentations.has(lib.importName)) {
      if (act) warnings.push(inlineEntryWarning(lib.package, act, esm));
      continue;
    }
    librariesForArray.push(lib);
  }

  if (librariesForArray.length === 0) {
    return { text: sourceText, warnings }; // All already in the array
  }

  // Add new entries to the instrumentations array
  const activations: TraceloopActivation[] = [];
  for (const lib of librariesForArray) {
    const act = TRACELOOP_ACTIVATIONS.get(lib.package);
    if (act) {
      activations.push(act);
      initializer.addElement(act.instanceName);
    } else {
      initializer.addElement(`new ${lib.importName}()`);
    }
  }

  // Declare and activate @traceloop/* instances just before the statement that builds the NodeSDK
  if (activations.length > 0) {
    let statement: Node = nodeSdkNew;
    let container = statement.getParentOrThrow();
    while (!Node.isSourceFile(container) && !Node.isBlock(container)) {
      statement = container;
      container = statement.getParentOrThrow();
    }
    // Leading newline keeps a blank line between the imports and the block
    const block = [
      '',
      NODESDK_GATE_COMMENT,
      '//',
      TRACE_CONTENT_COMMENT,
      ...activations.flatMap(act => activationStatements(act, esm)),
    ].join('\n');
    const index = container.getStatements().findIndex(s => s === statement);
    container.insertStatements(index, block);
  }

  // Only add imports for libraries not already imported
  const importStatements = librariesForArray
    .filter(lib => !existingImports.has(lib.importName))
    .map(lib => classImportLine(lib, esm));
  for (const act of activations) {
    const createRequireImported = act.shape === 'commonjs' && esm && existingImports.has('createRequire');
    for (const line of moduleImportLines(act, esm)) {
      if (!createRequireImported && !importStatements.includes(line)) importStatements.push(line);
    }
  }

  // Insert imports at the top of the file (after existing imports)
  const fullText = sourceFile.getFullText();
  if (importStatements.length === 0) {
    return { text: fullText, warnings }; // Only array changes, no new imports needed
  }
  const lastImportIndex = findLastImportPosition(fullText, esm);
  const updatedText = fullText.slice(0, lastImportIndex) +
    importStatements.join('\n') + '\n' +
    fullText.slice(lastImportIndex);

  return { text: updatedText, warnings };
}

/**
 * Find the position right after the last import/require statement.
 * This is where new import statements should be inserted.
 */
function findLastImportPosition(text: string, esm: boolean): number {
  const lines = text.split('\n');
  let lastImportLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (esm && line.startsWith('import ')) {
      lastImportLine = i;
    } else if (!esm && /(?:const|let|var)\s.*=\s*require\(/.test(line)) {
      lastImportLine = i;
    }
  }

  if (lastImportLine === -1) {
    // No imports found — insert at the beginning
    return 0;
  }

  // Return position after the last import line (including its newline)
  let pos = 0;
  for (let i = 0; i <= lastImportLine; i++) {
    pos += lines[i].length + 1; // +1 for the \n consumed by split
  }
  return pos;
}

/**
 * Generate fallback file content with instrumentation exports.
 * Respects the source file's module system (ESM vs CJS).
 */
function generateFallbackFile(libraries: LibraryRequirement[], esm: boolean): string {
  const activations = libraries.flatMap(lib => {
    const act = TRACELOOP_ACTIVATIONS.get(lib.package);
    return act ? [act] : [];
  });
  const entries = libraries.map(lib => {
    const act = TRACELOOP_ACTIVATIONS.get(lib.package);
    return act ? act.instanceName : `new ${lib.importName}()`;
  });

  const imports = [
    ...libraries.map(lib => classImportLine(lib, esm)),
    ...new Set(activations.flatMap(act => moduleImportLines(act, esm))),
  ].join('\n');
  const gate = activations.length > 0 ? `//\n${FALLBACK_GATE_COMMENT}\n` : '';
  const activationBlock = activations.length > 0
    ? `${TRACE_CONTENT_COMMENT}\n${activations.flatMap(act => activationStatements(act, esm)).join('\n')}\n\n`
    : '';

  if (esm) {
    const instances = entries.map(entry => `  ${entry},`).join('\n');
    return `// Generated by ${GENERATED_BY}
// spiny-orb overwrites this file each time it writes this fallback,
// so make your changes in your own telemetry setup file, not here.
// The SDK init file did not match the recognized NodeSDK pattern.
// Add the instrumentations array below to your OpenTelemetry SDK setup:
//
//   import { NodeSDK } from '@opentelemetry/sdk-node';
//   import { instrumentations } from './spiny-orb-instrumentations.js';
//
//   const sdk = new NodeSDK({ instrumentations, ... });
//   sdk.start();
${gate}
${imports}

${activationBlock}export const instrumentations = [
${instances}
];
`;
  }

  const instances = entries.map(entry => `    ${entry},`).join('\n');
  return `// Generated by ${GENERATED_BY}
// spiny-orb overwrites this file each time it writes this fallback,
// so make your changes in your own telemetry setup file, not here.
// The SDK init file did not match the recognized NodeSDK pattern.
// Add the instrumentations array below to your OpenTelemetry SDK setup:
//
//   const { NodeSDK } = require('@opentelemetry/sdk-node');
//   const { instrumentations } = require('./spiny-orb-instrumentations.js');
//
//   const sdk = new NodeSDK({ instrumentations, ... });
//   sdk.start();
${gate}
${imports}

${activationBlock}module.exports = {
  instrumentations: [
${instances}
  ],
};
`;
}
