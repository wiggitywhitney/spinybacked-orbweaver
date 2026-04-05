// ABOUTME: Public plugin API for spiny-orb language providers.
// ABOUTME: External language provider packages import types from "spiny-orb/plugin".

export type { CheckResult, ValidationResult } from '../validation/types.ts';

/**
 * Interface that language provider packages must implement.
 * Expanded in the multi-language architecture PRD.
 * External providers: import this type from "spiny-orb/plugin".
 */
export interface LanguageProvider {
  /** Language identifier, e.g. 'javascript', 'typescript', 'python' */
  id: string;
  /** File extensions this provider handles, e.g. ['.js', '.jsx'] */
  fileExtensions: string[];
}
