// ABOUTME: Public API for AST helpers module.
// ABOUTME: Re-exports import detection, variable shadowing, and function classification.

export { detectOTelImports } from './import-detection.ts';
export type {
  OTelImportDetectionResult,
  ImportInfo,
  TracerAcquisition,
  ExistingSpanPattern,
} from './import-detection.ts';

export { checkVariableShadowing } from './variable-shadowing.ts';
export type {
  ShadowingResult,
  ShadowingConflict,
} from './variable-shadowing.ts';

export { classifyFunctions } from './function-classification.ts';
export type { FunctionInfo } from './function-classification.ts';
