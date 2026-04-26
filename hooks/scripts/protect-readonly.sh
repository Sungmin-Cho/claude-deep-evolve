#!/usr/bin/env bash
# protect-readonly.sh — PreToolUse hook for deep-evolve (Codex review fix)
# Blocks edits to prepare.py, prepare-protocol.md, and program.md during active experiment runs.
# Handles Write/Edit/MultiEdit (file_path) AND Bash (shell file write detection).
# Exit 0 = allow, Exit 2 = block

set -euo pipefail

# Read tool name from Claude Code native env var with backwards-compatible fallback
TOOL_NAME="${CLAUDE_TOOL_USE_TOOL_NAME:-${CLAUDE_TOOL_NAME:-}}"

# Normalize path separators for cross-platform checks (Windows \ → /)
normalize_path() {
  local p="$1"
  p="${p//\\//}"
  while [[ "$p" == *"//"* ]]; do
    p="${p//\/\//\/}"
  done
  printf '%s' "$p"
}

# Find project root (walk up looking for .deep-evolve/)
find_evolve_root() {
  local dir
  dir="$(normalize_path "$PWD")"
  local prev=""
  while [[ "$dir" != "$prev" ]]; do
    if [[ -d "$dir/.deep-evolve" ]]; then
      echo "$dir"
      return 0
    fi
    prev="$dir"
    dir="$(dirname "$dir")"
    dir="$(normalize_path "$dir")"
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

# DEEP_EVOLVE_HELPER=1 bypass — registry files only, AND only when TOOL_NAME is
# a known non-Bash tool. Empty TOOL_NAME (env var missing) is treated as Bash-like:
# the safe default is to deny the bypass and run full command-pattern inspection.
# (C-4, R-6)
if [[ "${DEEP_EVOLVE_HELPER:-}" == "1" && -n "$TOOL_NAME" && "$TOOL_NAME" != "Bash" ]]; then
  FILE_PATH=""
  if echo "$TOOL_INPUT" | grep -q '"file_path"'; then
    FILE_PATH="$(echo "$TOOL_INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  fi
  case "$FILE_PATH" in
    */current.json|*/sessions.jsonl|*/session.yaml) exit 0 ;;
  esac
  # Non-registry file: fall through to normal protection
fi

# Protected paths (absolute)
PROTECTED_PREPARE="$SESSION_ROOT/prepare.py"
PROTECTED_PROTOCOL="$SESSION_ROOT/prepare-protocol.md"
PROTECTED_PROGRAM="$SESSION_ROOT/program.md"
PROTECTED_STRATEGY="$SESSION_ROOT/strategy.yaml"

# Meta modes (DEEP_EVOLVE_META_MODE):
#   program_update — allows program.md writes only (Phase 1 meta analysis)
#   outer_loop     — allows both program.md and strategy.yaml writes (Phase 2 Outer Loop)
#   prepare_update — (v3.0.0) allows prepare.py / prepare-protocol.md writes during
#                    Section D (Prepare Expansion), invoked manually OR forced by
#                    inner-loop.md Step 6.a.5 shortcut escalation, OR by outer-loop.md
#                    Step 6.5.6 Tier 3 auto-expansion. Must be exported before Write
#                    and unset after.
META_MODE="${DEEP_EVOLVE_META_MODE:-}"

block_protected() {
  cat <<JSON
{"decision":"block","reason":"Deep Evolve Guard: 실험 진행 중에는 평가 harness(prepare.py/prepare-protocol.md), program.md, strategy.yaml을 수정할 수 없습니다.\n\n평가 harness를 변경하려면 먼저 실험을 중단하고 /deep-evolve에서 'prepare 확장'을 선택하세요."}
JSON
  exit 2
}

block_sealed_read() {
  cat <<JSON
{"decision":"block","reason":"Deep Evolve Guard (v3 seal_prepare_read): 실험 중 prepare.py / prepare-protocol.md의 Read가 차단되었습니다. shortcut 탐지 회피용 하드코드 방지. 비활성화하려면 strategy.yaml.shortcut_detection.seal_prepare_read: false."}
JSON
  exit 2
}

command_references() {
  local needle="$1"
  [[ "$COMMAND_PAYLOAD" == *"$needle"* || "$COMMAND" == *"$needle"* ]]
}

is_direct_prepare_execution() {
  local first second rest
  read -r first second rest <<< "$COMMAND"
  case "$first" in
    python|python[0-9]*|*/python|*/python[0-9]*) ;;
    *) return 1 ;;
  esac
  second="${second#\"}"
  second="${second%\"}"
  second="${second#\'}"
  second="${second%\'}"
  [[ "$second" == "$SESSION_ROOT/prepare.py" || "$second" == "prepare.py" ]]
}

# === v3.0.0: optional read-block for prepare.py / prepare-protocol.md ===
# Gated on DEEP_EVOLVE_SEAL_PREPARE=1 (opt-in from strategy.yaml.shortcut_detection).
# Blocks Read tool calls that would reveal scenario text the agent could hardcode
# answers against. Default off → existing behavior preserved.
SEAL_PREPARE_READ="${DEEP_EVOLVE_SEAL_PREPARE:-}"
if [[ "$SEAL_PREPARE_READ" == "1" && "$TOOL_NAME" == "Read" ]]; then
  FILE_PATH=""
  if echo "$TOOL_INPUT" | grep -q '"file_path"'; then
    FILE_PATH="$(echo "$TOOL_INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  fi
  if [[ -n "$FILE_PATH" ]]; then
    # Canonicalize: relative paths resolved against PROJECT_ROOT (matches
    # existing Write/Edit branch below; fixes relative-path bypass).
    FILE_PATH="$(normalize_path "$FILE_PATH")"
    if [[ "$FILE_PATH" =~ ^[A-Za-z]:/ ]] || [[ "$FILE_PATH" == /* ]]; then
      : # already absolute
    else
      FILE_PATH="$(normalize_path "$PROJECT_ROOT/$FILE_PATH")"
    fi
    if [[ "$FILE_PATH" == "$PROTECTED_PREPARE" || "$FILE_PATH" == "$PROTECTED_PROTOCOL" ]]; then
      block_sealed_read
    fi
  fi
fi

# ── Write/Edit/MultiEdit: check file_path ──
if [[ "$TOOL_NAME" != "Bash" && "$TOOL_NAME" != "Read" ]]; then
  FILE_PATH=""
  if echo "$TOOL_INPUT" | grep -q '"file_path"'; then
    FILE_PATH="$(echo "$TOOL_INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  fi

  if [[ -z "$FILE_PATH" ]]; then
    exit 0
  fi

  # Normalize path separators and resolve absolute path
  FILE_PATH="$(normalize_path "$FILE_PATH")"
  if [[ "$FILE_PATH" =~ ^[A-Za-z]:/ ]] || [[ "$FILE_PATH" == /* ]]; then
    : # already absolute
  else
    FILE_PATH="$(normalize_path "$PROJECT_ROOT/$FILE_PATH")"
  fi

  case "$FILE_PATH" in
    "$PROTECTED_PREPARE"|"$PROTECTED_PROTOCOL")
      if [[ "$META_MODE" != "prepare_update" ]]; then
        block_protected
      fi ;;
    "$PROTECTED_PROGRAM")
      if [[ "$META_MODE" != "program_update" && "$META_MODE" != "outer_loop" ]]; then
        block_protected
      fi ;;
    "$SESSION_ROOT"/worktrees/seed_*/program.md)
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
COMMAND_PAYLOAD="$TOOL_INPUT"

if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# v3.0.0 seal_prepare_read must also cover Bash-based file reads such as
# `cat .deep-evolve/<sid>/prepare.py`; executing prepare.py remains allowed.
if [[ "$SEAL_PREPARE_READ" == "1" ]]; then
  for PROTECTED in "prepare.py" "prepare-protocol.md" "$SESSION_ROOT/prepare.py" "$SESSION_ROOT/prepare-protocol.md"; do
    if command_references "$PROTECTED"; then
      if [[ "$PROTECTED" == "prepare.py" || "$PROTECTED" == "$SESSION_ROOT/prepare.py" ]] && is_direct_prepare_execution; then
        continue
      fi
      block_sealed_read
    fi
  done
fi

# Build protected file list (conditional on META_MODE)
BASH_PROTECTED_FILES=()
if [[ "$META_MODE" != "prepare_update" ]]; then
  BASH_PROTECTED_FILES+=("prepare.py" "prepare-protocol.md" "$SESSION_ROOT/prepare.py" "$SESSION_ROOT/prepare-protocol.md")
fi
if [[ "$META_MODE" != "program_update" && "$META_MODE" != "outer_loop" ]]; then
  BASH_PROTECTED_FILES+=("program.md" "$SESSION_ROOT/program.md")
fi
if [[ "$META_MODE" != "outer_loop" ]]; then
  BASH_PROTECTED_FILES+=("strategy.yaml" "$SESSION_ROOT/strategy.yaml")
fi

# Deny-by-default for Bash references to protected files. Shell parsing is not
# reliable enough to distinguish every read/write form; direct prepare.py
# execution is the one active-run exception needed for evaluations.
for PROTECTED in "${BASH_PROTECTED_FILES[@]}"; do
  if command_references "$PROTECTED"; then
    if [[ "$PROTECTED" == "prepare.py" || "$PROTECTED" == "$SESSION_ROOT/prepare.py" ]] && is_direct_prepare_execution; then
      continue
    fi
    block_protected
  fi
done

exit 0
