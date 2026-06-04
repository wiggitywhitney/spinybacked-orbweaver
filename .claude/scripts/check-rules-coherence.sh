#!/usr/bin/env bash
# ABOUTME: PreToolUse hook — advisory reminder to run rules coherence checks before PR creation.
# ABOUTME: Fires on gh pr create when src/validation/** or src/agent/prompt.ts are in the diff. Advisory only.

set -uo pipefail

INPUT=$(cat)

# Only act on gh pr create commands
COMMAND=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")
if ! echo "$COMMAND" | grep -qE '(^|\s|&&\s*|;\s*)gh\s+pr\s+create\b'; then
  exit 0
fi

# Determine project directory from hook input
PROJECT_DIR=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('cwd','.'))" 2>/dev/null || echo ".")

# Find the diff base (origin/main is required for this project)
DIFF_BASE=""
if git -C "$PROJECT_DIR" rev-parse --verify origin/main &>/dev/null; then
  DIFF_BASE="origin/main"
fi

if [ -z "$DIFF_BASE" ]; then
  exit 0
fi

# Check whether the diff includes validation files or the agent prompt
MATCHED=$(git -C "$PROJECT_DIR" diff --name-only "$DIFF_BASE"...HEAD 2>/dev/null | grep -E '^src/validation/|^src/agent/prompt\.ts' | head -1 || true)

if [ -z "$MATCHED" ]; then
  exit 0
fi

# Emit advisory message — allow the PR creation but surface the coherence checklist
python3 -c "
import json
msg = (
    'Rules coherence check: this PR includes changes to src/validation/ or src/agent/prompt.ts. '
    'Verify before proceeding:\n'
    '1. Read docs/rules-reference.md in full.\n'
    '2. Scan src/validation/ reconcilers for overlapping patterns or contradictory behavior '
    '(two reconcilers handling the same structural case, or one undoing what another fixed).\n'
    '3. Verify every rule ID referenced in src/agent/prompt.ts still corresponds to a registered '
    'rule in src/validation/rule-names.ts.\n'
    '4. If this PR adds, removes, or changes any rule behavior, run /write-docs on '
    'docs/rules-reference.md to update it.'
)
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'allow',
        'additionalContext': msg
    }
}))
"

exit 0
