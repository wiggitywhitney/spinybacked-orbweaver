# valid-modified fixture

A copy of `valid/` with known additions for diff testing.

## Changes from valid/ (baseline)

### Added attributes
- `test_app.order.status` (string) — in `registry.test_app.core` group

### Added spans
- `span.test_app.validate_payment` — new span group (note: Weaver diff tracks attribute-level changes, not span group additions)

## Expected diff output (JSON)

When diffed against `valid/` as baseline, `weaver registry diff` produces:
- `changes.registry_attributes`: one entry `{"name": "test_app.order.status", "type": "added"}`
- All other categories (`spans`, `metrics`, `events`, `entities`): empty arrays
