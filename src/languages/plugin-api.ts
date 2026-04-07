// ABOUTME: Public plugin API for spiny-orb language providers.
// ABOUTME: External language provider packages import types from "spiny-orb/plugin".

export type { CheckResult, ValidationResult } from '../validation/types.ts';
export type { FunctionResult } from '../fix-loop/types.ts';

export type {
  LanguageProvider,
  FunctionInfo,
  ImportInfo,
  ExportInfo,
  ExtractedFunction,
  FunctionClassification,
  LanguagePromptSections,
  Example,
} from './types.ts';

// ValidationRule and RuleInput are intentionally NOT re-exported.
// They are internal types used by the shared validation chain,
// not part of the public API surface for plugin authors.
