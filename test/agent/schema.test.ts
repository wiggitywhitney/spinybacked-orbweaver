// ABOUTME: Tests for the InstrumentationOutput Zod schemas.
// ABOUTME: Validates LLM output parsing, type constraints, and edge cases.

import { describe, it, expect } from 'vitest';
import {
  LibraryRequirementSchema,
  SpanCategoriesSchema,
  LlmOutputSchema,
  LlmSuggestedRefactorSchema,
  TokenUsageSchema,
  InstrumentationOutputSchema,
} from '../../src/agent/schema.ts';

describe('LibraryRequirementSchema', () => {
  it('accepts valid library requirement', () => {
    const result = LibraryRequirementSchema.parse({
      package: '@opentelemetry/instrumentation-pg',
      importName: 'PgInstrumentation',
    });
    expect(result.package).toBe('@opentelemetry/instrumentation-pg');
    expect(result.importName).toBe('PgInstrumentation');
  });

  it('rejects missing fields', () => {
    expect(() => LibraryRequirementSchema.parse({ package: 'foo' })).toThrow();
    expect(() => LibraryRequirementSchema.parse({ importName: 'Foo' })).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() =>
      LibraryRequirementSchema.parse({
        package: 'foo',
        importName: 'Foo',
        extra: true,
      }),
    ).toThrow();
  });
});

describe('SpanCategoriesSchema', () => {
  it('accepts valid span categories', () => {
    const result = SpanCategoriesSchema.parse({
      externalCalls: 2,
      schemaDefined: 1,
      serviceEntryPoints: 1,
      totalFunctionsInFile: 12,
    });
    expect(result.externalCalls).toBe(2);
    expect(result.totalFunctionsInFile).toBe(12);
  });

  it('rejects negative numbers', () => {
    expect(() =>
      SpanCategoriesSchema.parse({
        externalCalls: -1,
        schemaDefined: 0,
        serviceEntryPoints: 0,
        totalFunctionsInFile: 5,
      }),
    ).toThrow();
  });

  it('rejects non-integer numbers', () => {
    expect(() =>
      SpanCategoriesSchema.parse({
        externalCalls: 1.5,
        schemaDefined: 0,
        serviceEntryPoints: 0,
        totalFunctionsInFile: 5,
      }),
    ).toThrow();
  });
});

describe('LlmSuggestedRefactorSchema', () => {
  const validRefactor = {
    description: 'Extract nested ternary into a const variable',
    diff: '- const result = a ? b : c ? d : e;\n+ const intermediate = c ? d : e;\n+ const result = a ? b : intermediate;',
    reason: 'setAttribute requires a simple variable reference, not a nested expression',
    unblocksRules: ['NDS-003'],
    startLine: 42,
    endLine: 44,
  };

  it('accepts a valid suggested refactor', () => {
    const result = LlmSuggestedRefactorSchema.parse(validRefactor);
    expect(result.description).toBe('Extract nested ternary into a const variable');
    expect(result.unblocksRules).toEqual(['NDS-003']);
    expect(result.startLine).toBe(42);
  });

  it('accepts multiple unblocked rules', () => {
    const result = LlmSuggestedRefactorSchema.parse({
      ...validRefactor,
      unblocksRules: ['NDS-003', 'COV-003'],
    });
    expect(result.unblocksRules).toHaveLength(2);
  });

  it('rejects missing description', () => {
    const { description: _, ...partial } = validRefactor;
    expect(() => LlmSuggestedRefactorSchema.parse(partial)).toThrow();
  });

  it('rejects missing diff', () => {
    const { diff: _, ...partial } = validRefactor;
    expect(() => LlmSuggestedRefactorSchema.parse(partial)).toThrow();
  });

  it('rejects negative line numbers', () => {
    expect(() => LlmSuggestedRefactorSchema.parse({
      ...validRefactor,
      startLine: -1,
    })).toThrow();
  });

  it('rejects non-integer line numbers', () => {
    expect(() => LlmSuggestedRefactorSchema.parse({
      ...validRefactor,
      startLine: 1.5,
    })).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => LlmSuggestedRefactorSchema.parse({
      ...validRefactor,
      extra: 'not allowed',
    })).toThrow();
  });

  it('rejects zero line numbers (1-based required)', () => {
    expect(() => LlmSuggestedRefactorSchema.parse({
      ...validRefactor,
      startLine: 0,
    })).toThrow();
  });

  it('rejects endLine less than startLine', () => {
    expect(() => LlmSuggestedRefactorSchema.parse({
      ...validRefactor,
      startLine: 10,
      endLine: 9,
    })).toThrow();
  });

  it('rejects empty unblocksRules', () => {
    expect(() => LlmSuggestedRefactorSchema.parse({
      ...validRefactor,
      unblocksRules: [],
    })).toThrow();
  });
});

describe('LlmOutputSchema', () => {
  const validOutput = {
    instrumentedCode: 'const x = 1;',
    librariesNeeded: [
      { package: '@opentelemetry/instrumentation-pg', importName: 'PgInstrumentation' },
    ],
    schemaExtensions: ['span.payment.process'],
    attributesCreated: 2,
    spanCategories: {
      externalCalls: 1,
      schemaDefined: 1,
      serviceEntryPoints: 0,
      totalFunctionsInFile: 8,
    },
    notes: ['Skipped utility function formatDate — pure sync helper under 5 lines'],
  };

  it('accepts valid LLM output', () => {
    const result = LlmOutputSchema.parse(validOutput);
    expect(result.instrumentedCode).toBe('const x = 1;');
    expect(result.librariesNeeded).toHaveLength(1);
    expect(result.notes).toHaveLength(1);
  });

  it('accepts null spanCategories', () => {
    const result = LlmOutputSchema.parse({ ...validOutput, spanCategories: null });
    expect(result.spanCategories).toBeNull();
  });

  it('accepts empty arrays', () => {
    const result = LlmOutputSchema.parse({
      ...validOutput,
      librariesNeeded: [],
      schemaExtensions: [],
      notes: [],
    });
    expect(result.librariesNeeded).toHaveLength(0);
  });

  it('rejects missing instrumentedCode', () => {
    const { instrumentedCode: _, ...partial } = validOutput;
    expect(() => LlmOutputSchema.parse(partial)).toThrow();
  });

  it('defaults suggestedRefactors to empty array when omitted', () => {
    const result = LlmOutputSchema.parse(validOutput);
    expect(result.suggestedRefactors).toEqual([]);
  });

  it('accepts suggestedRefactors with valid entries', () => {
    const result = LlmOutputSchema.parse({
      ...validOutput,
      suggestedRefactors: [{
        description: 'Extract expression to const',
        diff: '- foo(bar)\n+ const val = bar;\n+ foo(val)',
        reason: 'setAttribute needs a variable reference',
        unblocksRules: ['NDS-003'],
        startLine: 10,
        endLine: 12,
      }],
    });
    expect(result.suggestedRefactors).toHaveLength(1);
    expect(result.suggestedRefactors[0].unblocksRules).toEqual(['NDS-003']);
  });

  it('accepts empty suggestedRefactors array', () => {
    const result = LlmOutputSchema.parse({
      ...validOutput,
      suggestedRefactors: [],
    });
    expect(result.suggestedRefactors).toEqual([]);
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => LlmOutputSchema.parse({ ...validOutput, tokenUsage: {} })).toThrow();
  });
});

describe('TokenUsageSchema', () => {
  it('accepts valid token usage', () => {
    const result = TokenUsageSchema.parse({
      inputTokens: 5000,
      outputTokens: 2000,
      cacheCreationInputTokens: 4000,
      cacheReadInputTokens: 0,
    });
    expect(result.inputTokens).toBe(5000);
  });

  it('accepts all zeros', () => {
    const result = TokenUsageSchema.parse({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(result.inputTokens).toBe(0);
  });

  it('rejects negative values', () => {
    expect(() =>
      TokenUsageSchema.parse({
        inputTokens: -1,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toThrow();
  });
});

describe('InstrumentationOutputSchema', () => {
  const validFull = {
    instrumentedCode: 'import { trace } from "@opentelemetry/api";\nconst x = 1;',
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    spanCategories: {
      externalCalls: 0,
      schemaDefined: 0,
      serviceEntryPoints: 1,
      totalFunctionsInFile: 3,
    },
    notes: ['Added span to exported async function processOrder'],
    tokenUsage: {
      inputTokens: 5000,
      outputTokens: 2000,
      cacheCreationInputTokens: 4000,
      cacheReadInputTokens: 0,
    },
  };

  it('accepts valid full output', () => {
    const result = InstrumentationOutputSchema.parse(validFull);
    expect(result.tokenUsage.inputTokens).toBe(5000);
    expect(result.notes).toHaveLength(1);
  });

  it('rejects missing tokenUsage', () => {
    const { tokenUsage: _, ...partial } = validFull;
    expect(() => InstrumentationOutputSchema.parse(partial)).toThrow();
  });

  it('defaults suggestedRefactors to empty array when omitted', () => {
    const result = InstrumentationOutputSchema.parse(validFull);
    expect(result.suggestedRefactors).toEqual([]);
  });

  it('preserves suggestedRefactors when provided', () => {
    const result = InstrumentationOutputSchema.parse({
      ...validFull,
      suggestedRefactors: [{
        description: 'Extract expression',
        diff: '- x\n+ const y = x',
        reason: 'needs const for setAttribute',
        unblocksRules: ['NDS-003'],
        startLine: 5,
        endLine: 6,
      }],
    });
    expect(result.suggestedRefactors).toHaveLength(1);
  });
});
