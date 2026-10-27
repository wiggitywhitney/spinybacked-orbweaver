// ABOUTME: Unit tests for the SDK init file writing module.
// ABOUTME: Covers NodeSDK pattern detection, instrumentation appending, import insertion, fallback file writing, and @traceloop/* activation code.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LibraryRequirement } from '../../src/agent/schema.ts';
import { updateSdkInitFile } from '../../src/coordinator/sdk-init.ts';

const execFileAsync = promisify(execFile);

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sdk-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

/** Helper to create an SDK init file with content. */
async function createSdkInitFile(content: string): Promise<string> {
  const filePath = join(testDir, 'setup.js');
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

/** Build a LibraryRequirement for testing. */
function makeLibrary(pkg: string, importName: string): LibraryRequirement {
  return { package: pkg, importName };
}

describe('updateSdkInitFile', () => {
  describe('NodeSDK pattern detection with ES imports', () => {
    it('appends new instrumentations when array contains a call expression like getNodeAutoInstrumentations()', async () => {
      // Exact SDK_INIT_CONTENT used in the coordinator acceptance gate test
      await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
      const sdkFile = await createSdkInitFile(
        `import { NodeSDK } from '@opentelemetry/sdk-node';\n` +
        `import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';\n\n` +
        `const sdk = new NodeSDK({\n` +
        `  instrumentations: [\n` +
        `    getNodeAutoInstrumentations(),\n` +
        `  ],\n` +
        `});\n\n` +
        `sdk.start();\n`,
      );

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-express', 'ExpressInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.updated).toBe(true);
      expect(result.fallbackWritten).toBe(false);

      const content = await readFile(sdkFile, 'utf-8');
      expect(content).toContain("import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express'");
      expect(content).toContain('new ExpressInstrumentation()');
      // Original call expression must be preserved
      expect(content).toContain('getNodeAutoInstrumentations()');
    });

    it('appends new instrumentations to an existing NodeSDK instrumentations array', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const sdk = new NodeSDK({
  instrumentations: [
    new HttpInstrumentation(),
  ],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);
      expect(result.fallbackWritten).toBe(false);

      const content = await readFile(sdkFile, 'utf-8');
      expect(content).toContain("import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'");
      expect(content).toContain('new PgInstrumentation()');
      // Original entries preserved
      expect(content).toContain('new HttpInstrumentation()');
    });

    it('appends multiple new instrumentations', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-redis', 'RedisInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      expect(content).toContain('new HttpInstrumentation()');
      expect(content).toContain('new PgInstrumentation()');
      expect(content).toContain('new RedisInstrumentation()');
    });

    it('skips libraries already present in the instrumentations array', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const sdk = new NodeSDK({
  instrumentations: [
    new HttpInstrumentation(),
  ],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      // PgInstrumentation added
      expect(content).toContain('new PgInstrumentation()');
      // HttpInstrumentation not duplicated — count occurrences of 'new HttpInstrumentation()'
      const matches = content.match(/new HttpInstrumentation\(\)/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('NodeSDK pattern detection with CommonJS require', () => {
    it('detects and updates NodeSDK pattern with require()', async () => {
      const sdkFile = await createSdkInitFile(`
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');

const sdk = new NodeSDK({
  instrumentations: [
    new HttpInstrumentation(),
  ],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);
      expect(result.fallbackWritten).toBe(false);

      const content = await readFile(sdkFile, 'utf-8');
      // CJS file gets CJS-style require
      expect(content).toContain("const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg')");
      expect(content).toContain('new PgInstrumentation()');
    });
  });

  describe('fallback behavior', () => {
    it('writes fallback file when no NodeSDK pattern found', async () => {
      const sdkFile = await createSdkInitFile(`
// Custom telemetry setup without NodeSDK
const instrumentations = buildInstrumentations();
startTelemetry(instrumentations);
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(false);
      expect(result.fallbackWritten).toBe(true);
      expect(result.fallbackPath).toBeDefined();

      const fallbackContent = await readFile(result.fallbackPath!, 'utf-8');
      expect(fallbackContent).toContain('HttpInstrumentation');
      expect(fallbackContent).toContain('PgInstrumentation');
      expect(fallbackContent).toContain('@opentelemetry/instrumentation-http');
      expect(fallbackContent).toContain('@opentelemetry/instrumentation-pg');
    });

    it('writes fallback when instrumentations property uses non-array pattern', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getInstrumentations } from './instrumentations';

const sdk = new NodeSDK({
  instrumentations: getInstrumentations(),
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(false);
      expect(result.fallbackWritten).toBe(true);
    });

    it('writes fallback when instrumentations use spread operator', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { baseInstrumentations } from './base';

const sdk = new NodeSDK({
  instrumentations: [...baseInstrumentations],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(false);
      expect(result.fallbackWritten).toBe(true);
    });

    it('writes ESM fallback when source file is ESM', async () => {
      const sdkFile = await createSdkInitFile(`
import { startTelemetry } from './telemetry';

// Custom setup without NodeSDK
startTelemetry();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.fallbackWritten).toBe(true);
      const fallbackContent = await readFile(result.fallbackPath!, 'utf-8');
      // Should use ESM import/export syntax
      expect(fallbackContent).toContain("import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'");
      expect(fallbackContent).toContain('export');
      // Should NOT use require/module.exports
      expect(fallbackContent).not.toContain('require(');
      expect(fallbackContent).not.toContain('module.exports');
    });

    it('returns warning message for fallback', async () => {
      const sdkFile = await createSdkInitFile(`
// No NodeSDK pattern
console.log('setup');
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('spiny-orb-instrumentations.js');
    });
  });

  describe('Traceloop activation', () => {
    const NO_NODESDK_ESM = `
import { startTelemetry } from './telemetry';
startTelemetry();
`;
    const NO_NODESDK_CJS = `
const { startTelemetry } = require('./telemetry');
startTelemetry();
`;
    const NODESDK_ESM = `
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`;
    const NODESDK_CJS = `
const { NodeSDK } = require('@opentelemetry/sdk-node');

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`;

    const TRACE_CONTENT = "{ traceContent: process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT === 'true' }";

    const BRIDGE_COMMENT = [
      '// Each @traceloop/* constructor below receives traceContent from',
      '// OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT. Traceloop does not read that variable',
      "// itself; this code bridges it. Set it to 'true' to capture prompt and completion content.",
    ].join('\n');

    const FALLBACK_GATE_COMMENT = [
      '// Each @traceloop/* instance below is always active when you import this array.',
      '// To gate one behind a flag instead, copy the array into your own setup file without that',
      "// package's imports, const, manuallyInstrument call and entry. Then add those lines back",
      "// inside a conditional, such as if (process.env.YOUR_TRACELOOP_FLAG === 'true') { ... }.",
    ].join('\n');

    const NODESDK_GATE_COMMENT = [
      '// Each @traceloop/* instance below is always active.',
      "// To gate one behind a flag instead, move that package's const and manuallyInstrument call",
      "// inside a conditional, such as if (process.env.YOUR_TRACELOOP_FLAG === 'true') { ... },",
      '// and add its entry to the instrumentations array only when the flag is set.',
    ].join('\n');

    const REGENERATED_NOTE = [
      '// spiny-orb overwrites this file each time it writes this fallback,',
      '// so make your changes in your own telemetry setup file, not here.',
    ].join('\n');

    /**
     * Activation shape recorded for each @traceloop/* package by PRD #1075's M2
     * installed-package check: class name, the module that wraps the SDK, and the
     * argument manuallyInstrument receives.
     */
    interface RecordedActivation {
      pkg: string;
      cls: string;
      instance: string;
      esmImports: string[];
      /** Statements that must run before the const in ESM (createRequire loads). */
      esmStatements: string[];
      cjsImports: string[];
      arg: string;
    }

    function namespace(pkg: string, cls: string, instance: string, sdk: string, binding: string): RecordedActivation {
      return {
        pkg, cls, instance,
        esmImports: [`import * as ${binding} from '${sdk}';`],
        esmStatements: [],
        cjsImports: [`const ${binding} = require('${sdk}');`],
        arg: binding,
      };
    }
    function defaultExport(pkg: string, cls: string, instance: string, sdk: string, binding: string): RecordedActivation {
      return {
        pkg, cls, instance,
        esmImports: [`import ${binding} from '${sdk}';`],
        esmStatements: [],
        cjsImports: [`const ${binding} = require('${sdk}').default;`],
        arg: binding,
      };
    }

    const RECORDED: RecordedActivation[] = [
      namespace('@traceloop/instrumentation-anthropic', 'AnthropicInstrumentation', 'anthropicInstrumentation', '@anthropic-ai/sdk', 'anthropicModule'),
      defaultExport('@traceloop/instrumentation-openai', 'OpenAIInstrumentation', 'openAIInstrumentation', 'openai', 'OpenAI'),
      namespace('@traceloop/instrumentation-bedrock', 'BedrockInstrumentation', 'bedrockInstrumentation', '@aws-sdk/client-bedrock-runtime', 'bedrockModule'),
      namespace('@traceloop/instrumentation-vertexai', 'VertexAIInstrumentation', 'vertexAIInstrumentation', '@google-cloud/vertexai', 'vertexAIModule'),
      namespace('@traceloop/instrumentation-cohere', 'CohereInstrumentation', 'cohereInstrumentation', 'cohere-ai', 'cohereModule'),
      defaultExport('@traceloop/instrumentation-together', 'TogetherInstrumentation', 'togetherInstrumentation', 'together-ai', 'Together'),
      {
        ...namespace('@traceloop/instrumentation-langchain', 'LangChainInstrumentation', 'langChainInstrumentation', '@langchain/core/callbacks/manager', 'callbackManagerModule'),
        arg: '{ callbackManagerModule }',
      },
      namespace('@traceloop/instrumentation-llamaindex', 'LlamaIndexInstrumentation', 'llamaIndexInstrumentation', 'llamaindex', 'llamaindexModule'),
      {
        pkg: '@traceloop/instrumentation-mcp',
        cls: 'McpInstrumentation',
        instance: 'mcpInstrumentation',
        esmImports: ["import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';"],
        esmStatements: [],
        cjsImports: ["const { Client: McpClient } = require('@modelcontextprotocol/sdk/client/index.js');"],
        arg: '{ Client: McpClient }',
      },
      namespace('@traceloop/instrumentation-pinecone', 'PineconeInstrumentation', 'pineconeInstrumentation', '@pinecone-database/pinecone', 'pineconeModule'),
      namespace('@traceloop/instrumentation-qdrant', 'QdrantInstrumentation', 'qdrantInstrumentation', '@qdrant/js-client-rest', 'qdrantModule'),
      {
        pkg: '@traceloop/instrumentation-google-generativeai',
        cls: 'GenAIInstrumentation',
        instance: 'genAIInstrumentation',
        esmImports: ["import { createRequire } from 'node:module';"],
        esmStatements: ["const googleGenAIModule = createRequire(import.meta.url)('@google/genai');"],
        cjsImports: ["const googleGenAIModule = require('@google/genai');"],
        arg: 'googleGenAIModule',
      },
    ];

    const http = makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation');
    const asLibrary = (r: RecordedActivation): LibraryRequirement => makeLibrary(r.pkg, r.cls);

    /** Contents of the instrumentations array literal (fallback export or NodeSDK option). */
    function arrayBody(content: string): string {
      const match = content.match(/instrumentations(?:\s*=|:)\s*\[([\s\S]*?)\]/);
      expect(match, 'instrumentations array not found').not.toBeNull();
      return match![1];
    }

    type Path = 'fallback' | 'NodeSDK';
    type Format = 'ESM' | 'CommonJS';

    function sourceFor(path: Path, format: Format): string {
      if (path === 'fallback') return format === 'ESM' ? NO_NODESDK_ESM : NO_NODESDK_CJS;
      return format === 'ESM' ? NODESDK_ESM : NODESDK_CJS;
    }

    /** Run updateSdkInitFile and return the generated code for the path under test. */
    async function generate(
      path: Path,
      format: Format,
      libraries: LibraryRequirement[],
    ): Promise<{ content: string; warning?: string }> {
      await writeFile(
        join(testDir, 'package.json'),
        JSON.stringify(format === 'ESM' ? { type: 'module' } : { type: 'commonjs' }),
        'utf-8',
      );
      const sdkFile = await createSdkInitFile(sourceFor(path, format));
      const result = await updateSdkInitFile(sdkFile, libraries, testDir);
      if (path === 'fallback') {
        expect(result.fallbackWritten).toBe(true);
        return { content: await readFile(result.fallbackPath!, 'utf-8'), warning: result.warning };
      }
      expect(result.fallbackWritten).toBe(false);
      return { content: await readFile(sdkFile, 'utf-8'), warning: result.warning };
    }

    const PATHS: Path[] = ['fallback', 'NodeSDK'];
    const FORMATS: Format[] = ['ESM', 'CommonJS'];

    for (const path of PATHS) {
      for (const format of FORMATS) {
        describe(`${path} path, ${format}`, () => {
          for (const recorded of RECORDED) {
            it(`emits the recorded import, const and manuallyInstrument call for ${recorded.pkg}`, async () => {
              const { content } = await generate(path, format, [asLibrary(recorded)]);

              const classImport = format === 'ESM'
                ? `import { ${recorded.cls} } from '${recorded.pkg}';`
                : `const { ${recorded.cls} } = require('${recorded.pkg}');`;
              expect(content).toContain(classImport);
              for (const line of format === 'ESM' ? recorded.esmImports : recorded.cjsImports) {
                expect(content).toContain(line);
              }
              for (const line of format === 'ESM' ? recorded.esmStatements : []) {
                expect(content).toContain(line);
              }
              expect(content).toContain(`const ${recorded.instance} = new ${recorded.cls}(${TRACE_CONTENT});`);
              expect(content).toContain(`${recorded.instance}.manuallyInstrument(${recorded.arg});`);
            });

            it(`lists the same identifier in the array that receives manuallyInstrument for ${recorded.pkg}`, async () => {
              const { content } = await generate(path, format, [asLibrary(recorded)]);

              const declared = content.match(new RegExp(`const (\\w+) = new ${recorded.cls}\\(`));
              expect(declared).not.toBeNull();
              const name = declared![1];
              expect(content).toContain(`${name}.manuallyInstrument(`);
              expect(arrayBody(content)).toMatch(new RegExp(`(^|[\\s,])${name}([\\s,]|$)`));
              // Exactly one instance: no second `new` inside the array
              expect(content.match(new RegExp(`new ${recorded.cls}\\(`, 'g'))).toHaveLength(1);
            });
          }

          it('emits syntactically valid code for every recorded package together', async () => {
            const { content } = await generate(path, format, [http, ...RECORDED.map(asLibrary)]);

            const ext = format === 'ESM' ? 'mjs' : 'cjs';
            const checkFile = join(testDir, `syntax-check.${ext}`);
            await writeFile(checkFile, content, 'utf-8');
            await expect(execFileAsync(process.execPath, ['--check', checkFile])).resolves.toBeDefined();
          });

          it('places the activation code after the imports and before the code that uses the array', async () => {
            const { content } = await generate(path, format, [asLibrary(RECORDED[0])]);

            const lastImport = format === 'ESM'
              ? content.lastIndexOf("import * as anthropicModule from '@anthropic-ai/sdk';")
              : content.lastIndexOf("const anthropicModule = require('@anthropic-ai/sdk');");
            const declaration = content.indexOf('const anthropicInstrumentation = ');
            const consumer = path === 'fallback'
              ? content.search(/instrumentations(\s*=|:)\s*\[/)
              : content.indexOf('new NodeSDK(');
            expect(lastImport).toBeGreaterThan(-1);
            expect(declaration).toBeGreaterThan(lastImport);
            expect(consumer).toBeGreaterThan(declaration);
          });

          it('wraps no activation call in try/catch', async () => {
            const { content } = await generate(path, format, RECORDED.map(asLibrary));

            expect(content).not.toMatch(/\btry\s*\{/);
            expect(content).not.toMatch(/\bcatch\s*[({]/);
          });

          it('never emits a bare manuallyInstrument() call', async () => {
            const { content } = await generate(path, format, RECORDED.map(asLibrary));

            expect(content).not.toContain('manuallyInstrument()');
          });

          it('explains the traceContent bridge and does not mention OTEL_SEMCONV_STABILITY_OPT_IN', async () => {
            const { content } = await generate(path, format, RECORDED.map(asLibrary));

            expect(content).toContain(BRIDGE_COMMENT);
            expect(content).not.toContain('OTEL_SEMCONV_STABILITY_OPT_IN');
          });

          it('points the gate-behind-a-flag comment at the generated lines instead of showing examples', async () => {
            const { content } = await generate(path, format, [http, asLibrary(RECORDED[0])]);

            expect(content).toContain(path === 'fallback' ? FALLBACK_GATE_COMMENT : NODESDK_GATE_COMMENT);
            expect(content).not.toContain('SomeInstrumentation');
            expect(content).not.toContain('new LangChainInstrumentation().manuallyInstrument');
          });

          it('emits no Traceloop activation code or comments when no @traceloop/* package is needed', async () => {
            const { content } = await generate(path, format, [http]);

            expect(content).not.toContain('manuallyInstrument');
            expect(content).not.toContain('@traceloop/');
            expect(content).not.toContain('traceContent');
            expect(content).toContain('new HttpInstrumentation()');
          });

          it('leaves out a @traceloop/* package with no recorded activation and names it in the warning', async () => {
            const chromadb = makeLibrary('@traceloop/instrumentation-chromadb', 'ChromaDBInstrumentation');
            const { content, warning } = await generate(path, format, [http, chromadb]);

            expect(content).not.toContain('chromadb');
            expect(content).not.toContain('ChromaDBInstrumentation');
            expect(content).toContain('new HttpInstrumentation()');
            expect(warning).toContain(
              'spiny-orb has no recorded activation for @traceloop/instrumentation-chromadb, so it was left out of the generated setup.',
            );
          });

          it('uses the recorded class name instead of the agent-provided importName', async () => {
            const { content } = await generate(path, format, [
              makeLibrary('@traceloop/instrumentation-mcp', 'MCPInstrumentation'),
            ]);

            expect(content).toContain('McpInstrumentation');
            expect(content).not.toContain('MCPInstrumentation');
          });
        });
      }
    }

    for (const format of FORMATS) {
      it(`notes in the fallback header that the file is regenerated (${format})`, async () => {
        const { content } = await generate('fallback', format, [http]);

        expect(content).toContain(REGENERATED_NOTE);
      });
    }

    describe('existing entries in the NodeSDK array', () => {
      const EXISTING_INLINE_ESM = `
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AnthropicInstrumentation } from '@traceloop/instrumentation-anthropic';

const sdk = new NodeSDK({
  instrumentations: [
    new AnthropicInstrumentation({ traceContent: false }),
  ],
});

sdk.start();
`;

      it('leaves an inline @traceloop/* entry unchanged and gives the activation lines in the warning', async () => {
        await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
        const sdkFile = await createSdkInitFile(EXISTING_INLINE_ESM);

        const result = await updateSdkInitFile(
          sdkFile,
          [makeLibrary('@traceloop/instrumentation-anthropic', 'AnthropicInstrumentation')],
          testDir,
        );

        expect(result.updated).toBe(false);
        expect(result.fallbackWritten).toBe(false);
        expect(await readFile(sdkFile, 'utf-8')).toBe(EXISTING_INLINE_ESM);
        expect(result.warning).toContain('@traceloop/instrumentation-anthropic');
        expect(result.warning).toContain('manuallyInstrument');
        expect(result.warning).toContain("import * as anthropicModule from '@anthropic-ai/sdk';");
        expect(result.warning).toContain(`const anthropicInstrumentation = new AnthropicInstrumentation(${TRACE_CONTENT});`);
        expect(result.warning).toContain('anthropicInstrumentation.manuallyInstrument(anthropicModule);');
      });

      it('starts each warning on its own line so copied activation lines carry no trailing prose', async () => {
        await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
        const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AnthropicInstrumentation } from '@traceloop/instrumentation-anthropic';
import { OpenAIInstrumentation } from '@traceloop/instrumentation-openai';

const sdk = new NodeSDK({
  instrumentations: [
    new AnthropicInstrumentation(),
    new OpenAIInstrumentation(),
  ],
});

sdk.start();
`);

        const result = await updateSdkInitFile(
          sdkFile,
          [
            makeLibrary('@traceloop/instrumentation-anthropic', 'AnthropicInstrumentation'),
            makeLibrary('@traceloop/instrumentation-openai', 'OpenAIInstrumentation'),
            makeLibrary('@traceloop/instrumentation-chromadb', 'ChromaDBInstrumentation'),
          ],
          testDir,
        );

        const lines = result.warning!.split('\n');
        expect(lines).toContain('anthropicInstrumentation.manuallyInstrument(anthropicModule);');
        expect(lines).toContain('openAIInstrumentation.manuallyInstrument(OpenAI);');
      });

      it('matches an existing inline entry by the recorded class name, not the agent-provided importName', async () => {
        await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
        const source = `
import { NodeSDK } from '@opentelemetry/sdk-node';
import { McpInstrumentation } from '@traceloop/instrumentation-mcp';

const sdk = new NodeSDK({
  instrumentations: [
    new McpInstrumentation(),
  ],
});

sdk.start();
`;
        const sdkFile = await createSdkInitFile(source);

        const result = await updateSdkInitFile(
          sdkFile,
          [makeLibrary('@traceloop/instrumentation-mcp', 'MCPInstrumentation')],
          testDir,
        );

        expect(result.updated).toBe(false);
        expect(await readFile(sdkFile, 'utf-8')).toBe(source);
        expect(result.warning).toContain('@traceloop/instrumentation-mcp');
      });

      for (const format of FORMATS) {
        it(`is a no-op without a warning on a second run over its own generated code (${format})`, async () => {
          const libraries = [http, ...RECORDED.map(asLibrary)];
          await writeFile(
            join(testDir, 'package.json'),
            JSON.stringify(format === 'ESM' ? { type: 'module' } : { type: 'commonjs' }),
            'utf-8',
          );
          const sdkFile = await createSdkInitFile(sourceFor('NodeSDK', format));

          const first = await updateSdkInitFile(sdkFile, libraries, testDir);
          expect(first.updated).toBe(true);
          const afterFirst = await readFile(sdkFile, 'utf-8');

          const second = await updateSdkInitFile(sdkFile, libraries, testDir);
          expect(second.updated).toBe(false);
          expect(second.fallbackWritten).toBe(false);
          expect(second.warning).toBeUndefined();
          expect(await readFile(sdkFile, 'utf-8')).toBe(afterFirst);
        });
      }

      it('does not duplicate an existing createRequire import', async () => {
        await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
        const sdkFile = await createSdkInitFile(`
import { createRequire } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

        await updateSdkInitFile(
          sdkFile,
          [makeLibrary('@traceloop/instrumentation-google-generativeai', 'GenAIInstrumentation')],
          testDir,
        );

        const content = await readFile(sdkFile, 'utf-8');
        expect(content.match(/import \{ createRequire \}/g)).toHaveLength(1);
        expect(content).toContain('genAIInstrumentation.manuallyInstrument(googleGenAIModule);');
      });
    });
  });

  describe('package.json type detection', () => {
    it('generates ESM imports when package.json has "type": "module" even if file has no imports', async () => {
      // Write a package.json with "type": "module" in the test dir
      await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');

      // SDK init file has no import/export keywords — isEsmFile() would return false
      const sdkFile = await createSdkInitFile(`
const { NodeSDK } = require('@opentelemetry/sdk-node');

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      // Should use ESM import, not CJS require
      expect(content).toContain("import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'");
      expect(content).not.toContain("require('@opentelemetry/instrumentation-pg')");
    });

    it('generates CJS require when package.json has no "type" field', async () => {
      await writeFile(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }), 'utf-8');

      const sdkFile = await createSdkInitFile(`
const { NodeSDK } = require('@opentelemetry/sdk-node');

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      // Should use CJS require
      expect(content).toContain("require('@opentelemetry/instrumentation-pg')");
      expect(content).not.toContain("import { PgInstrumentation }");
    });

    it('generates CJS require when package.json has explicit "type": "commonjs"', async () => {
      await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf-8');

      const sdkFile = await createSdkInitFile(`
const { NodeSDK } = require('@opentelemetry/sdk-node');

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      expect(content).toContain("require('@opentelemetry/instrumentation-pg')");
      expect(content).not.toContain("import { PgInstrumentation }");
    });

    it('falls back to file content heuristic when package.json is missing', async () => {
      // No package.json in testDir — should fall back to file content detection
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      // Pass a dir with no package.json
      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      // Should detect ESM from file content and use ESM imports
      expect(content).toContain("import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'");
    });

    it('generates ESM fallback when package.json has "type": "module"', async () => {
      await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');

      // File with no NodeSDK pattern and no ESM markers
      const sdkFile = await createSdkInitFile(`
// Custom setup
startTelemetry();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.fallbackWritten).toBe(true);
      const fallbackContent = await readFile(result.fallbackPath!, 'utf-8');
      expect(fallbackContent).toContain("import { HttpInstrumentation }");
      expect(fallbackContent).toContain('export');
      expect(fallbackContent).not.toContain('require(');
    });
  });

  describe('edge cases', () => {
    it('returns no-op when libraries array is empty', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const result = await updateSdkInitFile(sdkFile, []);

      expect(result.updated).toBe(false);
      expect(result.fallbackWritten).toBe(false);
    });

    it('returns no-op when all libraries already present', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const sdk = new NodeSDK({
  instrumentations: [
    new HttpInstrumentation(),
  ],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(false);
      expect(result.fallbackWritten).toBe(false);
    });

    it('adds to instrumentations array even when import already exists', async () => {
      // Library is imported but not in the instrumentations array — should add to array
      // without duplicating the import
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);
      const content = await readFile(sdkFile, 'utf-8');
      // Should be added to the array
      expect(content).toContain('new HttpInstrumentation()');
      // Import should not be duplicated
      const importMatches = content.match(/import \{ HttpInstrumentation \}/g);
      expect(importMatches).toHaveLength(1);
    });

    it('deduplicates libraries by package name', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);
      const content = await readFile(sdkFile, 'utf-8');
      const matches = content.match(/new PgInstrumentation\(\)/g);
      expect(matches).toHaveLength(1);
    });
  });
});
