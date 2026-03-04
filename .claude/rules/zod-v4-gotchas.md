# Zod v4 Gotchas

Verified against official docs (zod.dev/v4/changelog) on 2026-03-04.

## Import Path

- `import { z } from "zod"` — as of zod 4.0.0, root export IS Zod v4.
- `import { z } from "zod/v4"` — also works, forever. Either is fine.
- For this project, use `import { z } from "zod"` since we depend on zod ^4.x directly.

## Breaking Changes from v3

- **No `.strict()` method.** Use `z.strictObject({...})` instead of `z.object({...}).strict()`.
- **No `.passthrough()` method.** Use `z.looseObject({...})` instead.
- **No `.merge()` on objects.** Use `.extend()` or spread `.shape`: `z.object({ ...A.shape, ...B.shape })`.
- **No `.deepPartial()`.** Removed entirely.
- **`z.record()` requires two args** — `z.record(z.string(), z.number())`, not `z.record(z.number())`.
- **`.default()` matches output type**, not input type. For transform chains, use `.prefault()` for input-type defaults.
- **Error customization**: `message` param deprecated → use `error` param. `invalid_type_error`/`required_error` dropped.
- **`z.nativeEnum()` deprecated** → use `z.enum()` with native enums.

## Defaults Behavior (Important)

Defaults inside optional object properties now apply:
```typescript
z.object({ a: z.string().default("tuna").optional() }).parse({})
// v3: {} — v4: { a: "tuna" }
```

This is actually what we want for config validation (fill in defaults for omitted fields).

## Anthropic SDK Compatibility

- `@anthropic-ai/sdk` v0.78.0 declares `peerDependencies: { "zod": "^3.25.0 || ^4.0.0" }` (optional).
- `zodOutputFormat` import: `import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"`.
- Works with both Zod 3.25+ and Zod 4.x schemas.

## z.infer

- `z.infer<typeof schema>` works the same as v3. No syntax change.
- `z.unknown()` and `z.any()` fields are no longer marked optional in inferred types (were optional in v3).
