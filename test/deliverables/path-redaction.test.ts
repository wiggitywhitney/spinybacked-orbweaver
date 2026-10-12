// ABOUTME: Unit tests for relativizePaths, the deliverable path-redaction helper.
// ABOUTME: Covers project and home rewriting, whole-prefix boundaries on both sides, and bare roots.

import { describe, it, expect } from 'vitest';
import { relativizePaths } from '../../src/deliverables/path-redaction.ts';

const HOME = '/home/dev';
const PROJECT = '/home/dev/work/app';

describe('relativizePaths', () => {
  it('makes project paths repo-relative and other home paths ~-prefixed', () => {
    const text = `${PROJECT}/lib/a.js and ${HOME}/.cache/x`;
    expect(relativizePaths(text, PROJECT, HOME)).toBe('lib/a.js and ~/.cache/x');
  });

  it('turns a bare project root into . and a bare home directory into ~', () => {
    expect(relativizePaths(`cwd=${PROJECT} home=${HOME}`, PROJECT, HOME)).toBe('cwd=. home=~');
  });

  it('leaves a sibling that shares the root as a prefix', () => {
    expect(relativizePaths(`${PROJECT}-other/b.js`, PROJECT, HOME)).toBe('~/work/app-other/b.js');
  });

  it('does not rewrite a root that appears inside a longer path', () => {
    expect(relativizePaths(`/mnt${PROJECT}/c.js`, PROJECT, HOME)).toBe(`/mnt${PROJECT}/c.js`);
    expect(relativizePaths(`/backup${HOME}/d.txt`, undefined, HOME)).toBe(`/backup${HOME}/d.txt`);
  });

  it('rewrites a root that follows a quote, as in JSON string values', () => {
    expect(relativizePaths(`{"p":"${PROJECT}/e.js"}`, PROJECT, HOME)).toBe('{"p":"e.js"}');
  });

  it('redacts a bare root followed by sentence punctuation, but not a longer name with a dot', () => {
    expect(relativizePaths(`Home: ${HOME}.`, undefined, HOME)).toBe('Home: ~.');
    expect(relativizePaths(`Root is ${PROJECT}. Done`, PROJECT, HOME)).toBe('Root is .. Done');
    expect(relativizePaths(`${HOME}.project/x`, undefined, HOME)).toBe(`${HOME}.project/x`);
  });
});
