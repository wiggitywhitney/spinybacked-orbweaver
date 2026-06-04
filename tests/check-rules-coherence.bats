#!/usr/bin/env bats
# ABOUTME: Tests for .claude/scripts/check-rules-coherence.sh

SCRIPT="$BATS_TEST_DIRNAME/../.claude/scripts/check-rules-coherence.sh"

setup() {
  chmod +x "$SCRIPT"
  export SCRIPT
  TEST_REPO=$(mktemp -d)
  # ORIGIN is a subdirectory so rm -rf "$TEST_REPO" cleans it transitively
  ORIGIN="$TEST_REPO/origin.git"

  # Set up a minimal git repo with an initial commit on main
  git -C "$TEST_REPO" init -b main
  git -C "$TEST_REPO" config user.email "test@test.com"
  git -C "$TEST_REPO" config user.name "Test"
  touch "$TEST_REPO/README.md"
  git -C "$TEST_REPO" add README.md
  git -C "$TEST_REPO" commit -m "initial"

  # Create a bare clone as origin so origin/main is resolvable
  git clone --bare "$TEST_REPO" "$ORIGIN" -q
  git -C "$TEST_REPO" remote add origin "$ORIGIN"
  git -C "$TEST_REPO" fetch origin -q
}

teardown() {
  rm -rf "$TEST_REPO"
}

# Build a hook input JSON for a command, passing cwd explicitly
make_input() {
  local command="$1"
  local cwd="$2"
  python3 -c "
import json, sys
print(json.dumps({'tool_name': 'Bash', 'tool_input': {'command': sys.argv[1]}, 'cwd': sys.argv[2]}))
" "$command" "$cwd"
}

# Add a file to the diff against origin/main
add_diff_file() {
  local file_path="$1"
  mkdir -p "$TEST_REPO/$(dirname "$file_path")"
  echo "content" > "$TEST_REPO/$file_path"
  git -C "$TEST_REPO" add "$file_path"
  git -C "$TEST_REPO" commit -m "add $file_path"
}

@test "non-pr-create command exits 0 silently" {
  export HOOK_INPUT
  HOOK_INPUT=$(make_input "git status" "$TEST_REPO")
  run bash -c 'printf "%s" "$HOOK_INPUT" | "$SCRIPT"'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "gh pr create with no matching files exits 0 silently" {
  add_diff_file "src/other/some-file.ts"
  export HOOK_INPUT
  HOOK_INPUT=$(make_input "gh pr create --title test" "$TEST_REPO")
  run bash -c 'printf "%s" "$HOOK_INPUT" | "$SCRIPT"'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "gh pr create on branch with no new commits exits 0 silently" {
  # Branch is at same HEAD as origin/main — empty diff should not trigger advisory
  export HOOK_INPUT
  HOOK_INPUT=$(make_input "gh pr create --title test" "$TEST_REPO")
  run bash -c 'printf "%s" "$HOOK_INPUT" | "$SCRIPT"'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "gh pr create with src/validation/ file emits advisory JSON" {
  add_diff_file "src/validation/rule-names.ts"
  export HOOK_INPUT
  HOOK_INPUT=$(make_input "gh pr create --title test" "$TEST_REPO")
  run bash -c 'printf "%s" "$HOOK_INPUT" | "$SCRIPT"'
  [ "$status" -eq 0 ]
  # Must emit JSON with permissionDecision allow
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['hookSpecificOutput']['permissionDecision']=='allow'"
  # Must mention coherence check steps
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); ctx=d['hookSpecificOutput']['additionalContext']; assert 'docs/rules-reference.md' in ctx"
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); ctx=d['hookSpecificOutput']['additionalContext']; assert 'src/validation/rule-names.ts' in ctx"
}

@test "gh pr create with src/agent/prompt.ts emits advisory JSON" {
  add_diff_file "src/agent/prompt.ts"
  export HOOK_INPUT
  HOOK_INPUT=$(make_input "gh pr create --title test" "$TEST_REPO")
  run bash -c 'printf "%s" "$HOOK_INPUT" | "$SCRIPT"'
  [ "$status" -eq 0 ]
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['hookSpecificOutput']['permissionDecision']=='allow'"
}

@test "gh pr create with src/validation/ nested file emits advisory JSON" {
  add_diff_file "src/validation/tier2/registry-types.ts"
  export HOOK_INPUT
  HOOK_INPUT=$(make_input "gh pr create --title test" "$TEST_REPO")
  run bash -c 'printf "%s" "$HOOK_INPUT" | "$SCRIPT"'
  [ "$status" -eq 0 ]
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['hookSpecificOutput']['permissionDecision']=='allow'"
}

@test "gh pr create chained with && is detected" {
  add_diff_file "src/validation/nds003.ts"
  export HOOK_INPUT
  HOOK_INPUT=$(make_input "git push && gh pr create --title test" "$TEST_REPO")
  run bash -c 'printf "%s" "$HOOK_INPUT" | "$SCRIPT"'
  [ "$status" -eq 0 ]
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['hookSpecificOutput']['permissionDecision']=='allow'"
}

@test "gh pr create chained with semicolon is detected" {
  add_diff_file "src/validation/nds003.ts"
  export HOOK_INPUT
  HOOK_INPUT=$(make_input "git push; gh pr create --title test" "$TEST_REPO")
  run bash -c 'printf "%s" "$HOOK_INPUT" | "$SCRIPT"'
  [ "$status" -eq 0 ]
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['hookSpecificOutput']['permissionDecision']=='allow'"
}

@test "gh pr create with no origin/main exits 0 silently" {
  # Repo without a remote — hook cannot resolve diff base and must exit 0 silently
  NO_REMOTE=$(mktemp -d)
  git -C "$NO_REMOTE" init -b main
  git -C "$NO_REMOTE" config user.email "test@test.com"
  git -C "$NO_REMOTE" config user.name "Test"
  echo "content" > "$NO_REMOTE/README.md"
  git -C "$NO_REMOTE" add README.md
  git -C "$NO_REMOTE" commit -m "initial"
  export HOOK_INPUT
  HOOK_INPUT=$(make_input "gh pr create --title test" "$NO_REMOTE")
  run bash -c 'printf "%s" "$HOOK_INPUT" | "$SCRIPT"'
  rm -rf "$NO_REMOTE"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}
