// ABOUTME: Public API for AST helpers module.
// ABOUTME: Re-exports all symbols from src/languages/javascript/ast.ts (PRD #371 B1).

export { detectOTelImports } from '../languages/javascript/ast.ts';
export type {
  OTelImportDetectionResult,
  ImportInfo,
  TracerAcquisition,
  ExistingSpanPattern,
} from '../languages/javascript/ast.ts';

export { checkVariableShadowing } from '../languages/javascript/ast.ts';
export type {
  ShadowingResult,
  ShadowingConflict,
} from '../languages/javascript/ast.ts';

export { classifyFunctions } from '../languages/javascript/ast.ts';
export type { FunctionInfo } from '../languages/javascript/ast.ts';
