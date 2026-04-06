#!/usr/bin/env bash
# protect-readonly.sh — PreToolUse hook for deep-evolve (Codex review fix)
# Blocks edits to prepare.py and program.md during active experiment runs.
# Handles Write/Edit/MultiEdit (file_path) AND Bash (shell file write detection).
# Exit 0 = allow, Exit 2 = block

set -euo pipefail

TOOL_NAME="${CLAUDE_TOOL_NAME:-}"

# Find project root (walk up looking for .deep-evolve/)
find_evolve_root() {
  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    if [[ -d "$dir/.deep-evolve" ]]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

PROJECT_ROOT="$(find_evolve_root 2>/dev/null || echo "")"

# No .deep-evolve/ directory → allow everything
if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

SESSION_FILE="$PROJECT_ROOT/.deep-evolve/session.yaml"

# No session file or not active → allow
if [[ ! -f "$SESSION_FILE" ]]; then
  exit 0
fi

# Check status (simple grep — avoid YAML parser dependency)
STATUS="$(grep '^status:' "$SESSION_FILE" | head -1 | sed 's/^status:[[:space:]]*//')"
if [[ "$STATUS" != "active" ]]; then
  exit 0
fi

# Read tool input from stdin
TOOL_INPUT="$(cat)"

# Protected paths (absolute)
EVOLVE_DIR="$PROJECT_ROOT/.deep-evolve"
PROTECTED_PREPARE="$EVOLVE_DIR/prepare.py"
PROTECTED_PROGRAM="$EVOLVE_DIR/program.md"

block_protected() {
  cat <<JSON
{"decision":"block","reason":"Deep Evolve Guard: 실험 진행 중에는 prepare.py와 program.md를 수정할 수 없습니다.\n\nprepare.py를 변경하려면 먼저 실험을 중단하고 /deep-evolve에서 'prepare.py 확장'을 선택하세요."}
JSON
  exit 2
}

# ── Write/Edit/MultiEdit: check file_path ──
if [[ "$TOOL_NAME" != "Bash" ]]; then
  FILE_PATH=""
  if echo "$TOOL_INPUT" | grep -q '"file_path"'; then
    FILE_PATH="$(echo "$TOOL_INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  fi

  if [[ -z "$FILE_PATH" ]]; then
    exit 0
  fi

  # Normalize to absolute path
  if [[ "$FILE_PATH" != /* ]]; then
    FILE_PATH="$PROJECT_ROOT/$FILE_PATH"
  fi

  case "$FILE_PATH" in
    "$PROTECTED_PREPARE"|"$PROTECTED_PROGRAM") block_protected ;;
  esac
  exit 0
fi

# ── Bash: detect shell writes to protected files ──
COMMAND=""
if echo "$TOOL_INPUT" | grep -q '"command"'; then
  COMMAND="$(echo "$TOOL_INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
fi

if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Check if the bash command references protected files with write operations
for PROTECTED in "prepare.py" "program.md" ".deep-evolve/prepare.py" ".deep-evolve/program.md"; do
  if echo "$COMMAND" | grep -qE "(>|>>|sed\s+-i|tee|cp|mv|chmod|chown|perl\s+.*-i)\s*.*$PROTECTED"; then
    block_protected
  fi
  if echo "$COMMAND" | grep -qF "$PROTECTED" | grep -qE "(>|>>|sed\s+-i|tee\s|cp\s|mv\s)"; then
    block_protected
  fi
done

exit 0
