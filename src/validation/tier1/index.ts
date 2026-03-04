// ABOUTME: Public API for Tier 1 structural validation checks.
// ABOUTME: Re-exports individual checkers: elision, syntax, lint, Weaver static.

export { checkElision } from './elision.ts';
export { checkSyntax } from './syntax.ts';
export { checkLint } from './lint.ts';
export { checkWeaver } from './weaver.ts';
