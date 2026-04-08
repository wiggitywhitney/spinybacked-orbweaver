// ABOUTME: Entry point for the language provider system.
// ABOUTME: Exports the registry API and re-exports the public LanguageProvider types.

export {
  registerProvider,
  getProvider,
  getProviderByLanguage,
  getAllProviders,
} from './registry.ts';

export type {
  LanguageProvider,
  FunctionInfo,
  ImportInfo,
  ExportInfo,
  ExtractedFunction,
  FunctionClassification,
  LanguagePromptSections,
  Example,
  RuleInput,
  ValidationRule,
} from './types.ts';

export { JavaScriptProvider } from './javascript/index.ts';
