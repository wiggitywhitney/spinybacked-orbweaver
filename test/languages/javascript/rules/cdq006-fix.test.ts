// ABOUTME: Tests for fixIsRecordingGuards() auto-fix — wraps unguarded expensive setAttribute
// ABOUTME: calls in if (span.isRecording()) blocks, skipping entry-point functions.

import { describe, it, expect } from 'vitest';
import { fixIsRecordingGuards } from '../../../../src/languages/javascript/rules/cdq006.ts';

describe('fixIsRecordingGuards (CDQ-006 auto-fix)', () => {
  describe('basic wrapping', () => {
    it('wraps an unguarded JSON.stringify setAttribute in if (span.isRecording())', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("data", JSON.stringify(bigObj));',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      expect(result).toContain('if (span.isRecording())');
      expect(result).toContain('span.setAttribute("data", JSON.stringify(bigObj))');
    });

    it('preserves original indentation in the wrapped block', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("data", JSON.stringify(bigObj));',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      // The if guard should sit at the same indent as the original statement (4 spaces)
      expect(result).toMatch(/^    if \(span\.isRecording\(\)\) \{$/m);
      // The inner statement should be indented by 2 more spaces
      expect(result).toMatch(/^      span\.setAttribute/m);
      // The closing brace at the original indent
      expect(result).toMatch(/^    \}$/m);
    });

    it('uses the correct receiver variable from the setAttribute call', () => {
      const code = [
        'tracer.startActiveSpan("work", (parentSpan) => {',
        '  try {',
        '    parentSpan.setAttribute("info", computeInfo(ctx));',
        '  } finally { parentSpan.end(); }',
        '});',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      expect(result).toContain('if (parentSpan.isRecording())');
    });
  });

  describe('no-op cases', () => {
    it('leaves already-guarded expensive calls unchanged', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    if (span.isRecording()) {',
        '      span.setAttribute("data", JSON.stringify(bigObj));',
        '    }',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      expect(result).toBe(code);
    });

    it('leaves simple variable setAttribute calls unchanged', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("user.id", userId);',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      expect(result).toBe(code);
    });

    it('leaves trivial conversion calls (.toISOString) unchanged', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("ts", date.toISOString());',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      expect(result).toBe(code);
    });
  });

  describe('entry-point functions — now wrapped (Option A: isInsideEntryPoint removed from auto-fix)', () => {
    it('wraps setAttribute in functions with req/res parameters', () => {
      const code = [
        'app.get("/users", (req, res) => {',
        '  const span = tracer.startSpan("get-users");',
        '  span.setAttribute("ids", users.map(u => u.id).join(","));',
        '  span.end();',
        '  res.json(users);',
        '});',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      expect(result).toContain('if (span.isRecording())');
    });

    it('wraps setAttribute in functions with ctx parameter', () => {
      const code = [
        'async function handler(ctx) {',
        '  span.setAttribute("path", ctx.request.path.split("/").join("-"));',
        '}',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      expect(result).toContain('if (span.isRecording())');
    });

    it('wraps setAttribute in non-framework function misidentified as entry point (loadBunWorkspace pattern)', () => {
      // loadBunWorkspace has a `context` parameter that matches ENTRY_POINT_PARAM_NAMES,
      // but is not a real framework handler — the old auto-fix incorrectly skipped it.
      const code = [
        'async function loadBunWorkspace(context) {',
        '  const data = await fetchData(context);',
        '  span.setAttribute("taze.write.file_path", data.filePaths.join(","));',
        '  span.setAttribute("taze.write.package_type", data.packageTypes.map(t => t.name).join(","));',
        '}',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      expect(result).toContain('if (span.isRecording())');
    });

    it('wraps setAttribute in non-entry-point functions regardless of outer entry-point', () => {
      const code = [
        'app.get("/", (req, res) => {',
        '  tracer.startActiveSpan("inner", (span) => {',
        '    span.setAttribute("data", JSON.stringify(payload));',
        '    span.end();',
        '  });',
        '  res.send("ok");',
        '});',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      expect(result).toContain('if (span.isRecording())');
    });
  });

  describe('multiple violations', () => {
    it('wraps all unguarded expensive setAttribute calls', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("a", computeA(data));',
        '    span.setAttribute("b", JSON.stringify(obj));',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      const guardCount = (result.match(/if \(span\.isRecording\(\)\)/g) ?? []).length;
      expect(guardCount).toBe(2);
    });
  });

  describe('other expensive expression types', () => {
    it('wraps template literal containing a function call', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("info", `count=${items.filter(i => i.active).length}`);',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      expect(result).toContain('if (span.isRecording())');
    });

    it('wraps Object.keys() call', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("keys", Object.keys(payload).join(","));',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const result = fixIsRecordingGuards(code);

      expect(result).toContain('if (span.isRecording())');
    });
  });
});
