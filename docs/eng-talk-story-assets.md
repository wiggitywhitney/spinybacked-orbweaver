# Engineering Talk Story Assets

Concrete examples pulled from eval runs, kept here so they're ready to drop into slides or speaker notes for the Datadog engineering team talk on spinybacked-orbweaver. Each entry names the run it came from and includes verbatim tool output — not paraphrased.

---

## The validator catches a near-synonym attribute name

**From**: commit-story-v2 run 22

The agent instrumented `findUnsummarizedWeeks` and declared `commit_story.journal.base_path` as a new schema extension attribute. The already-registered schema had `commit_story.journal.file_path` — a different name for the same underlying concept. spiny-orb's SCH-002 validator caught the near-synonym and blocked the submission before it could reach the schema registry.

**Why it's a good story beat**: the agent made a plausible but wrong choice — `base_path` reads naturally next to `findUnsummarizedWeeks` — and a deterministic rule caught it automatically, with no human review needed. It demonstrates concretely why the schema registry and duplicate-detection rules exist: LLMs invent register-shaped names that feel right locally but fragment the schema globally.

**Verbatim validator output**:

> "findUnsummarizedWeeks skipped — SCH-002: the agent declared commit_story.journal.base_path as a new extension, but spiny-orb's validator identified it as a semantic duplicate of the existing commit_story.journal.file_path. The agent invented a near-synonym key instead of reusing the registered one."

**Source**: [issue #924](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/924)
