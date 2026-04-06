# Spiny-Orb Roadmap

## Short-term

- Language provider interface — types-only contract before refactoring begins (PRD #370)
- JavaScript language provider extraction — JS becomes the first named `LanguageProvider` (PRD #371)

## Medium-term

- TypeScript language provider — interface canary test; validates abstraction before Python (PRD #372)
- Python language provider — interface stress test; fundamentally different OTel API and tooling (PRD #373)
- JS/TS semconv constants — update prompts to use `@opentelemetry/semantic-conventions` typed constants after research spike (issue #378)

## Long-term

- Go language provider — requires NDS-004/context.Context policy decision; last because hardest (PRD #374)
- Publish to GitHub Actions Marketplace (issue #369)
