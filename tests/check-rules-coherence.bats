#!/usr/bin/env bats
# ABOUTME: Tests for .claude/scripts/check-rules-coherence.sh

SCRIPT="$BATS_TEST_DIRNAME/../.claude/scripts/check-rules-coherence.sh"

setup() {
  chmod +x "$SCRIPT"
  TMPDIR=$(mktemp -d)
  ORIGIN="$TMPDIR.origin"

  # Set up a minimal git repo with an initial commit on main
  git -C "$TMPDIR" init -b main
  git -C "$TMPDIR" config user.email "test@test.com"
  git -C "$TMPDIR" config user.name "Test"
  touch "$TMPDIR/README.md"
  git -C "$TMPDIR" add README.md
  git -C "$TMPDIR" commit -m "initial"

  # Create a bare clone as origin so origin/main is resolvable
  git clone --bare "$TMPDIR" "$ORIGIN" -q
  git -C "$TMPDIR" remote add origin "$ORIGIN"
  git -C "$TMPDIR" fetch origin -q
}

teardown() {
  rm -rf "$TMPDIR" "$ORIGIN"
}

# Build a hook input JSON for a gh pr create command
make_input() {
  local command="$1"
  python3 -c "
import json, sys
print(json.dumps({'tool_name': 'Bash', 'tool_input': {'command': sys.argv[1]}, 'cwd': sys.argv[2]}))
" "$command" "$TMPDIR"
}

# Add a file to the diff against main (creates a new commit on current HEAD)
add_diff_file() {
  local file_path="$1"
  mkdir -p "$TMPDIR/$(dirname "$file_path")"
  echo "content" > "$TMPDIR/$file_path"
  git -C "$TMPDIR" add "$file_path"
  git -C "$TMPDIR" commit -m "add $file_path"
}

@test "non-pr-create command exits 0 silently" {
  input=$(make_input "git status" "$TMPDIR")
  run bash -c "echo '$input' | '$SCRIPT'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "gh pr create with no matching files exits 0 silently" {
  add_diff_file "src/other/some-file.ts"
  input=$(make_input "gh pr create --title test" "$TMPDIR")
  run bash -c "echo '$input' | '$SCRIPT'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "gh pr create with src/validation/ file emits advisory JSON" {
  add_diff_file "src/validation/rule-names.ts"
  input=$(make_input "gh pr create --title test" "$TMPDIR")
  run bash -c "echo '$input' | '$SCRIPT'"
  [ "$status" -eq 0 ]
  # Must emit JSON with permissionDecision allow
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['hookSpecificOutput']['permissionDecision']=='allow'"
  # Must mention coherence check steps
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); ctx=d['hookSpecificOutput']['additionalContext']; assert 'docs/rules-reference.md' in ctx"
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); ctx=d['hookSpecificOutput']['additionalContext']; assert 'src/validation/rule-names.ts' in ctx"
}

@test "gh pr create with src/agent/prompt.ts emits advisory JSON" {
  add_diff_file "src/agent/prompt.ts"
  input=$(make_input "gh pr create --title test" "$TMPDIR")
  run bash -c "echo '$input' | '$SCRIPT'"
  [ "$status" -eq 0 ]
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['hookSpecificOutput']['permissionDecision']=='allow'"
}

@test "gh pr create with src/validation/ nested file emits advisory JSON" {
  add_diff_file "src/validation/tier2/registry-types.ts"
  input=$(make_input "gh pr create --title test" "$TMPDIR")
  run bash -c "echo '$input' | '$SCRIPT'"
  [ "$status" -eq 0 ]
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['hookSpecificOutput']['permissionDecision']=='allow'"
}

@test "gh pr create chained with && is detected" {
  add_diff_file "src/validation/nds003.ts"
  input=$(make_input "git push && gh pr create --title test" "$TMPDIR")
  run bash -c "echo '$input' | '$SCRIPT'"
  [ "$status" -eq 0 ]
  echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['hookSpecificOutput']['permissionDecision']=='allow'"
}
