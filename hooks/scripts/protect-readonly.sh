#!/usr/bin/env bash
# protect-readonly.sh — PreToolUse hook for deep-evolve (Codex review fix)
# Blocks edits to prepare.py, prepare-protocol.md, and program.md during active experiment runs.
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

# v2.2.0+ layout forward-compat (X16)
# If current.json exists, this project uses v2.2.0 namespace layout.
# v2.1.2 hook cannot safely protect the right files — block mutating tools, allow reads.
if [[ -n "$PROJECT_ROOT" ]] && [[ -f "$PROJECT_ROOT/.deep-evolve/current.json" ]]; then
  # Allow read-only tools (Read, Grep, Glob, LS) — no file mutation risk
  if [[ "$TOOL_NAME" == "Read" ]] || [[ "$TOOL_NAME" == "Grep" ]] || [[ "$TOOL_NAME" == "Glob" ]] || [[ "$TOOL_NAME" == "LS" ]]; then
    exit 0
  fi
  echo "deep-evolve: v2.2.0+ 레이아웃이 감지되었습니다. 플러그인을 v2.2.0으로 업그레이드하세요." >&2
  cat <<JSON
{"decision":"block","reason":"Deep Evolve Guard: v2.2.0+ 레이아웃 감지. 쓰기 작업은 플러그인 업그레이드 후 가능합니다."}
JSON
  exit 2
fi

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
PROTECTED_PROTOCOL="$EVOLVE_DIR/prepare-protocol.md"
PROTECTED_PROGRAM="$EVOLVE_DIR/program.md"
PROTECTED_STRATEGY="$EVOLVE_DIR/strategy.yaml"

# Meta modes (DEEP_EVOLVE_META_MODE):
#   program_update — allows program.md writes only (Phase 1 meta analysis)
#   outer_loop     — allows both program.md and strategy.yaml writes (Phase 2 Outer Loop)
META_MODE="${DEEP_EVOLVE_META_MODE:-}"

block_protected() {
  cat <<JSON
{"decision":"block","reason":"Deep Evolve Guard: 실험 진행 중에는 평가 harness(prepare.py/prepare-protocol.md), program.md, strategy.yaml을 수정할 수 없습니다.\n\n평가 harness를 변경하려면 먼저 실험을 중단하고 /deep-evolve에서 'prepare 확장'을 선택하세요."}
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
    "$PROTECTED_PREPARE"|"$PROTECTED_PROTOCOL") block_protected ;;
    "$PROTECTED_PROGRAM")
      if [[ "$META_MODE" != "program_update" && "$META_MODE" != "outer_loop" ]]; then
        block_protected
      fi ;;
    "$PROTECTED_STRATEGY")
      if [[ "$META_MODE" != "outer_loop" ]]; then
        block_protected
      fi ;;
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

# Build protected file list (conditional on META_MODE)
BASH_PROTECTED_FILES=("prepare.py" "prepare-protocol.md" ".deep-evolve/prepare.py" ".deep-evolve/prepare-protocol.md")
if [[ "$META_MODE" != "program_update" && "$META_MODE" != "outer_loop" ]]; then
  BASH_PROTECTED_FILES+=("program.md" ".deep-evolve/program.md")
fi
if [[ "$META_MODE" != "outer_loop" ]]; then
  BASH_PROTECTED_FILES+=("strategy.yaml" ".deep-evolve/strategy.yaml")
fi

# Check if the bash command references protected files with write operations
for PROTECTED in "${BASH_PROTECTED_FILES[@]}"; do
  if echo "$COMMAND" | grep -qE "(>|>>|sed\s+-i|tee|cp|mv|chmod|chown|perl\s+.*-i)\s*.*$PROTECTED"; then
    block_protected
  fi
  if echo "$COMMAND" | grep -qF "$PROTECTED" && echo "$COMMAND" | grep -qE "(>|>>|sed\s+-i|tee\s|cp\s|mv\s)"; then
    block_protected
  fi
done

exit 0
