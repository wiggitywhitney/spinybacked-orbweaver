// ABOUTME: Public API for the fix-loop module — retry orchestration for single-file instrumentation.
// ABOUTME: Re-exports instrumentWithRetry, FileResult types, and snapshot utilities.

export { instrumentWithRetry } from './instrument-with-retry.ts';
export type { InstrumentWithRetryDeps } from './instrument-with-retry.ts';
export type { FileResult, ValidationStrategy } from './types.ts';
export { createSnapshot, restoreSnapshot, removeSnapshot } from './snapshot.ts';
