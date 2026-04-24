#!/bin/bash
# kill-request-writer.sh — write a pending kill request to
# $SESSION_ROOT/kill_requests.jsonl (spec § 5.5 user_requested / W-5).
#
# Usage:
#   kill-request-writer.sh --seed=<id>
#
# Prereqs:
#   - SESSION_ROOT must be set (caller resolves via cmd_resolve_current)
#   - jq installed (inherited from session-helper.sh)
#
# Exit codes:
#   0 — success (entry appended)
#   2 — operator error (missing/invalid arg, SESSION_ROOT unset, lock failed)
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Source session-helper.sh just for acquire_project_lock + iso_now helpers.
# Guard with HELPER_SOURCED so neither the global flag-parse nor the
# PROJECT_ROOT computation runs on source — both would otherwise be
# evaluated against T23's own "$@" (W-1 fix: prevents session-helper's
# `--dry-run` global flag from silently consuming T23's args).
HELPER_SOURCED=1 source "$SCRIPT_DIR/session-helper.sh" || {
  echo "error: failed to source session-helper.sh" >&2
  exit 2
}

# acquire_project_lock requires $PROJECT_ROOT (the lock dir lives at
# $PROJECT_ROOT/.deep-evolve/.session-lock). When sourced with
# HELPER_SOURCED=1 the helper skipped its own discovery, so T23 computes
# its own PROJECT_ROOT here (W-1 — sourced helpers must not have execution
# side-effects on the caller's positional params or env).
PROJECT_ROOT="$(find_project_root 2>/dev/null)" || PROJECT_ROOT="$PWD"
export PROJECT_ROOT

SEED=""
for arg in "$@"; do
  case "$arg" in
    --seed=*) SEED="${arg#--seed=}" ;;
    --help|-h)
      # I-2 fix: usage goes to stdout (not stderr) on explicit user
      # request — matches Unix `man`/`<tool> --help` convention.
      echo "usage: kill-request-writer.sh --seed=<positive-int>"
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [ -z "$SEED" ]; then
  echo "error: --seed=<id> is required (got empty or missing)" >&2
  exit 2
fi

# Numeric validation (W-5 fix): require positive integer with no leading
# zeros. Accepting `01`/`007` would defer to a confusing jq parse error
# downstream because JSON forbids leading zeros (ECMA-404). Rejecting
# at the regex stage keeps the error message actionable.
if ! [[ "$SEED" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: --seed must be a positive integer with no leading zeros, got: $SEED" >&2
  exit 2
fi

# Note: the `^[1-9][0-9]*$` regex inherently rejects `0`, so no separate
# "$SEED -eq 0" check is needed. Seed IDs start at 1 per
# session.yaml.virtual_parallel.seeds[].id contract.

if [ -z "${SESSION_ROOT:-}" ]; then
  echo "error: SESSION_ROOT not set (caller must export it)" >&2
  exit 2
fi

if [ ! -d "$SESSION_ROOT" ]; then
  echo "error: SESSION_ROOT does not exist: $SESSION_ROOT" >&2
  exit 2
fi

REQUESTS_FILE="$SESSION_ROOT/kill_requests.jsonl"
TS="$(iso_now)"

# Build the JSON line. jq -cn ensures numeric seed_id (not string) and
# compact (no newlines within the record).
if ! LINE="$(jq -cn --argjson sid "$SEED" --arg ts "$TS" \
    '{seed_id: $sid, requested_at: $ts, confirmed: false}')"; then
  echo "error: failed to construct JSON for seed_id=$SEED" >&2
  exit 2
fi

if ! acquire_project_lock; then
  echo "error: failed to acquire project lock" >&2
  exit 2
fi

# printf '%s\n' — safe against xpg_echo escape re-interpretation (W-5).
if ! printf '%s\n' "$LINE" >> "$REQUESTS_FILE"; then
  echo "error: failed to append kill request to $REQUESTS_FILE (disk full? permissions?)" >&2
  release_project_lock
  exit 2
fi

release_project_lock
exit 0
