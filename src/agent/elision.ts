// ABOUTME: Re-exports elision detection from shared module for agent-layer consumers.
// ABOUTME: Core logic lives in src/shared/elision.ts to avoid validation→agent dependency.

export { detectElision } from '../shared/elision.ts';
export type { ElisionResult } from '../shared/elision.ts';
