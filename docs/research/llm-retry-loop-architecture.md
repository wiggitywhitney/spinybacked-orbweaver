# Research: LLM Retry Loop Architecture for Code Transformation

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-02

## Update Log
| Date | Summary |
|------|---------|
| 2026-06-02 | Initial research — issue #903 spike |

## Findings

### Summary

The 3-attempt hybrid structure (generate → multi-turn fix → fresh regen) remains sound — research confirms 2–3 repair rounds capture 76–95% of achievable gains. The problem is **attempt 2's prompt framing**: "make minimal, targeted changes" combined with accumulated conversation context causes the agent to over-constrain its solution space, prioritizing escape from blocking failures over comprehensive attribute coverage. The fix is to redesign attempt 2's prompt rather than the architecture.

---

### Surprises & Gotchas

**Multi-turn performance drop is larger than expected and code tasks are not immune.** Microsoft Research (2025) measured an average **39% performance drop** across all LLMs in multi-turn vs. single-turn settings, including on code tasks. The dominant cause is not forgetting — it's entrapment: "when LLMs take a wrong turn in a conversation, they get lost and do not recover."

**Source says:** "analysis decomposes this degradation into a minor loss in aptitude and a significant increase in unreliability" ([LLMs Get Lost In Multi-Turn Conversation](https://arxiv.org/abs/2505.06120))
**Interpretation:** The unreliability spike — not the aptitude drop — is the danger. An agent that takes a bad first move gets increasingly unreliable across subsequent turns, not just less capable.

**"Make minimal targeted changes" framing is especially harmful for attribute coverage.** The research on fact selection confirms that "effectiveness of program repair prompts is non-monotonic over the number of used facts — using too many facts leads to subpar outcomes." The corollary: constraining the solution space ("minimal changes") limits the agent's ability to discover and add the right attributes when the initial attempt was wrong.

**Self-repair is bottlenecked by feedback quality, not attempt count.** Replacing a weak feedback signal with a stronger, more focused one produces "substantially larger performance gains" than adding more repair iterations.

**Source says:** "Artificially boosting the quality of the feedback significantly improves the efficacy of self-repair... in every case, the boosted configuration beats both the corresponding i.i.d. baseline and the corresponding self-repair configuration." ([Is Self-Repair a Silver Bullet for Code Generation?](https://arxiv.org/abs/2306.09896), ICLR 2024)

**Reasoning tokens don't help with multi-turn drift.** "Additional test-time compute (reasoning tokens) does not help models navigate multi-turn underspecification — reasoning models like o3 and DeepSeek-R1 deteriorate in similar ways." More thinking on a bad trajectory doesn't recover quality; fresh context does.

---

### Findings

**1. Optimal repair rounds: 2–3, with sharply diminishing returns** 🟢 high confidence

"Two repair rounds capture the majority (76–95%) of achievable gains. Marginal returns drop sharply after R1→R2." For capable models, "R4 yields no additional improvement over R3." No modern model showed net degradation from repair (contrast with 2022–2023 models where weaker models could regress). ([arxiv 2604.10508](https://arxiv.org/html/2604.10508), 2026)

The 3-attempt cap is justified. The question is what happens *within* each attempt.

**2. Multi-turn repair shows average 39% performance drop vs. single-turn** 🟢 high confidence

"All top open- and closed-weight LLMs exhibit significantly lower performance in multi-turn conversations than single-turn." Includes a **112% increase in unreliability**. Claude 3.7 Sonnet showed relatively better preservation on code tasks specifically, but was not immune. ([arxiv 2505.06120](https://arxiv.org/abs/2505.06120), 2025)

**3. Fresh context with targeted error injection outperforms "minimal changes" framing** 🟡 medium confidence (research-aligned, eval-corroborated)

"Context-aware prompt tuning dramatically improves repair — from 15% to 63% repair rate by injecting a sequence of domain knowledge about the failure." The "fact selection problem" research shows that fewer, better-selected facts outperform accumulated context. The "minimal changes" framing is a fact-selection failure: it systematically under-includes the agent's exploration space for attributes while over-including failed attempts as anchors.

**4. Eval data: 3-attempt files show systematic quality regression** 🟡 medium confidence (eval-derived, single target)

Across commit-story-v2 runs 13–20:
- Run-15 (zero 3-attempt files) was the best quality run overall
- 3-attempt files show two failure modes: (a) zero new schema attributes registered despite successful commits, or (b) attribute dropout — attributes present in the prior run's output are dropped to escape blocking failures
- Most direct evidence: `src/index.js` run-19→20 went 1 attempt (with `commit_story.cli.subcommand`) → 3 attempts (subcommand attribute dropped). The increase in attempts directly caused quality regression
- The pattern is directional but not absolute: `journal-manager.js` (3 attempts, run-20) did register `entries_count` via function-level fallback after file-level attempts failed NDS-003

**5. PRD #901's retry carve-out is complementary, not sufficient** 🟢 high confidence

PRD #901 added a carve-out for cases where specific fixable failures should be handled before retry. That handles the "easy fix" case. The issue is the general retry framing for cases that genuinely need attempt 2 — the "make minimal, targeted changes" constraint persists, and the research and eval data show it causes quality loss.

---

### Conflicting Findings

- **Olausson et al. (ICLR 2024)** finds self-repair gains are "often modest... and sometimes not present at all" — but uses 2022–2023 models.
- **arxiv 2604.10508 (2026)** finds no net regression for modern models and captures 76–95% of gains in 2 rounds.
- **Resolution:** The 2025 finding supersedes on whether repair degrades quality; the ICLR 2024 finding remains accurate on feedback quality being the bottleneck. Both are compatible: modern models don't regress from repair, but quality still scales with feedback quality rather than attempt count.

---

### Recommendation

**Modify attempt 2 prompt framing.** Keep the 3-attempt hybrid — it is architecturally sound. Change what attempt 2 says.

- **Current:** accumulated conversation context + "make minimal, targeted changes"
- **Proposed:** fresh context + "The previous attempt failed for this specific reason: [error]. Generate full instrumentation with complete attribute coverage, avoiding specifically: [failure mechanism]."

This is distinct from switching to full fresh-regen with failure hint at attempt 2 (option 2 in issue #903). It keeps the repair-round structure but removes the conservative constraint that causes attribute dropout, replacing it with a focused failure signal.

Rationale: the "minimal changes" framing is the proximate cause of attribute dropout in 3-attempt files. Removing it while keeping a targeted failure signal preserves the repair benefit without the quality cost. Research confirms focused failure context (not accumulated context) drives better repairs.

**PRD #901 is separate** — it handles the carve-out for cases that can be fixed before reaching attempt 2. The proposed change handles what happens when cases do reach attempt 2.

No follow-up PRD is needed — this is a targeted prompt change in `src/coordinator/coordinate.ts` (wherever attempt 2 prompt framing lives).

---

### Caveats

- The eval correlation is based on 8 runs of a single target (commit-story-v2). A second eval target would strengthen the finding.
- Claude 4.x-specific behavior in multi-turn code repair is not directly studied in the literature — most papers use CodeLlama or GPT-3.5/4.
- The "fresh context vs. accumulated context" comparison for attempt 2 is inferred from research + eval pattern; no controlled experiment exists within spiny-orb.

---

## Sources

- [LLMs Get Lost In Multi-Turn Conversation (Microsoft Research / arxiv 2505.06120)](https://arxiv.org/abs/2505.06120) — primary source on multi-turn performance degradation magnitude and mechanism
- [Is Self-Repair a Silver Bullet for Code Generation? (Olausson et al., ICLR 2024)](https://arxiv.org/abs/2306.09896) — self-repair limits and feedback quality as bottleneck
- [How Many Tries Does It Take? (arxiv 2604.10508, 2026)](https://arxiv.org/html/2604.10508) — optimal repair round count, modern model behavior
- [The Art of Repair: Optimizing Iterative Program Repair (arxiv 2505.02931, 2025)](https://arxiv.org/abs/2505.02931) — balanced APR strategies, 10-patch cap finding
- [Context-aware prompting for LLM-based program repair (Springer, 2025)](https://link.springer.com/article/10.1007/s10515-025-00512-w) — fresh context vs. accumulated context framing
- [The Fact Selection Problem in LLM-Based Program Repair (arxiv 2404.05520)](https://arxiv.org/pdf/2404.05520) — non-monotonic relationship between context facts and repair quality
- [An update on recent Claude Code quality reports (Anthropic, April 2026)](https://www.anthropic.com/engineering/april-23-postmortem) — Anthropic-documented session degradation, fresh context as mitigation
