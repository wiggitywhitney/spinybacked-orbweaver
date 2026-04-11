// ABOUTME: Golden file integration tests for the TypeScript instrumentation pipeline.
// ABOUTME: Verifies that known-correct instrumented TypeScript output passes the full validation chain.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateFile } from "../../../src/validation/chain.ts";
import { TypeScriptProvider } from "../../../src/languages/typescript/index.ts";

// Write temp files INSIDE the project tree so tsc can walk up and find node_modules.
// The TypeScript checkSyntax step runs tsc --noEmit; module resolution starts from
// the temp file's directory and walks up to the project root's node_modules.
const FIXTURES_DIR = join(
  import.meta.dirname,
  "../../fixtures/languages/typescript",
);
const TMP_BASE = join(import.meta.dirname, "../.."); // => test/ directory

const TS_PROVIDER = new TypeScriptProvider();

// Tier 2 config used for all TypeScript golden tests.
// Enables the TypeScript-specific rules (COV-001, COV-003, NDS-004, NDS-006)
// plus key inherited rules (CDQ-001, NDS-003, RST-001).
const TIER2_CONFIG = {
  enableWeaver: false,
  tier2Checks: {
    "CDQ-001": { enabled: true, blocking: true },
    "NDS-003": { enabled: true, blocking: true },
    "COV-001": { enabled: true, blocking: true },
    "COV-003": { enabled: true, blocking: true },
    "NDS-004": { enabled: true, blocking: false },
    "NDS-006": { enabled: true, blocking: false },
    "NDS-005": { enabled: false, blocking: false },
    "RST-001": { enabled: true, blocking: false },
  },
} as const;

// ── Fixture: express-handler ──────────────────────────────────────────────────

describe("TypeScript golden file — express handler", () => {
  let tmpDir: string;
  let tmpFilePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(TMP_BASE, "tmp-ts-golden-"));
    tmpFilePath = join(tmpDir, "express-handler.ts");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("known-correct instrumented output passes the validation chain", async () => {
    const originalCode = readFileSync(
      join(FIXTURES_DIR, "express-handler.before.ts"),
      "utf-8",
    );
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "express-handler.after.ts"),
      "utf-8",
    );

    writeFileSync(tmpFilePath, instrumentedCode, "utf-8");

    const result = await validateFile({
      originalCode,
      instrumentedCode,
      filePath: tmpFilePath,
      provider: TS_PROVIDER,
      config: TIER2_CONFIG,
    });

    expect(
      result.passed,
      `Validation failed: ${result.blockingFailures.map((f) => `${f.ruleId}: ${f.message}`).join(", ")}`,
    ).toBe(true);
    expect(result.blockingFailures).toHaveLength(0);
  });

  it("instrumented fixture has OTel imports and span calls (spansAdded > 0)", () => {
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "express-handler.after.ts"),
      "utf-8",
    );

    expect(instrumentedCode).toContain("@opentelemetry/api");
    expect(instrumentedCode).toContain("startActiveSpan");

    const spanCallCount = (
      instrumentedCode.match(/startActiveSpan|startSpan/g) ?? []
    ).length;
    expect(spanCallCount).toBeGreaterThan(0);
  });

  it("instrumented fixture passes syntax check via TypeScript provider", async () => {
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "express-handler.after.ts"),
      "utf-8",
    );
    writeFileSync(tmpFilePath, instrumentedCode, "utf-8");

    const syntaxResult = await TS_PROVIDER.checkSyntax(tmpFilePath);
    expect(
      syntaxResult.passed,
      `Syntax check failed: ${syntaxResult.message}`,
    ).toBe(true);
  });

  it("instrumented fixture has more OTel patterns than original (instrumentation was added)", () => {
    const originalCode = readFileSync(
      join(FIXTURES_DIR, "express-handler.before.ts"),
      "utf-8",
    );
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "express-handler.after.ts"),
      "utf-8",
    );

    const originalOTelCount = (originalCode.match(/@opentelemetry/g) ?? [])
      .length;
    const instrumentedOTelCount = (
      instrumentedCode.match(/@opentelemetry/g) ?? []
    ).length;

    expect(instrumentedOTelCount).toBeGreaterThan(originalOTelCount);
  });

  it("type annotations are preserved in instrumented TypeScript (no types stripped)", () => {
    const originalCode = readFileSync(
      join(FIXTURES_DIR, "express-handler.before.ts"),
      "utf-8",
    );
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "express-handler.after.ts"),
      "utf-8",
    );

    // Key TypeScript type annotations must remain unchanged after instrumentation
    expect(instrumentedCode).toContain("Promise<void>");
    expect(instrumentedCode).toContain("ServiceRequest");
    expect(instrumentedCode).toContain("ServiceResponse");
    expect(instrumentedCode).toContain("catch (err: unknown)");

    // Type annotation count should be >= original (never stripped)
    const typeAnnotationCount = (instrumentedCode.match(/: [A-Z]/g) ?? [])
      .length;
    const originalAnnotationCount = (originalCode.match(/: [A-Z]/g) ?? [])
      .length;
    expect(typeAnnotationCount).toBeGreaterThanOrEqual(originalAnnotationCount);
  });
});

// ── Fixture: NestJS controller ────────────────────────────────────────────────

describe("TypeScript golden file — NestJS controller", () => {
  let tmpDir: string;
  let tmpFilePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(TMP_BASE, "tmp-ts-golden-"));
    tmpFilePath = join(tmpDir, "nestjs-controller.ts");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("known-correct instrumented output passes the validation chain", async () => {
    const originalCode = readFileSync(
      join(FIXTURES_DIR, "nestjs-controller.before.ts"),
      "utf-8",
    );
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "nestjs-controller.after.ts"),
      "utf-8",
    );

    writeFileSync(tmpFilePath, instrumentedCode, "utf-8");

    const result = await validateFile({
      originalCode,
      instrumentedCode,
      filePath: tmpFilePath,
      provider: TS_PROVIDER,
      config: TIER2_CONFIG,
    });

    expect(
      result.passed,
      `Validation failed: ${result.blockingFailures.map((f) => `${f.ruleId}: ${f.message}`).join(", ")}`,
    ).toBe(true);
    expect(result.blockingFailures).toHaveLength(0);
  });

  it("instrumented fixture has spans on each @Get and @Post method", () => {
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "nestjs-controller.after.ts"),
      "utf-8",
    );

    // NestJS-specific: both route methods should be wrapped in spans
    const spanCallCount = (
      instrumentedCode.match(/startActiveSpan/g) ?? []
    ).length;
    expect(spanCallCount).toBeGreaterThanOrEqual(2);
    expect(instrumentedCode).toContain("@Controller");
    expect(instrumentedCode).toContain("@Get");
    expect(instrumentedCode).toContain("@Post");
  });

  it("instrumented fixture passes syntax check via TypeScript provider", async () => {
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "nestjs-controller.after.ts"),
      "utf-8",
    );
    writeFileSync(tmpFilePath, instrumentedCode, "utf-8");

    const syntaxResult = await TS_PROVIDER.checkSyntax(tmpFilePath);
    expect(
      syntaxResult.passed,
      `Syntax check failed: ${syntaxResult.message}`,
    ).toBe(true);
  });

  it("class decorator pattern is preserved (decorators not stripped)", () => {
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "nestjs-controller.after.ts"),
      "utf-8",
    );

    expect(instrumentedCode).toContain('@Controller("users")');
    expect(instrumentedCode).toContain('@Get(":id")');
    expect(instrumentedCode).toContain("@Post()");
    expect(instrumentedCode).toContain("class UserController");
  });
});

// ── Fixture: generic utility ──────────────────────────────────────────────────

describe("TypeScript golden file — generic utility function", () => {
  let tmpDir: string;
  let tmpFilePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(TMP_BASE, "tmp-ts-golden-"));
    tmpFilePath = join(tmpDir, "generic-utility.ts");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("known-correct instrumented output passes the validation chain", async () => {
    const originalCode = readFileSync(
      join(FIXTURES_DIR, "generic-utility.before.ts"),
      "utf-8",
    );
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "generic-utility.after.ts"),
      "utf-8",
    );

    writeFileSync(tmpFilePath, instrumentedCode, "utf-8");

    const result = await validateFile({
      originalCode,
      instrumentedCode,
      filePath: tmpFilePath,
      provider: TS_PROVIDER,
      config: TIER2_CONFIG,
    });

    expect(
      result.passed,
      `Validation failed: ${result.blockingFailures.map((f) => `${f.ruleId}: ${f.message}`).join(", ")}`,
    ).toBe(true);
    expect(result.blockingFailures).toHaveLength(0);
  });

  it("instrumented fixture passes syntax check via TypeScript provider", async () => {
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "generic-utility.after.ts"),
      "utf-8",
    );
    writeFileSync(tmpFilePath, instrumentedCode, "utf-8");

    const syntaxResult = await TS_PROVIDER.checkSyntax(tmpFilePath);
    expect(
      syntaxResult.passed,
      `Syntax check failed: ${syntaxResult.message}`,
    ).toBe(true);
  });

  it("generic type parameters are preserved after instrumentation", () => {
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "generic-utility.after.ts"),
      "utf-8",
    );

    // Type parameters <T, R> must survive instrumentation
    expect(instrumentedCode).toContain("processItems<T, R>");
    expect(instrumentedCode).toContain("items: T[]");
    expect(instrumentedCode).toContain("transform: (item: T) => Promise<R>");
    expect(instrumentedCode).toContain("Promise<R[]>");
    expect(instrumentedCode).toContain("identity<T>");
  });
});

// ── Fixture: TSX component ────────────────────────────────────────────────────

describe("TypeScript golden file — TSX component", () => {
  let tmpDir: string;
  let tmpFilePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(TMP_BASE, "tmp-ts-golden-"));
    tmpFilePath = join(tmpDir, "tsx-component.tsx");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("known-correct instrumented output passes the validation chain", async () => {
    const originalCode = readFileSync(
      join(FIXTURES_DIR, "tsx-component.before.tsx"),
      "utf-8",
    );
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "tsx-component.after.tsx"),
      "utf-8",
    );

    writeFileSync(tmpFilePath, instrumentedCode, "utf-8");

    const result = await validateFile({
      originalCode,
      instrumentedCode,
      filePath: tmpFilePath,
      provider: TS_PROVIDER,
      config: TIER2_CONFIG,
    });

    expect(
      result.passed,
      `Validation failed: ${result.blockingFailures.map((f) => `${f.ruleId}: ${f.message}`).join(", ")}`,
    ).toBe(true);
    expect(result.blockingFailures).toHaveLength(0);
  });

  it("instrumented fixture passes syntax check via TypeScript provider (tsx)", async () => {
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "tsx-component.after.tsx"),
      "utf-8",
    );
    writeFileSync(tmpFilePath, instrumentedCode, "utf-8");

    const syntaxResult = await TS_PROVIDER.checkSyntax(tmpFilePath);
    expect(
      syntaxResult.passed,
      `Syntax check failed: ${syntaxResult.message}`,
    ).toBe(true);
  });

  it("JSX syntax is preserved and OTel instrumentation is added", () => {
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "tsx-component.after.tsx"),
      "utf-8",
    );

    // JSX elements must survive instrumentation
    expect(instrumentedCode).toContain("<form");
    expect(instrumentedCode).toContain("<input");
    expect(instrumentedCode).toContain("</form>");

    // OTel instrumentation must be present
    expect(instrumentedCode).toContain("@opentelemetry/api");
    expect(instrumentedCode).toContain("startActiveSpan");
    expect(instrumentedCode).toContain("catch (err: unknown)");
  });

  it("instrumented TSX fixture has more OTel patterns than original", () => {
    const originalCode = readFileSync(
      join(FIXTURES_DIR, "tsx-component.before.tsx"),
      "utf-8",
    );
    const instrumentedCode = readFileSync(
      join(FIXTURES_DIR, "tsx-component.after.tsx"),
      "utf-8",
    );

    const originalOTelCount = (originalCode.match(/@opentelemetry/g) ?? [])
      .length;
    const instrumentedOTelCount = (
      instrumentedCode.match(/@opentelemetry/g) ?? []
    ).length;

    expect(instrumentedOTelCount).toBeGreaterThan(originalOTelCount);
  });
});
