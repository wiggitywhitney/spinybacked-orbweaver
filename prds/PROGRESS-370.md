# PRD #370 Progress Log

## Milestone 1: Inventory verification — completed

### File verification results

**`src/validation/types.ts`** — confirmed ✅
- `CheckResult`: `{ ruleId, passed, filePath, lineNumber, message, tier, blocking }` — matches inventory
- `ValidationResult`: `{ passed, tier1Results, tier2Results, blockingFailures, advisoryFindings }` — matches inventory (also has `judgeTokenUsage?: TokenUsage[]`, added in a later phase, not relevant to PRD A)
- `ValidationConfig`: configuration object with `enableWeaver`, `tier2Checks`, and optional fields — matches inventory
- `ValidateFileInput`: `{ originalCode, instrumentedCode, filePath, config }` — matches inventory

**`src/ast/function-classification.ts`** — confirmed ✅
- `FunctionInfo`: `{ name, isExported, isAsync, lineCount, startLine }` — matches inventory exactly; **no `endLine` field** in the interface (calculated in implementation but not stored — the language-agnostic version in types.ts must add it)

**`src/ast/import-detection.ts`** — confirmed ✅
- `ImportInfo`: `{ moduleSpecifier, namedImports, defaultImport, namespaceImport, lineNumber }` — matches inventory (JS-specific fields as documented)
- Also has `TracerAcquisition`, `ExistingSpanPattern`, `OTelImportDetectionResult` — JS-specific types, stay in `src/ast/` per PRD

**`src/fix-loop/function-extraction.ts`** — confirmed with discrepancy notes ✅
- `ExtractedFunction` has `buildContext: (sourceFile: SourceFile) => string` — ts-morph dependency confirmed; language-agnostic version replaces with `contextHeader: string`
- Field `jsDoc: string | null` exists (not `docComment`) — language-agnostic version uses `docComment: string | null`
- Field `referencedConstants: string[]` exists alongside `referencedImports: string[]` — language-agnostic version omits `referencedConstants` (JS/TS specific concept)
- These discrepancies are expected; the new `ExtractedFunction` in `types.ts` will be a clean redesign

**`src/fix-loop/types.ts`** — confirmed ✅
- `FunctionResult`: `{ name, success, instrumentedCode?, error?, spansAdded, librariesNeeded, schemaExtensions, attributesCreated, notes?, tokenUsage }` — language-agnostic; matches inventory

### Directory and scope check

- `src/languages/` contains only `plugin-api.ts` ✅
- `ExportInfo` — not found anywhere in codebase ✅ (must be created new in types.ts)
- `FunctionClassification` — not found anywhere in codebase ✅ (must be created new in types.ts)
- `FunctionInfo` definitions: 1 location only (`src/ast/function-classification.ts`) ✅
- `ImportInfo` definitions: 1 location only (`src/ast/import-detection.ts`) ✅

### Notable: plugin-api.ts has a stub LanguageProvider

`src/languages/plugin-api.ts` currently contains an inline stub `LanguageProvider` interface:
```typescript
export interface LanguageProvider {
  id: string;
  fileExtensions: string[];
}
```
Milestone 3 must remove this stub and replace it with `export type { LanguageProvider } from './types.ts'`. The `id` and `fileExtensions` fields are a subset of the full interface defined in Milestone 2 — no conflict.
