#!/usr/bin/env bash
# session-helper.sh — deep-evolve session management helper
# Usage: session-helper.sh <subcommand> [args...]
set -Eeuo pipefail

HELPER_VERSION="3.0.0"
export DEEP_EVOLVE_HELPER=1

# === Dependencies ===
command -v jq >/dev/null 2>&1 || { echo "session-helper: jq >= 1.6 required" >&2; exit 127; }
command -v flock >/dev/null 2>&1 && FLOCK_AVAILABLE=1 || FLOCK_AVAILABLE=0

# === Globals ===
PROJECT_ROOT=""
DRY_RUN=0
_LOCK_OWNER=""  # PID of process that acquired the lock

# === Utility Functions ===

cleanup() {
  # P3: Only release lock if THIS process owns it
  if [ "$_LOCK_OWNER" = "$$" ] && [ -n "$PROJECT_ROOT" ]; then
    rmdir "$PROJECT_ROOT/.deep-evolve/.session-lock" 2>/dev/null || true
  fi
  rm -f /tmp/session-helper-*.tmp 2>/dev/null || true
}
trap 'cleanup' EXIT

iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || gdate -u +"%Y-%m-%dT%H:%M:%SZ"
}

normalize_path() {
  local p="$1"
  p="${p//\\//}"
  while [[ "$p" == *"//"* ]]; do
    p="${p//\/\//\/}"
  done
  printf '%s' "$p"
}

compute_slug() {
  local input="$1"
  local slug
  slug=$(printf '%s' "$input" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-*//; s/-*$//' \
    | cut -c1-40)
  if [ -z "$slug" ]; then
    # Unicode-only input → hash fallback (shasum or sha256sum)
    local hash_cmd="shasum"
    command -v shasum >/dev/null 2>&1 || hash_cmd="sha256sum"
    slug="session-$(printf '%s' "$input$(iso_now)" | $hash_cmd | cut -c1-6)"
  fi
  printf '%s' "$slug"
}

find_project_root() {
  local dir
  dir="$(normalize_path "$PWD")"
  local prev=""
  while [ "$dir" != "$prev" ]; do
    if [ -d "$dir/.deep-evolve" ]; then
      printf '%s' "$dir"
      return 0
    fi
    prev="$dir"
    dir="$(normalize_path "$(dirname "$dir")")"
  done
  return 1
}

acquire_project_lock() {
  local lockdir="$PROJECT_ROOT/.deep-evolve/.session-lock"
  local retries=10
  while ! mkdir "$lockdir" 2>/dev/null; do
    retries=$((retries - 1))
    if [ $retries -le 0 ]; then
      echo "session-helper: lock acquisition timeout" >&2
      return 1
    fi
    sleep 0.5
  done
  _LOCK_OWNER="$$"  # P3: Track ownership
}

release_project_lock() {
  rmdir "$PROJECT_ROOT/.deep-evolve/.session-lock" 2>/dev/null || true
  _LOCK_OWNER=""
}

dry_run_guard() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] would execute: $*" >&2
    return 0
  fi
  return 1
}

ensure_evolve_dir() {
  mkdir -p "$EVOLVE_DIR"
}

# === Subcommand functions ===

cmd_help() {
  echo "session-helper.sh v$HELPER_VERSION"
  echo ""
  echo "Session lifecycle:"
  echo "  compute_session_id, resolve_current, list_sessions,"
  echo "  start_new_session, mark_session_status, append_sessions_jsonl,"
  echo "  migrate_legacy, check_branch_alignment, detect_orphan_experiment,"
  echo "  append_meta_archive_local, render_inherited_context, lineage_tree"
  echo ""
  echo "v3.0.0 subcommands (AAR-inspired):"
  echo "  entropy_compute <journal> [window_size]         — Shannon entropy over recent planned events"
  echo "  migrate_v2_weights <v2_json>                    — Translate 4-cat v2 weights to 10-cat v3"
  echo "  count_flagged_since_last_expansion <journal>    — Count shortcut_flagged since last reset"
  echo "  retry_budget_remaining <journal> [cap]          — Diagnose-retry budget remaining"
}

cmd_compute_session_id() {
  local goal="${1:-}"
  local slug
  slug=$(compute_slug "$goal")
  local today
  today=$(date -u +"%Y-%m-%d")
  local base_id="${today}_${slug}"
  local candidate="$base_id"
  local suffix=2

  # Collision check against sessions.jsonl
  if [ -f "$EVOLVE_DIR/sessions.jsonl" ]; then
    while grep -q "\"session_id\":\"$candidate\"" "$EVOLVE_DIR/sessions.jsonl" 2>/dev/null; do
      candidate="${base_id}-${suffix}"
      suffix=$((suffix + 1))
    done
  fi

  printf '%s' "$candidate"
}

cmd_resolve_current() {
  local current_json="$EVOLVE_DIR/current.json"

  if [ ! -f "$current_json" ]; then
    echo "session-helper: no active session (current.json missing)" >&2
    exit 1
  fi

  local session_id
  session_id=$(jq -r '.session_id // empty' "$current_json" 2>/dev/null)
  if [ -z "$session_id" ]; then
    echo "session-helper: no active session (session_id null)" >&2
    exit 1
  fi

  local session_root="$EVOLVE_DIR/$session_id"
  if [ ! -d "$session_root" ]; then
    echo "session-helper: orphan pointer — session dir missing: $session_root" >&2
    echo "session-helper: run 'list_sessions' to find available sessions" >&2
    exit 1
  fi

  if [ ! -f "$session_root/session.yaml" ]; then
    echo "session-helper: session dir exists but session.yaml missing: $session_root" >&2
    exit 1
  fi

  # AH2: Status reconciliation (P2: use jq for JSON generation)
  if [ -f "$EVOLVE_DIR/sessions.jsonl" ]; then
    local actual_status
    actual_status=$(grep '^status:' "$session_root/session.yaml" 2>/dev/null | head -1 | sed 's/^status:[[:space:]]*//')
    local jsonl_status
    jsonl_status=$(grep "\"session_id\":\"$session_id\"" "$EVOLVE_DIR/sessions.jsonl" \
      | grep -E '"event":"(status_change|finished|created)"' \
      | tail -1 \
      | jq -r '.status // empty' 2>/dev/null || true)

    if [ -n "$jsonl_status" ] && [ -n "$actual_status" ] && [ "$jsonl_status" != "$actual_status" ]; then
      jq -nc --arg sid "$session_id" --arg from "$jsonl_status" --arg to "$actual_status" --arg ts "$(iso_now)" \
        '{event:"reconciled", ts:$ts, session_id:$sid, from:$from, to:$to}' \
        >> "$EVOLVE_DIR/sessions.jsonl"
    fi
  fi

  printf '%s\t%s\n' "$session_id" "$session_root"
}

cmd_append_sessions_jsonl() {
  local event="$1" session_id="$2"
  shift 2
  # Remaining args are --key=value pairs for extra fields
  local jq_args=()
  jq_args+=(--arg event "$event" --arg ts "$(iso_now)" --arg sid "$session_id")
  local jq_extra=""

  for arg in "$@"; do
    case "$arg" in
      --*=*)
        local key="${arg%%=*}" val="${arg#*=}"
        key="${key#--}"
        jq_args+=(--arg "$key" "$val")
        jq_extra="$jq_extra + {($key): \$$key}"
        ;;
    esac
  done

  local line
  line=$(jq -nc "${jq_args[@]}" "{event:\$event, ts:\$ts, session_id:\$sid} $jq_extra")

  if dry_run_guard "append to sessions.jsonl: $line"; then
    return 0
  fi

  printf '%s\n' "$line" >> "$EVOLVE_DIR/sessions.jsonl"
}

cmd_start_new_session() {
  local goal="${1:-}"
  local parent_id=""
  shift || true
  for arg in "$@"; do
    case "$arg" in --parent=*) parent_id="${arg#--parent=}" ;; esac
  done

  # Codex review fix: .deep-evolve/ 자체가 없을 수 있음 (최초 init)
  ensure_evolve_dir

  acquire_project_lock || exit 1

  # H-1 fix: compute session_id inside the lock + retry on collision with suffix.
  local session_id base_id suffix=2
  session_id=$(cmd_compute_session_id "$goal")
  base_id="$session_id"
  local session_root="$EVOLVE_DIR/$session_id"
  while [ -e "$session_root" ]; do
    session_id="${base_id}-${suffix}"
    session_root="$EVOLVE_DIR/$session_id"
    suffix=$((suffix + 1))
    if [ "$suffix" -gt 1000 ]; then
      release_project_lock
      echo "session-helper: session_id collision retry exhausted" >&2
      exit 1
    fi
  done

  if dry_run_guard "create session $session_id at $session_root"; then
    release_project_lock
    printf '%s\t%s\n' "$session_id" "$session_root"
    return 0
  fi

  # Create namespace dir
  mkdir -p "$session_root"/{runs,code-archive,strategy-archive,meta-analyses} || {
    rm -rf "$session_root"
    release_project_lock
    echo "session-helper: failed to create session dir" >&2
    exit 1
  }

  # C-7 fix: session starts in 'initializing' status. init.md Step 11 transitions to 'active'
  # after baseline writeback (protect-readonly.sh only enforces when status=="active").
  local jq_args=(--arg goal "$goal" --arg status "initializing")
  local jq_extra='+ {goal:$goal, status:$status}'
  if [ -n "$parent_id" ]; then
    jq_args+=(--arg pid "$parent_id")
    jq_extra="$jq_extra + {parent_session_id:\$pid}"
  fi
  local line
  line=$(jq -nc --arg event "created" --arg ts "$(iso_now)" --arg sid "$session_id" \
    "${jq_args[@]}" \
    "{event:\$event, ts:\$ts, session_id:\$sid} $jq_extra")
  printf '%s\n' "$line" >> "$EVOLVE_DIR/sessions.jsonl" || {
    rm -rf "$session_root"
    release_project_lock
    echo "session-helper: failed to append sessions.jsonl" >&2
    exit 1
  }

  # Write current.json (atomic via tmp+mv, P2: jq for JSON)
  local tmp_current
  tmp_current=$(mktemp "$EVOLVE_DIR/current.json.XXXXXX")
  jq -nc --arg sid "$session_id" --arg ts "$(iso_now)" \
    '{session_id:$sid, started_at:$ts}' > "$tmp_current"
  mv "$tmp_current" "$EVOLVE_DIR/current.json"

  release_project_lock
  printf '%s\t%s\n' "$session_id" "$session_root"
}

cmd_mark_session_status() {
  local session_id="$1" new_status="$2"
  local session_root="$EVOLVE_DIR/$session_id"

  acquire_project_lock || exit 1

  if dry_run_guard "mark $session_id as $new_status"; then
    release_project_lock
    return 0
  fi

  # Update session.yaml status (portable sed: tmp+mv)
  if [ -f "$session_root/session.yaml" ]; then
    local tmp_yaml
    tmp_yaml=$(mktemp "$session_root/session.yaml.XXXXXX")
    sed "s/^status:.*/status: $new_status/" "$session_root/session.yaml" > "$tmp_yaml"
    mv "$tmp_yaml" "$session_root/session.yaml"
  fi

  # P2+P3: jq for JSON, 직접 append (재귀 호출 제거)
  jq -nc --arg event "status_change" --arg ts "$(iso_now)" --arg sid "$session_id" --arg s "$new_status" \
    '{event:$event, ts:$ts, session_id:$sid, status:$s}' \
    >> "$EVOLVE_DIR/sessions.jsonl"

  release_project_lock
}

cmd_migrate_legacy() {
  # Detect flat layout
  if [ ! -f "$EVOLVE_DIR/session.yaml" ] || [ -f "$EVOLVE_DIR/current.json" ]; then
    echo "session-helper: no legacy layout to migrate" >&2
    exit 1
  fi

  local ts
  ts=$(iso_now | tr ':' '-')
  local goal
  goal=$(grep '^goal:' "$EVOLVE_DIR/session.yaml" 2>/dev/null | head -1 | sed 's/^goal:[[:space:]]*//' | tr -d '"')
  goal="${goal:-unknown}"
  local slug
  slug=$(compute_slug "$goal")
  local legacy_id="legacy-${ts}_${slug}"
  local legacy_dir="$EVOLVE_DIR/${legacy_id}"

  # P4 idempotency: check if legacy dir already exists (partial previous run)
  local skip_copy=0
  if [ -d "$legacy_dir" ]; then
    if [ -f "$legacy_dir/session.yaml" ]; then
      echo "session-helper: legacy dir already exists and looks complete, skipping copy" >&2
      skip_copy=1
    else
      echo "session-helper: incomplete legacy dir found, removing and retrying" >&2
      rm -rf "$legacy_dir"
    fi
  fi

  if dry_run_guard "migrate flat layout to $legacy_dir"; then
    return 0
  fi

  acquire_project_lock || exit 1

  # C-3 fix: declare lists outside skip_copy guard so the later rm loop
  # still sees them when idempotent re-runs short-circuit the copy phase.
  local files_to_copy=(session.yaml strategy.yaml program.md prepare.py prepare-protocol.md results.tsv journal.jsonl report.md evolve-receipt.json)
  local dirs_to_copy=(runs code-archive strategy-archive)

  if [ "$skip_copy" -eq 0 ]; then
  # 1) Create namespace dir
  mkdir -p "$legacy_dir/meta-analyses" || { release_project_lock; return 1; }

  # 2) COPY (not move) — P4: FAIL on any copy error (no || true)
  local copy_failed=0

  for f in "${files_to_copy[@]}"; do
    if [ -f "$EVOLVE_DIR/$f" ]; then
      cp "$EVOLVE_DIR/$f" "$legacy_dir/" || { copy_failed=1; break; }
    fi
  done
  for d in "${dirs_to_copy[@]}"; do
    if [ "$copy_failed" -eq 1 ]; then break; fi
    if [ -d "$EVOLVE_DIR/$d" ]; then
      cp -R "$EVOLVE_DIR/$d" "$legacy_dir/" || { copy_failed=1; break; }
    fi
  done
  if [ -f "$EVOLVE_DIR/meta-analysis.md" ]; then
    cp "$EVOLVE_DIR/meta-analysis.md" "$legacy_dir/meta-analyses/gen-legacy.md" || { copy_failed=1; }
  fi

  if [ "$copy_failed" -eq 1 ]; then
    echo "session-helper: copy failed — rolling back" >&2
    rm -rf "$legacy_dir"
    release_project_lock
    return 1
  fi

  # 3) P4: Complete manifest verification (not just session.yaml)
  local verify_ok=1
  for f in "${files_to_copy[@]}"; do
    if [ -f "$EVOLVE_DIR/$f" ] && [ ! -f "$legacy_dir/$f" ]; then
      echo "session-helper: verification failed: $f missing in destination" >&2
      verify_ok=0
    fi
  done
  for d in "${dirs_to_copy[@]}"; do
    if [ -d "$EVOLVE_DIR/$d" ] && [ ! -d "$legacy_dir/$d" ]; then
      echo "session-helper: verification failed: $d/ missing in destination" >&2
      verify_ok=0
    fi
  done

  if [ "$verify_ok" -eq 0 ]; then
    echo "session-helper: manifest verification failed — rolling back" >&2
    rm -rf "$legacy_dir"
    release_project_lock
    return 1
  fi

  fi  # end skip_copy guard

  # 4) Write registry (P2: jq for JSON, P3: 직접 append)
  # CR3: migrated sessions are always terminal — active/paused → "archived"
  local orig_status
  orig_status=$(grep '^status:' "$legacy_dir/session.yaml" 2>/dev/null | head -1 | sed 's/^status:[[:space:]]*//')
  local status
  case "${orig_status:-legacy}" in
    completed|aborted) status="$orig_status" ;;
    *) status="archived" ;;  # active/paused/legacy → terminal
  esac
  jq -nc --arg event "migrated" --arg ts "$(iso_now)" --arg sid "$legacy_id" \
    --arg from "flat_layout" --arg s "$status" --arg g "$goal" --arg lr "unavailable" \
    '{event:$event, ts:$ts, session_id:$sid, from:$from, status:$s, goal:$g, legacy_recovery:$lr}' \
    >> "$EVOLVE_DIR/sessions.jsonl"

  # Do NOT create current.json — legacy is treated as completed

  # 5) Remove originals (only after registry update succeeded)
  # report.md, evolve-receipt.json은 이미 files_to_copy에 포함
  for f in "${files_to_copy[@]}"; do
    rm -f "$EVOLVE_DIR/$f" 2>/dev/null
  done
  for d in "${dirs_to_copy[@]}"; do
    rm -rf "$EVOLVE_DIR/$d" 2>/dev/null
  done
  rm -f "$EVOLVE_DIR/meta-analysis.md" 2>/dev/null

  release_project_lock
  echo "session-helper: migrated to $legacy_dir"
}

cmd_check_branch_alignment() {
  local session_dir="$1"
  local expected
  # R-11/M-2 fix: match exactly 2-space-indented current_branch under lineage: (session.yaml
  # schema fixes indent to 2 spaces at top-level block entries). Nested keys like
  # forked_from.current_branch are at 4+ spaces and will NOT match.
  expected=$(awk '
    /^lineage:/ { in_lineage=1; next }
    /^[^[:space:]]/ { in_lineage=0 }
    in_lineage && /^  current_branch:/ {
      sub(/^  current_branch:[[:space:]]*/, "")
      gsub(/"/, "")
      print
      exit
    }
  ' "$session_dir/session.yaml" 2>/dev/null)
  local actual
  actual=$(git branch --show-current 2>/dev/null)

  if [ -z "$expected" ] || [ "$expected" = "$actual" ]; then
    exit 0
  fi

  echo "branch mismatch: expected '$expected', actual '$actual'" >&2
  exit 1
}

cmd_detect_orphan_experiment() {
  local session_dir="$1"
  local journal="$session_dir/journal.jsonl"

  if [ ! -f "$journal" ]; then
    return 0
  fi

  # Portable reverse (tac not on all macOS)
  local reversed
  if command -v tac >/dev/null 2>&1; then
    reversed=$(tac "$journal")
  else
    reversed=$(tail -r "$journal" 2>/dev/null || cat "$journal")
  fi

  # Find last committed event without matching evaluated
  local last_committed_n
  last_committed_n=$(printf '%s\n' "$reversed" \
    | grep '"status":"committed"' \
    | head -1 \
    | jq -r '.id // empty' 2>/dev/null || true)

  if [ -z "$last_committed_n" ]; then
    return 0
  fi

  # AH2: Use jq for exact numeric id matching (not grep substring)
  local has_resolution
  has_resolution=$(jq -s --argjson id "$last_committed_n" \
    '[.[] | select(.id == $id and (.status == "evaluated" or .status == "kept" or .status == "discarded" or .status == "rollback_completed"))] | length' \
    "$journal" 2>/dev/null || echo 0)

  if [ "$has_resolution" -eq 0 ]; then
    local commit_hash
    commit_hash=$(jq -s --argjson id "$last_committed_n" \
      '[.[] | select(.id == $id and .status == "committed")] | .[0].commit // empty' \
      "$journal" 2>/dev/null)
    [ -n "$commit_hash" ] && [ "$commit_hash" != "null" ] && printf '%s' "$commit_hash"
  fi
}

cmd_list_sessions() {
  local filter_status=""
  for arg in "$@"; do
    case "$arg" in --status=*) filter_status="${arg#--status=}" ;; esac
  done

  if [ ! -f "$EVOLVE_DIR/sessions.jsonl" ]; then
    echo "[]"
    return 0
  fi

  # I2: jq --slurp로 한번에 처리 (O(N) 한 프로세스, per-line jq 호출 제거)
  # Codex review fix: reconciled 이벤트는 .to 필드로 status 갱신 (.status 아님)
  local result
  result=$(jq -s '
    reduce .[] as $e ([];
      if $e.event == "created" or $e.event == "migrated" then
        . + [$e]
      elif $e.event == "status_change" then
        [.[] | if .session_id == $e.session_id then .status = $e.status else . end]
      elif $e.event == "reconciled" then
        # Codex review fix: reconciled 이벤트는 .to 필드에 실제 status가 있음
        [.[] | if .session_id == $e.session_id then .status = $e.to else . end]
      elif $e.event == "lineage_set" then
        [.[] | if .session_id == $e.session_id then .parent_session_id = $e.parent_session_id else . end]
      elif $e.event == "finished" then
        [.[] | if .session_id == $e.session_id then . + ($e | del(.event, .ts)) else . end]
      else
        .
      end
    )
  ' "$EVOLVE_DIR/sessions.jsonl")

  if [ -n "$filter_status" ]; then
    result=$(printf '%s' "$result" | jq --arg s "$filter_status" '[.[] | select(.status == $s)]')
  fi

  printf '%s\n' "$result" | jq .
}

cmd_append_meta_archive_local() {
  local session_id="$1"
  local session_root="$EVOLVE_DIR/$session_id"
  local receipt="$session_root/evolve-receipt.json"

  if [ ! -f "$receipt" ]; then
    echo "session-helper: receipt not found for $session_id" >&2
    exit 1
  fi

  if dry_run_guard "append to meta-archive-local.jsonl from $receipt"; then
    return 0
  fi

  # Extract summary fields from receipt
  jq -c '{
    session_id: .session_id,
    goal: .goal,
    started_at: .timestamp,
    finished_at: (now | todate),
    status: .outcome,
    outcome: .outcome,
    parent_session_id: (.parent_session.id // null),
    experiments: { total: .experiments.total, kept: .experiments.kept, keep_rate: (.experiments.kept / (.experiments.total | if . == 0 then 1 else . end)) },
    score: { baseline: .score.baseline, best: .score.best, improvement_pct: .score.improvement_pct },
    q_trajectory: [.strategy_evolution.q_trajectory[]?.Q],
    generations: .strategy_evolution.outer_loop_generations
  }' "$receipt" >> "$EVOLVE_DIR/meta-archive-local.jsonl"
}

cmd_render_inherited_context() {
  local parent_id="$1"
  local parent_root="$EVOLVE_DIR/$parent_id"
  local receipt="$parent_root/evolve-receipt.json"

  if [ ! -f "$receipt" ]; then
    echo "session-helper: parent receipt not found at $receipt" >&2
    exit 1
  fi

  local parent_schema_ver
  parent_schema_ver=$(jq -r '.receipt_schema_version // 1' "$receipt")

  cat <<HEREDOC
<!-- inherited-context-v1 -->
## Inherited Context (from $parent_id)

이 세션은 선행 세션 \`$parent_id\`의 결과를 이어받는다.

### 이어받은 전략 패턴
$(jq -r '
  .generation_snapshots[-1] // {} |
  if .strategy_yaml_content then
    .strategy_yaml_content | split("\n") | map(select(test("^[a-z].*:"))) | .[0:5] | map("- " + .) | join("\n")
  else
    "(전략 스냅샷 없음)"
  end
' "$receipt")

### 선행 세션에서 참조할 만한 개선 (informational only, NOT replayed)
$(jq -r '
  .notable_keeps // [] | map(
    "- commit " + .commit + " (Δ+" + (.score_delta | tostring) + ", source=" + .source + "): " + .description
  ) | join("\n") | if . == "" then "(notable keeps 없음)" else . end
' "$receipt")

### 선행 세션의 최종 교훈
$(jq -r '
  .generation_snapshots[-1].meta_analysis_content // "(meta-analysis 없음)" |
  split("\n\n")[0]
' "$receipt")

---

<!-- /inherited-context-v1 -->
HEREDOC
}

cmd_lineage_tree() {
  if [ ! -f "$EVOLVE_DIR/sessions.jsonl" ]; then
    echo "(no sessions)"
    exit 0
  fi

  # Build lineage chain from sessions.jsonl
  local sessions
  sessions=$(cmd_list_sessions)

  # Extract id → parent_session_id mapping
  printf '%s' "$sessions" | jq -r '.[] |
    .session_id + " <- " + (.parent_session_id // "(root)")
  '
}

cmd_entropy_compute() {
  local journal_path="${1:-}"
  local window_size="${2:-20}"
  if [[ -z "$journal_path" || ! -f "$journal_path" ]]; then
    echo '{"error":"missing or nonexistent journal path"}' >&2
    return 1
  fi
  python3 - "$journal_path" "$window_size" <<'PY'
import json, sys, math
from collections import Counter

journal_path, window_size = sys.argv[1], int(sys.argv[2])
planned = []
with open(journal_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if evt.get("status") == "planned" and evt.get("idea_category"):
            planned.append(evt["idea_category"])

recent = planned[-window_size:]
if len(recent) < 5:
    print(json.dumps({
        "entropy_bits": None,
        "active_categories": len(set(recent)),
        "reason": "insufficient_sample",
        "sample_size": len(recent),
    }))
    sys.exit(0)

dist = Counter(recent)
total = sum(dist.values())
H = 0.0
for c in dist.values():
    p = c / total
    if p > 0:
        H -= p * math.log2(p)
print(json.dumps({
    "entropy_bits": round(H, 6),
    "active_categories": len(dist),
    "sample_size": total,
}))
PY
}

cmd_migrate_v2_weights() {
  local v2_json="${1:-}"
  if [[ -z "$v2_json" || ! -f "$v2_json" ]]; then
    echo '{"error":"missing or nonexistent v2 weights JSON"}' >&2
    return 1
  fi
  python3 - "$v2_json" <<'PY'
import json, sys

v2 = json.load(open(sys.argv[1]))
FLOOR = 0.05
pre = {
    "parameter_tune":      v2.get("parameter_tuning", 0.0),
    "refactor_simplify":   v2.get("simplification", 0.0),
    "algorithm_swap":      v2.get("algorithm_swap", 0.0),
    "add_guard":           v2.get("structural_change", 0.0) / 3.0,
    "api_redesign":        v2.get("structural_change", 0.0) / 3.0,
    "error_handling":      v2.get("structural_change", 0.0) / 3.0,
    "data_preprocessing":  FLOOR,
    "caching_memoization": FLOOR,
    "test_expansion":      FLOOR,
    "other":               FLOOR,
}
total = sum(pre.values())
if total > 0:
    weights = {k: (v / total) for k, v in pre.items()}
else:
    # Defensive: total==0 is unreachable in practice (4 FLOOR=0.05 entries
    # guarantee total >= 0.20) but if someone disables the floor in a future
    # refactor, emit even-split 10-category weights rather than all-zeros.
    weights = {k: 0.1 for k in pre.keys()}
print(json.dumps({"weights": weights, "pre_normalize_sum": round(total, 6)}))
PY
}

cmd_count_flagged_since_last_expansion() {
  local journal_path="${1:-}"
  if [[ -z "$journal_path" || ! -f "$journal_path" ]]; then
    echo '{"error":"missing or nonexistent journal path"}' >&2
    return 1
  fi
  python3 - "$journal_path" <<'PY'
import json, sys

events = []
with open(sys.argv[1]) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass

last_reset_idx = -1
for i, evt in enumerate(events):
    if evt.get("event") in ("shortcut_escalation", "tier3_flagged_reset"):
        last_reset_idx = i

count = sum(
    1 for evt in events[last_reset_idx + 1:]
    if evt.get("event") == "shortcut_flagged"
)
print(json.dumps({"count": count, "last_reset_idx": last_reset_idx}))
PY
}

cmd_retry_budget_remaining() {
  local journal_path="${1:-}"
  local max_per_session="${2:-10}"
  if [[ -z "$journal_path" || ! -f "$journal_path" ]]; then
    echo '{"error":"missing or nonexistent journal path"}' >&2
    return 1
  fi
  python3 - "$journal_path" "$max_per_session" <<'PY'
import json, sys

journal_path, cap = sys.argv[1], int(sys.argv[2])
used = 0
with open(journal_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if evt.get("event") == "diagnose_retry_started":
            used += 1
remaining = max(0, cap - used)
print(json.dumps({"used": used, "remaining": remaining, "cap": cap}))
PY
}

# === Parse global flags ===
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}

# Codex review fix: find_project_root 실패 시 PWD 사용 (최초 프로젝트 init 지원)
PROJECT_ROOT="$(find_project_root 2>/dev/null)" || PROJECT_ROOT="$PWD"
EVOLVE_DIR="$PROJECT_ROOT/.deep-evolve"

# === Dispatch ===
SUBCMD="${1:-help}"
shift || true

case "$SUBCMD" in
  help) cmd_help ;;
  compute_session_id) cmd_compute_session_id "$@" ;;
  resolve_current) cmd_resolve_current "$@" ;;
  list_sessions) cmd_list_sessions "$@" ;;
  start_new_session) cmd_start_new_session "$@" ;;
  mark_session_status) cmd_mark_session_status "$@" ;;
  append_sessions_jsonl) cmd_append_sessions_jsonl "$@" ;;
  migrate_legacy) cmd_migrate_legacy "$@" ;;
  check_branch_alignment) cmd_check_branch_alignment "$@" ;;
  detect_orphan_experiment) cmd_detect_orphan_experiment "$@" ;;
  append_meta_archive_local) cmd_append_meta_archive_local "$@" ;;
  render_inherited_context) cmd_render_inherited_context "$@" ;;
  lineage_tree) cmd_lineage_tree "$@" ;;
  entropy_compute) cmd_entropy_compute "$@" ;;
  migrate_v2_weights) cmd_migrate_v2_weights "$@" ;;
  count_flagged_since_last_expansion) cmd_count_flagged_since_last_expansion "$@" ;;
  retry_budget_remaining) cmd_retry_budget_remaining "$@" ;;
  *) echo "session-helper: unknown subcommand '$SUBCMD'" >&2; exit 1 ;;
esac
