// ABOUTME: Public API for Tier 1 structural validation checks.
// ABOUTME: Re-exports cross-language checkers: elision and Weaver static. Syntax/lint are provider-specific.

export { checkElision } from './elision.ts';
export { checkWeaver } from './weaver.ts';
