// ABOUTME: SDK init file writing module for the coordinator.
// ABOUTME: Uses ts-morph to find NodeSDK instrumentations array and append new entries, with fallback for unrecognized patterns.

import { Project, SyntaxKind, Node } from 'ts-morph';
import { writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LibraryRequirement } from '../agent/schema.ts';

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
 * Update the SDK init file with new instrumentation entries.
 *
 * Uses ts-morph to find the `new NodeSDK({ instrumentations: [...] })` pattern.
 * Appends new entries to the array and adds corresponding import statements.
 * If the pattern doesn't match, writes a fallback `orb-instrumentations.js` file
 * in the same directory as the SDK init file.
 *
 * @param sdkInitFilePath - Absolute path to the SDK init file
 * @param libraries - Library requirements to add (deduplicated by package name)
 * @returns Result indicating whether the file was updated or a fallback was written
 */
export async function updateSdkInitFile(
  sdkInitFilePath: string,
  libraries: LibraryRequirement[],
): Promise<SdkInitResult> {
  // Deduplicate by package name
  const uniqueLibraries = deduplicateLibraries(libraries);

  if (uniqueLibraries.length === 0) {
    return { updated: false, fallbackWritten: false };
  }

  const sourceText = await readFile(sdkInitFilePath, 'utf-8');
  const esm = isEsmFile(sourceText);

  // Try to find and update the NodeSDK instrumentations array
  const updateResult = tryUpdateNodeSdkPattern(sourceText, uniqueLibraries, esm);

  if (updateResult !== null) {
    if (updateResult === sourceText) {
      // All libraries already present — no changes needed
      return { updated: false, fallbackWritten: false };
    }
    await writeFile(sdkInitFilePath, updateResult, 'utf-8');
    return { updated: true, fallbackWritten: false };
  }

  // Fallback: write orb-instrumentations.js (or .mjs for ESM projects)
  const fallbackPath = join(dirname(sdkInitFilePath), 'orb-instrumentations.js');
  const fallbackContent = generateFallbackFile(uniqueLibraries, esm);
  await writeFile(fallbackPath, fallbackContent, 'utf-8');

  return {
    updated: false,
    fallbackWritten: true,
    fallbackPath,
    warning: `SDK init file does not match recognized NodeSDK pattern. ` +
      `Instrumentation config written to orb-instrumentations.js — ` +
      `integrate manually into your telemetry setup.`,
  };
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
 * Returns the updated source text, or null if the pattern wasn't found.
 * Returns the original source text unchanged if all libraries are already present.
 */
function tryUpdateNodeSdkPattern(
  sourceText: string,
  libraries: LibraryRequirement[],
  esm: boolean,
): string | null {
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

  // Reject arrays containing spread elements or non-new-expression elements (except empty arrays)
  const elements = initializer.getElements();
  if (elements.length > 0) {
    const hasNonNewExpression = elements.some(el =>
      Node.isSpreadElement(el) || (!Node.isNewExpression(el) && !Node.isCallExpression(el)),
    );
    if (hasNonNewExpression) return null;
  }

  // Determine which libraries need to be added to the array vs imported
  const arrayText = initializer.getText();
  const existingInstrumentations = findExistingInstrumentations(arrayText);
  const existingImports = findExistingImportNames(sourceText);

  // Libraries not yet in the instrumentations array need to be added
  const librariesForArray = libraries.filter(
    lib => !existingInstrumentations.has(lib.importName),
  );

  if (librariesForArray.length === 0) {
    return sourceText; // All already in the array
  }

  // Add new entries to the instrumentations array
  for (const lib of librariesForArray) {
    initializer.addElement(`new ${lib.importName}()`);
  }

  // Only add imports for libraries not already imported
  const librariesNeedingImport = librariesForArray.filter(
    lib => !existingImports.has(lib.importName),
  );

  const importStatements = librariesNeedingImport.map(lib => {
    if (esm) {
      return `import { ${lib.importName} } from '${lib.package}';`;
    }
    return `const { ${lib.importName} } = require('${lib.package}');`;
  });

  // Insert imports at the top of the file (after existing imports)
  const fullText = sourceFile.getFullText();
  if (importStatements.length === 0) {
    return fullText; // Only array changes, no new imports needed
  }
  const lastImportIndex = findLastImportPosition(fullText, esm);
  const updatedText = fullText.slice(0, lastImportIndex) +
    importStatements.join('\n') + '\n' +
    fullText.slice(lastImportIndex);

  return updatedText;
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
  const newlineLen = text.includes('\r\n') ? 2 : 1;
  let pos = 0;
  for (let i = 0; i <= lastImportLine; i++) {
    pos += lines[i].length + newlineLen;
  }
  return pos;
}

/**
 * Generate fallback file content with instrumentation exports.
 * Respects the source file's module system (ESM vs CJS).
 */
function generateFallbackFile(libraries: LibraryRequirement[], esm: boolean): string {
  const instances = libraries.map(
    lib => `  new ${lib.importName}(),`,
  ).join('\n');

  if (esm) {
    const imports = libraries.map(
      lib => `import { ${lib.importName} } from '${lib.package}';`,
    ).join('\n');

    return `// Generated by spinybacked-orbweaver
// The SDK init file did not match the recognized NodeSDK pattern.
// Add these instrumentations to your OpenTelemetry SDK setup manually.

${imports}

export const instrumentations = [
${instances}
];
`;
  }

  const imports = libraries.map(
    lib => `const { ${lib.importName} } = require('${lib.package}');`,
  ).join('\n');

  return `// Generated by spinybacked-orbweaver
// The SDK init file did not match the recognized NodeSDK pattern.
// Add these instrumentations to your OpenTelemetry SDK setup manually.

${imports}

module.exports = {
  instrumentations: [
${instances}
  ],
};
`;
}
