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

# No .deep-evolve/ directory → allow everything
if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

# === Session root resolution (v2.2.0) ===
CURRENT_JSON="$PROJECT_ROOT/.deep-evolve/current.json"
SESSION_ROOT=""

if [[ -f "$CURRENT_JSON" ]]; then
  # v2.2.0 namespace layout
  SESSION_ID="$(jq -r '.session_id // empty' "$CURRENT_JSON" 2>/dev/null)"
  if [[ -n "$SESSION_ID" ]] && [[ -d "$PROJECT_ROOT/.deep-evolve/$SESSION_ID" ]]; then
    SESSION_ROOT="$PROJECT_ROOT/.deep-evolve/$SESSION_ID"
  fi
elif [[ -f "$PROJECT_ROOT/.deep-evolve/session.yaml" ]]; then
  # Legacy flat layout fallback
  SESSION_ROOT="$PROJECT_ROOT/.deep-evolve"
fi

# No session root resolved → allow everything
if [[ -z "$SESSION_ROOT" ]]; then
  exit 0
fi

SESSION_FILE="$SESSION_ROOT/session.yaml"

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

# DEEP_EVOLVE_HELPER=1 bypass — scoped to registry files only
if [[ "${DEEP_EVOLVE_HELPER:-}" == "1" ]]; then
  FILE_PATH=""
  if echo "$TOOL_INPUT" | grep -q '"file_path"'; then
    FILE_PATH="$(echo "$TOOL_INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  fi
  case "$FILE_PATH" in
    */current.json|*/sessions.jsonl|*/session.yaml) exit 0 ;;
    "") exit 0 ;;  # Bash tool — let normal detection handle
  esac
  # Fall through to normal protection for non-registry files
fi

# Protected paths (absolute)
PROTECTED_PREPARE="$SESSION_ROOT/prepare.py"
PROTECTED_PROTOCOL="$SESSION_ROOT/prepare-protocol.md"
PROTECTED_PROGRAM="$SESSION_ROOT/program.md"
PROTECTED_STRATEGY="$SESSION_ROOT/strategy.yaml"

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
BASH_PROTECTED_FILES=("prepare.py" "prepare-protocol.md" "$SESSION_ROOT/prepare.py" "$SESSION_ROOT/prepare-protocol.md")
if [[ "$META_MODE" != "program_update" && "$META_MODE" != "outer_loop" ]]; then
  BASH_PROTECTED_FILES+=("program.md" "$SESSION_ROOT/program.md")
fi
if [[ "$META_MODE" != "outer_loop" ]]; then
  BASH_PROTECTED_FILES+=("strategy.yaml" "$SESSION_ROOT/strategy.yaml")
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
