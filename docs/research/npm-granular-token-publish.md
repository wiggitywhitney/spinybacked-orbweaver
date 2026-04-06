# Research: npm Granular Access Token Publishing

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-04-06

## Update Log
| Date | Summary |
|------|---------|
| 2026-04-06 | Initial research — token authentication syntax, 404 error meaning, bootstrap procedure, granular vs classic differences |

## Summary

Granular access tokens are the only supported token type for npm publish as of December 2025. They authenticate via `.npmrc` using the `_authToken` field or `NODE_AUTH_TOKEN` environment variable — the same pattern as classic tokens, but the token value starts with `npm_`. A 404 on `PUT registry.npmjs.org/<package>` is almost always an **auth failure** (not a package-not-found), because the registry returns 404 instead of 401 to avoid leaking package existence. For a brand-new package, the first publish must be done with a token because OIDC trusted publishing can only be configured after the package exists in the registry.

---

## Findings

### Q1: How does `npm publish` authenticate with a granular access token?

**The canonical .npmrc format** (confirmed by npm docs CI/CD guide and httptoolkit.com):

```text
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

This goes in a `.npmrc` file (project root or `~/.npmrc`). The `${NPM_TOKEN}` is a literal placeholder — npm reads the env var at runtime.

**The environment variable** the npm CLI natively reads for `.npmrc` expansion is `NPM_TOKEN`. However, `NODE_AUTH_TOKEN` is what `actions/setup-node` injects into `.npmrc` when you use `registry-url:` in the action config.

Specifically from the httptoolkit.com article (verified fetch):
> "the registry-url here is required" — `actions/setup-node` only writes the `.npmrc` entry when `registry-url` is specified, and then maps `NODE_AUTH_TOKEN` to `_authToken`.

**Does `NPM_TOKEN=xxx npm publish` work directly (without .npmrc)?**

No. `NPM_TOKEN` is not a first-class npm CLI env var the way `NODE_AUTH_TOKEN` is in GitHub Actions. The env var alone does not authenticate — it must be referenced inside `.npmrc` as `${NPM_TOKEN}`. The correct approaches are:

- **Option A — .npmrc with env var expansion (recommended for CI):**
  ```text
  //registry.npmjs.org/:_authToken=${NPM_TOKEN}
  ```
  Then set `NPM_TOKEN` in the environment.

- **Option B — GitHub Actions with actions/setup-node:**
  ```yaml
  - uses: actions/setup-node@v4
    with:
      node-version: '24.x'
      registry-url: 'https://registry.npmjs.org'
  - run: npm publish
    env:
      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  ```
  `actions/setup-node` automatically writes `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` to `.npmrc` when `registry-url` is specified.

**Confidence: 🟢 high** — confirmed by httptoolkit.com (verified fetch), npm docs CI/CD guide search results, multiple independent corroborating sources.

---

### Q2: What does a 404 Not Found on `PUT registry.npmjs.org/<package>` mean?

**It is almost always an authentication failure, not a package-not-found error.**

The npm registry intentionally returns 404 (rather than 401 Unauthorized) on failed publish attempts. This design choice hides whether a package exists from unauthenticated requesters.

From the npm/cli issue #5089 thread (verified fetch):
> "The E404 on PUT is a known npm behavior for auth failures."

From the npm/cli issue #1637 thread (verified fetch):
> "Authentication Problems: Users lacking proper credentials or valid tokens receive 404 instead of clearer 401 errors, masking the real problem."

**Specific known causes of the 404:**

1. **Token not in .npmrc / wrong auth format** — `NPM_TOKEN=xxx npm publish` without `.npmrc` referencing it.
2. **OIDC handshake failure** — Using Node.js 22 (which ships npm v10) for trusted publishing. npm CLI 11.5.1+ required. From the Kenrick Tandrian Medium article (verified fetch): "Because Node 22 uses npm v10, the CLI doesn't support the latest OIDC handshake protocols required by the registry... the registry treats you as an anonymous user... resulting in the misleading 404."
3. **Conflicting auth entries** — Having both `_auth` (base64 username:password) and `_authToken` in `.npmrc` simultaneously. The `_auth` wins and it's wrong.
4. **`NODE_AUTH_TOKEN` set while using OIDC trusted publishing** — From the dev.to troubleshooting article (verified fetch): "Do NOT set NODE_AUTH_TOKEN! An empty string is still a value — npm will attempt to use it rather than falling back to OIDC."
5. **Token lacks write permission or `bypass 2FA` is not enabled** — As of November 2025, new write-enabled granular tokens enforce 2FA by default. For CI/CD use, "Bypass 2FA" must be explicitly checked when creating the token.
6. **Package name taken** — Rare but possible: if the package name belongs to another account.

**Confidence: 🟢 high** — multiple independent sources (npm issue threads, Medium article, dev.to article) all agree: 404 on PUT = auth failure in the vast majority of cases.

---

### Q3: Bootstrap procedure for first publish of a new package

**OIDC trusted publishing requires the package to exist before it can be configured.** You cannot configure a trusted publisher for a package that has never been published.

From the dev.to troubleshooting article (verified fetch):
> "No. The first version must be published manually or using a traditional token. Trusted Publisher can only be configured afterward."

From search result synthesis of multiple sources:
> "With npmjs.com, you must first create a dummy version before generating a granular access token for the package."

**Step-by-step bootstrap procedure:**

1. **Create a granular access token** at `npmjs.com/settings/~/tokens` → "Generate New Token" → "Granular Access Token":
   - Set an expiration (max 90 days).
   - Set Permissions to "Read and write".
   - For Package Scopes: select "All packages" or leave unscoped — the package doesn't exist yet, so you can't select it by name. Alternatively scope to all packages under your account.
   - Enable **"Bypass 2FA"** if your account has 2FA enabled (required for non-interactive publish).

2. **Configure .npmrc** (project root, never committed):
   ```text
   //registry.npmjs.org/:_authToken=${NPM_TOKEN}
   ```

3. **Run the first publish**:
   ```bash
   NPM_TOKEN=npm_xxxx npm publish --access public
   ```
   The `--access public` flag is required for the very first publish of an unscoped package (npm defaults to restricted for first-time publishing).

4. **After the first publish succeeds**, go to `npmjs.com/package/<your-package>/access` and configure the OIDC trusted publisher (GitHub repo + workflow ref).

5. **Update your GitHub Actions workflow** to use OIDC (no token needed after this):
   ```yaml
   permissions:
     id-token: write
   steps:
     - uses: actions/setup-node@v4
       with:
         node-version: '24.x'   # Must be 24.x — ships npm v11.5.1+
         registry-url: 'https://registry.npmjs.org'
     - run: npm publish --provenance --access public
   ```
   Do NOT set `NODE_AUTH_TOKEN` when using OIDC.

**Confidence: 🟢 high** for the requirement that the package must exist first. 🟡 medium for the exact token scoping UI steps (UI may change; underlying requirement is confirmed by multiple sources).

---

### Q4: Differences between classic tokens and granular access tokens for `npm publish`

| Feature | Classic tokens (revoked Dec 9, 2025) | Granular access tokens |
|---|---|---|
| Current status | Permanently revoked — cannot be used | Only supported type |
| Token prefix | `npm_` (same) | `npm_` (same) |
| .npmrc syntax | `//registry.npmjs.org/:_authToken=npm_xxx` | Same — identical syntax |
| `NPM_TOKEN` env var | Works | Works — same `.npmrc` expansion |
| `NODE_AUTH_TOKEN` (setup-node) | Works | Works — same pattern |
| 2FA enforcement | Not enforced | Enforced by default for write tokens; Bypass 2FA must be explicitly enabled |
| Token expiration | Could be set to never expire | Maximum 90 days for write tokens |
| Package scope | All packages on account | Up to 50 specific packages/scopes |
| CI/CD suitability | Was the standard | Requires "Bypass 2FA" checked |
| Can use `NPM_TOKEN=xxx npm publish` directly | No (same limitation) | No — must be in `.npmrc` or via `NODE_AUTH_TOKEN`+setup-node |

**Key practical difference:** Granular tokens require you to explicitly check "Bypass 2FA" in the token creation UI for non-interactive CI/CD publish. Without it, the publish will prompt interactively for 2FA and hang/fail.

**Confidence: 🟢 high** — confirmed by GitHub changelog Nov 2025, httptoolkit.com article, multiple corroborating sources.

---

## Surprises and Gotchas

- **`NPM_TOKEN=xxx npm publish` does not work** — the env var alone is not consumed by the npm CLI directly. It must be referenced in `.npmrc` as `${NPM_TOKEN}`.
- **404 = auth failure** — not a "package doesn't exist" error. The registry deliberately uses 404 to hide package presence from anonymous users.
- **Bypass 2FA must be explicitly enabled** on the granular token — it is off by default as of November 2025. Forgetting this causes interactive 2FA prompts that hang CI.
- **Node.js version matters for OIDC** — Node 22 ships npm v10 which doesn't support the OIDC handshake. You need Node 24 (ships npm v11.5.1+). The failure manifests as a confusing 404.
- **Do NOT set NODE_AUTH_TOKEN when using OIDC** — even an empty string causes npm to prefer token auth over OIDC, resulting in a 404.
- **First publish of a new package cannot use OIDC** — the trusted publisher config requires the package to already exist in the registry.
- **`--access public` required for first publish** of unscoped packages — npm defaults to `--access restricted` for the first publish of any package by a new publisher, which fails unless you pay for a private registry tier.
- **Token scoping limitation for new packages** — when creating a granular token for a package that doesn't exist yet, you can't select it by name in the UI. You must scope to "All packages" for the bootstrap publish, then optionally create a more restricted token afterward.

---

## Sources

- [npm Classic Tokens Revoked — GitHub Changelog, Dec 2025](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/) — confirms complete revocation Dec 9 2025
- [npm Security Update: Classic Token Creation Disabled — GitHub Changelog, Nov 2025](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/) — 2FA enforcement on write tokens, 90-day cap, Bypass 2FA option
- [npm Strengthening Security — GitHub Changelog, Sep 2025](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/) — initial announcement of token migration
- [Automatic npm Publishing with GitHub Actions & Granular Tokens — httptoolkit.com](https://httptoolkit.com/blog/automatic-npm-publish-gha/) — verified: `NODE_AUTH_TOKEN` + `registry-url` is required; exact GitHub Actions syntax
- [npm Trusted Publishing 404 Error and Node.js 24 Fix — Medium/Kenrick Tandrian](https://medium.com/@kenricktan11/npm-trusted-publishers-the-weird-404-error-and-the-node-js-24-fix-a9f1d717a5dd) — verified: 404 = OIDC auth failure; Node 24 required
- [npm Publish with Automation Token Returns 404 — npm/cli Issue #5089](https://github.com/npm/cli/issues/5089) — verified: E404 on PUT is known behavior for auth failures; conflicting `_auth` + `_authToken`
- [npm Publish 404 — npm/cli Issue #1637](https://github.com/npm/cli/issues/1637) — verified: 404 masks authentication problems
- [From Deprecated Classic Tokens to OIDC — dev.to/zhangjintao](https://dev.to/zhangjintao/from-deprecated-npm-classic-tokens-to-oidc-trusted-publishing-a-cicd-troubleshooting-journey-4h8b) — verified: first publish must use token; do not set NODE_AUTH_TOKEN with OIDC
- [Things You Need to Do for npm Trusted Publishing — philna.sh, Jan 2026](https://philna.sh/blog/2026/01/28/trusted-publishing-npm/) — per-package setup; provenance flag
- [Using Granular Access Tokens via npm CLI — GitHub Community Discussion #49763](https://github.com/orgs/community/discussions/49763) — granular tokens have CI/CD limitations vs classic tokens
