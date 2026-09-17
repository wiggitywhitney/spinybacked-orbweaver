# Research: Release Cadence for Solo-Maintained Open Source npm Packages

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-09-17

## Update Log
| Date | Summary |
|------|---------|
| 2026-09-17 | Initial research |

## Findings

### Summary
There is no fixed "normal" cadence — it scales with package tier and download count, and matters far less than two other things: security-patch speed and maintainer responsiveness. For a solo-maintained package like spiny-orb that's just starting to draw outside interest, the actionable target isn't a calendar cadence — it's ship-when-changes-accumulate, patch security issues within days, and keep the issue tracker visibly alive.

### Surprises & Gotchas
- **A long gap between releases is not itself a red flag.** Multiple sources converge on this: a package unchanged for 24 months because it's stable and correct reads as *healthier* than one updated last month to fix a regression from the previous release. 🟢
- **SemVer itself is a documented source of maintainer anxiety**, not just a numbering scheme — one critique argues it pressures maintainers into feeling they can't cut a 1.0 until the design is "perfect," which is part of why so many production-ready packages sit at 0.x forever ("0ver"). 🟡
- **Cadence should be decoupled by change type**, not uniform: security patches ship immediately regardless of schedule; routine minor/feature work batches on a predictable rhythm; majors are rare and deliberate (every 12–24 months even for actively maintained projects like Vite/Next.js/Prisma). 🟢
- **"No changes this cycle" means no release** — thoughtbot's guidance explicitly warns against forcing an empty release just to hit a self-imposed cadence. 🟢
- **Solo-maintainer risk is framed as "bus factor," not laziness** — evaluators explicitly note this isn't automatically bad ("many excellent packages are run by one maintainer"), but it does concentrate risk, and a useful health signal reviewers look for is a *recognizable* pattern (steady trickle vs. a 2-year gap followed by a sudden burst, which can even read as a takeover signal). 🟡

### Findings

**Release-frequency benchmarks by download tier** (PkgPulse, 2026 guide — 🟡 medium confidence, single guide source, not a primary/academic dataset, but internally consistent and corroborated in a second search):

| Tier | Avg. days between releases | Median critical-CVE patch time |
|---|---|---|
| Top 100 by downloads | 18 | 6 days |
| 101–1,000 | 52 | 31 days |
| 1,001–10,000 | 130 | 87 days |
| 10,000+ (long tail) | 400+ | often never (abandoned) |

**Source says:** "The top 100 npm packages average a new release every 18 days. The bottom 1000 haven't released in 8+ months." ([PkgPulse](https://www.pkgpulse.com/guides/how-long-npm-packages-get-updates))
**Interpretation:** spiny-orb, as a young package with a small but growing audience, would realistically sit somewhere in the 1,001–10,000+ tier by download volume for a long time — the relevant comparison isn't "top 100 cadence," it's "does it look actively maintained at all."

**What signals "actively maintained" independent of exact interval:**
**Source says:** "0-3 months: Active. 3-12 months: Healthy. 12-24 months: Investigate. 2+ years: Likely abandoned (unless intentionally stable)." ([PkgPulse](https://www.pkgpulse.com/guides/how-long-npm-packages-get-updates))
**Interpretation:** treat 3–12 months between substantive releases as the safe healthy band for a solo project, not a violation.

**Decoupling change types onto different clocks:**
**Source says:** "regardless of a chosen schedule ... security issues or major blocking bugs should be released as soon as possible" while "if nothing has changed during a scheduled release window, there is no need to release." ([thoughtbot — Maintaining Open Source Projects: Versioning and Releasing](https://thoughtbot.com/blog/maintaining-open-source-projects-versioning))
**Interpretation:** the practical guideline synthesized across sources is: critical/high CVEs within 24h, moderate advisories within 1 week, everything else batched on a predictable (not necessarily frequent) rhythm. 🟢

**Frequent small releases as a burnout mitigation, not just a user-facing courtesy:**
**Source says:** "a project that releases useful improvements regularly tends to feel more trustworthy than one that disappears for long periods and returns with an oversized release." ([DEV — Why Small, Regular Releases Matter in Open Source](https://dev.to/mzivkovicdev/why-small-regular-releases-matter-in-open-source-4nkd))
**Interpretation:** this argues for cadence-by-accumulated-change (release when a few useful things are ready) rather than waiting for a "big enough" release — which matches the project's existing `PROGRESS.md`-driven classification (see Caveats below).

**Major version bump discipline:**
**Source says:** major releases land "once every 12-24 months for stable packages," with examples like React (~2-3 years) and Vite/Next.js/Fastify/Prisma (~annually to every 18-24 months). ([PkgPulse](https://www.pkgpulse.com/guides/how-long-npm-packages-get-updates))
**Interpretation:** don't rush major bumps; collect breaking changes and ship them together rather than incrementing the major version reactively.

**Structural burnout-prevention practices beyond cadence** (🟡 medium confidence, aggregated blog synthesis, not independently re-verified per item):
- A scoped CONTRIBUTING.md that deflects out-of-scope feature requests before they become open discussions.
- Treating the issue tracker as a communication channel, not a backlog — respond even without a fix, close scattered noise with a clear policy.
- Setting explicit response-time expectations rather than being reachable off-hours indefinitely.
- Finding even one trusted collaborator with merge access to remove single-point-of-failure risk.

### Conflicting Findings
- **Source A (Hynek Schlawack / "SemVer Will Not Save You" school) implies:** SemVer adds pressure and is frequently misapplied, contributing to 0ver stagnation and maintainer anxiety about "breaking changes."
- **Source B (thoughtbot / Okta dev blog) says:** SemVer is a useful shared vocabulary between maintainers and consumers, and the failures attributed to it are actually failures to apply it correctly, not a flaw in the standard itself.
- **Interpretation:** both are describing the same failure mode (maintainers freezing up over version numbers) but disagree on whether the standard or the maintainer's relationship to it is the root cause. For a practical decision, this doesn't change the recommendation — use SemVer, but treat major-version discipline as a batching/communication practice rather than a perfection gate.

### Recommendation
For spiny-orb specifically, given the project already has automated `PROGRESS.md`-driven version classification at release time (major/minor/patch based on `[Unreleased]` entry severity, per `CLAUDE.md`'s npm Release Workflow section) and an `npm-release-test.yml` post-publish smoke test:

1. **Don't adopt a calendar-based cadence commitment** (e.g., "release every 2 weeks"). Release when `[Unreleased]` in `PROGRESS.md` has accumulated a few genuinely useful, tested changes — this is already how the project's release classification works, so no new process is needed, just a lower bar for "is it time to cut one."
2. **Treat security/critical-bug fixes as an out-of-band fast path** — patch and publish within days, independent of whatever else is pending, rather than bundling with the next feature batch.
3. **3–12 months between releases is a healthy signal, not a gap to apologize for**, as long as issues get acknowledged. A steady trickle (even small patch releases) reads as more trustworthy to new outside interest than a long silence followed by a big drop.
4. **Don't rush toward a major version** just because outside interest is growing. Batch breaking changes; the project's current `>= 1.x` line with a strict bump-classification rule already matches best practice here.
5. **Add lightweight responsiveness signals** now that outside interest exists: acknowledge new issues within a few days even without a fix, and consider a short CONTRIBUTING.md section on scope to pre-empt feature-request sprawl as a solo maintainer.

### Caveats
- Figures from PkgPulse are from a single guide-style source (not a peer-reviewed dataset); they're presented with specific numbers but should be treated as directional benchmarks, not precise targets.
- All sources are general npm/OSS advice, not specific to AI-agent tooling or CLI packages like spiny-orb — no source addressed release cadence for a category as narrow as "AI instrumentation agent," so the recommendation above is a general-practice synthesis applied to this project's existing workflow, not a domain-specific finding.
- None of this addresses whether spiny-orb's current release-time version-classification process (in `CLAUDE.md`) needs to change — it doesn't; this research supports keeping it and adjusting only the *decision of when to trigger a release*, not how versions are classified.

## Sources
- [PkgPulse — How Long Until npm Packages Get Updates? (2026)](https://www.pkgpulse.com/guides/how-long-npm-packages-get-updates) — tiered release-cadence and CVE-patch-time benchmarks, healthy-vs-abandoned gap thresholds
- [thoughtbot — Maintaining Open Source Projects: Versioning and Releasing](https://thoughtbot.com/blog/maintaining-open-source-projects-versioning) — SemVer rationale, time-based release scheduling, security-exception guidance, "don't force empty releases"
- [DEV Community — Why Small, Regular Releases Matter in Open Source](https://dev.to/mzivkovicdev/why-small-regular-releases-matter-in-open-source-4nkd) — small/frequent releases as a trust and burnout-mitigation strategy
- [DEV Community — How to maintain an open source project without burning out](https://dev.to/whatshipped/how-to-maintain-an-open-source-project-without-burning-out-4jl2) — structural burnout-prevention practices (CONTRIBUTING.md scope, issue-tracker policy, collaborators)
- [Hynek Schlawack — Semantic Versioning Will Not Save You](https://hynek.me/articles/semver-will-not-save-you/) — critique of SemVer as a source of maintainer pressure and 0ver stagnation
- [GitHub Blog — Tame Dependabot: Group your updates, slow the cadence, keep security fast](https://github.blog/security/supply-chain-security/tame-dependabot-group-your-updates-slow-the-cadence-keep-security-fast/) — decoupling security urgency from routine batching
