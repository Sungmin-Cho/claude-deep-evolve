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
  echo ""
  echo "v3.1.0 subcommands (Virtual Parallel N-seed):"
  echo "  resolve_helper_path                             — Print absolute path of session-helper.sh"
  echo "  create_seed_worktree, validate_seed_worktree, remove_seed_worktree"
  echo "  compute_init_budget_split, compute_grow_allocation"
  echo "  append_forum_event, tail_forum"
  echo "  append_journal_event                            — Append validated event to journal.jsonl (§ 6.5, § 9.2)"
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

# --- v3.1.0 helper path locator (C-4 fix: plugin-cache vs dev-repo) ---

# Resolves the absolute path of session-helper.sh itself. Coordinator exports
# the result as $DEEP_EVOLVE_HELPER_PATH and passes it into subagent prompts
# via the prose contract. This avoids brittle ${SESSION_ROOT}/../hooks/... math.
#
# Precedence:
#   1. DEEP_EVOLVE_HELPER_PATH env var (if set to a regular executable file)
#   2. realpath of the currently-running session-helper.sh (BASH_SOURCE)
#
# If the env var is set but invalid (directory, nonexistent, not executable),
# emit a stderr warning and fall through to realpath — stale exports are common
# in dev dogfooding sessions, so hard-failing is more disruptive than helpful.
#
# Usage: resolve_helper_path
cmd_resolve_helper_path() {
  if [ -n "${DEEP_EVOLVE_HELPER_PATH:-}" ] \
     && [ -f "$DEEP_EVOLVE_HELPER_PATH" ] \
     && [ -x "$DEEP_EVOLVE_HELPER_PATH" ]; then
    echo "$DEEP_EVOLVE_HELPER_PATH"
    return 0
  elif [ -n "${DEEP_EVOLVE_HELPER_PATH:-}" ]; then
    # Env var set but invalid (nonexistent / directory / not executable).
    # Emit warning to stderr, then fall through to realpath (don't fail hard —
    # stale exports are common in dev dogfooding sessions).
    echo "session-helper: DEEP_EVOLVE_HELPER_PATH=$DEEP_EVOLVE_HELPER_PATH invalid, falling back to realpath" >&2
  fi
  # Fallback: $BASH_SOURCE holds the script path we're currently running
  local self
  if command -v realpath >/dev/null 2>&1; then
    self=$(realpath "${BASH_SOURCE[0]}")
  else
    # macOS fallback: use python if realpath absent
    self=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "${BASH_SOURCE[0]}")
  fi
  echo "$self"
}

# --- v3.1.0 virtual_parallel worktree helpers (spec § 4.1, § 5.1 Step 4) ---

cmd_create_seed_worktree() {
  # T14-class silent-masking: under `set -Eeuo pipefail`, bare `local x="$1"`
  # aborts with "$1: unbound variable" before the usage guard runs, and the
  # EXIT trap's `|| true` masks the exit to rc=0. Use ${1:-} + explicit if-fi.
  local seed_id="${1:-}"
  if [ -z "$seed_id" ]; then
    echo "usage: create_seed_worktree <seed_id>" >&2
    return 2
  fi
  [ -z "$SESSION_ROOT" ] && { echo "SESSION_ROOT not set" >&2; return 2; }
  [ -z "$SESSION_ID" ]   && { echo "SESSION_ID not set" >&2; return 2; }

  local wt_parent="$SESSION_ROOT/worktrees"
  local wt_path="$wt_parent/seed_$seed_id"
  local branch="evolve/$SESSION_ID/seed-$seed_id"

  mkdir -p "$wt_parent"
  if [ -d "$wt_path" ]; then
    echo "create_seed_worktree: worktree already exists at $wt_path" >&2
    return 1
  fi
  # Create worktree + branch from current HEAD
  local err
  if ! err=$(git worktree add "$wt_path" -b "$branch" 2>&1 >/dev/null); then
    echo "create_seed_worktree: git worktree add failed for seed $seed_id: $err" >&2
    return 1
  fi
  printf '%s\t%s\t%s\n' "$seed_id" "$wt_path" "$branch"
}

# Post-dispatch validation per spec § 4.1: HEAD-is-descendant OR same-as-pre-dispatch,
# clean working tree (allow .deep-evolve/ untracked), no off-branch commits.
# Usage: validate_seed_worktree <seed_id> [<pre_dispatch_head_sha>]
cmd_validate_seed_worktree() {
  # C-1: ${VAR:-} survives `set -u` (nounset) — without defaults, a missing
  # optional pre_head would abort at "$2: unbound variable" before our usage
  # guard, and the EXIT trap's `|| true` would mask rc, returning 0 spuriously.
  local seed_id="${1:-}"
  local pre_head="${2:-}"     # optional; when provided, verify descendancy
  [ -z "$seed_id" ] && { echo "usage: validate_seed_worktree <seed_id> [pre_head]" >&2; return 2; }
  [ -z "$SESSION_ROOT" ] && { echo "SESSION_ROOT not set" >&2; return 2; }

  local wt_path="$SESSION_ROOT/worktrees/seed_$seed_id"
  local branch="evolve/$SESSION_ID/seed-$seed_id"
  [ -d "$wt_path" ] || { echo "validate: worktree missing at $wt_path" >&2; return 3; }

  # Branch must be checked out in this worktree
  local head_branch
  head_branch=$(git -C "$wt_path" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$head_branch" != "$branch" ]; then
    echo "validate: worktree checked out $head_branch, expected $branch" >&2
    return 4
  fi

  # Working tree clean except tool-scratch dirs
  # (.deep-evolve/ from this framework; .deep-docs/, .deep-review/, .serena/
  #  from co-installed plugins that legitimately write to untracked paths)
  local dirty
  dirty=$(git -C "$wt_path" status --porcelain \
    | grep -Ev '^\?\? \.(deep-evolve|deep-docs|deep-review|serena)/' || true)
  if [ -n "$dirty" ]; then
    echo "validate: worktree not clean: $dirty" >&2
    return 5
  fi

  # If pre-head provided, current HEAD must be pre-head OR descendant
  if [ -n "$pre_head" ]; then
    local cur_head
    cur_head=$(git -C "$wt_path" rev-parse HEAD)
    if [ "$cur_head" != "$pre_head" ]; then
      if ! git -C "$wt_path" merge-base --is-ancestor "$pre_head" "$cur_head" 2>/dev/null; then
        echo "validate: current HEAD ($cur_head) is not descendant of pre-dispatch HEAD ($pre_head)" >&2
        return 6
      fi
    fi
  fi
  echo "clean"
  return 0
}

cmd_remove_seed_worktree() {
  # T14-class silent-masking: see cmd_create_seed_worktree for rationale.
  local seed_id="${1:-}"
  if [ -z "$seed_id" ]; then
    echo "usage: remove_seed_worktree <seed_id>" >&2
    return 2
  fi
  [ -z "$SESSION_ROOT" ] && { echo "SESSION_ROOT not set" >&2; return 2; }
  local wt_path="$SESSION_ROOT/worktrees/seed_$seed_id"
  [ -d "$wt_path" ] || return 0
  local err
  git worktree remove --force "$wt_path" 2>/dev/null || {
    err=$(rm -rf "$wt_path" 2>&1) || echo "remove_seed_worktree: fallback rm failed: $err" >&2
  }
}

# --- v3.1.0 budget allocation helpers (spec § 5.1, § 15.1 Q6) ---

# Split total budget across N seeds as evenly as possible.
# Any remainder goes to the LAST seed(s) deterministically.
# Rejects when each seed would receive fewer than P3 floor experiments (3).
# Usage: compute_init_budget_split <total> <N>
cmd_compute_init_budget_split() {
  # C-1: ${VAR:-} survives `set -u` (nounset); without defaults, missing args
  # would abort at rc=1 via "unbound variable" BEFORE our -z check fires,
  # masking operator errors as the documented rc=1 "insufficient" signal.
  local total="${1:-}" n="${2:-}"
  local P3_FLOOR=3
  # I-3: explicit if-fi instead of compound `||`/`&&` (precedence foot-gun)
  if [ -z "$total" ] || [ -z "$n" ]; then
    echo "usage: compute_init_budget_split <total> <N>" >&2
    return 2
  fi
  # C-2: numeric-positive guards return rc=2 (operator error) to keep rc=1
  # reserved for the "insufficient pool" business signal the scheduler relies on.
  if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -le 0 ]; then
    echo "compute_init_budget_split: N must be a positive integer, got: $n" >&2
    return 2
  fi
  if ! [[ "$total" =~ ^[0-9]+$ ]]; then
    echo "compute_init_budget_split: total must be a non-negative integer, got: $total" >&2
    return 2
  fi
  # S-6: reject when the smallest resulting allocation would fall below P3 floor,
  # otherwise coordinator would create un-killable, un-useful seeds.
  local min_per_seed=$(( total / n ))
  if [ "$min_per_seed" -lt "$P3_FLOOR" ]; then
    echo "insufficient: each seed would get $min_per_seed experiments (below P3 floor $P3_FLOOR); require total >= N*$P3_FLOOR" >&2
    return 1
  fi
  local base=$(( total / n ))
  local rem=$(( total - base * n ))
  local out=""
  local i
  for i in $(seq 1 "$n"); do
    if [ "$i" -le $(( n - rem )) ]; then
      out+="$base "
    else
      out+="$(( base + 1 )) "
    fi
  done
  printf '%s' "$out" | sed 's/[[:space:]]*$//'
}

# Compute allocation for a new seed created via n_adjusted growth.
# Formula: ceil(pool / (2 * current_N)), then max against P3 floor (3).
# If pool < P3_floor, reject (caller must kill before grow).
# Usage: compute_grow_allocation <pool> <current_N>
cmd_compute_grow_allocation() {
  # C-1: ${VAR:-} survives `set -u` (nounset) — see compute_init_budget_split.
  local pool="${1:-}" curN="${2:-}"
  local P3_FLOOR=3
  # I-3: explicit if-fi instead of compound `||`/`&&`
  if [ -z "$pool" ] || [ -z "$curN" ]; then
    echo "usage: compute_grow_allocation <pool> <current_N>" >&2
    return 2
  fi
  # C-2: numeric-positive guards — reserve rc=1 for "insufficient pool" signal.
  if ! [[ "$curN" =~ ^[0-9]+$ ]] || [ "$curN" -le 0 ]; then
    echo "compute_grow_allocation: current_N must be a positive integer, got: $curN" >&2
    return 2
  fi
  if ! [[ "$pool" =~ ^[0-9]+$ ]]; then
    echo "compute_grow_allocation: pool must be a non-negative integer, got: $pool" >&2
    return 2
  fi
  # ceil(pool / (2*curN)) = (pool + 2*curN - 1) / (2*curN)   (integer div truncates)
  local denom=$(( 2 * curN ))
  local tentative=$(( (pool + denom - 1) / denom ))
  [ "$tentative" -lt 1 ] && tentative=1
  local alloc=$tentative
  [ "$alloc" -lt "$P3_FLOOR" ] && alloc=$P3_FLOOR
  if [ "$pool" -lt "$P3_FLOOR" ]; then
    echo "insufficient: pool=$pool < P3_floor=$P3_FLOOR; scheduler must kill before grow" >&2
    return 1
  fi
  if [ "$pool" -lt "$alloc" ]; then
    echo "insufficient: pool=$pool < alloc=$alloc; scheduler must kill before grow" >&2
    return 1
  fi
  echo "$alloc"
}

# --- v3.1.0 forum.jsonl helpers (spec § 7.1, § 7.2) ---

# Append one event to $SESSION_ROOT/forum.jsonl atomically.
# Validates JSON, injects `ts` field, serializes via acquire_project_lock.
# Usage: append_forum_event <json_string>
cmd_append_forum_event() {
  local json="${1:-}"
  if [ -z "$json" ]; then
    echo "usage: append_forum_event <json>" >&2
    return 2
  fi
  if [ -z "${SESSION_ROOT:-}" ]; then
    echo "SESSION_ROOT not set" >&2
    return 2
  fi

  # Validate JSON
  if ! echo "$json" | jq -e . >/dev/null 2>&1; then
    echo "append_forum_event: invalid JSON" >&2
    return 1
  fi
  # Inject ts field if absent
  local ts
  ts=$(iso_now)
  local enriched
  enriched=$(echo "$json" | jq -c --arg ts "$ts" 'if has("ts") then . else . + {ts:$ts} end')

  local forum="$SESSION_ROOT/forum.jsonl"
  acquire_project_lock || { echo "append_forum_event: lock failed" >&2; return 3; }
  # printf '%s\n' is safe against escape-interpretation (\n/\t/\0 in JSON strings);
  # echo can corrupt when xpg_echo is set. See review W-5.
  printf '%s\n' "$enriched" >> "$forum"
  release_project_lock
  return 0
}

# Read last N lines from forum.jsonl (for subagent consumption).
# Usage: tail_forum <N>
cmd_tail_forum() {
  local n="${1:-20}"
  if [ -z "${SESSION_ROOT:-}" ]; then
    echo "SESSION_ROOT not set" >&2
    return 2
  fi
  local forum="$SESSION_ROOT/forum.jsonl"
  [ -f "$forum" ] || return 0   # empty forum is valid
  tail -n "$n" "$forum"
}

# --- v3.1.0 journal event helper (spec § 6.5, § 9.2) ---

# Append one event to $SESSION_ROOT/journal.jsonl atomically.
# Validates JSON, injects `ts` and `session_id` fields, serializes via acquire_project_lock.
# Usage: append_journal_event <json_string>
cmd_append_journal_event() {
  local json="${1:-}"
  if [ -z "$json" ]; then
    echo "usage: append_journal_event <json>" >&2
    return 2
  fi
  if [ -z "${SESSION_ROOT:-}" ]; then
    echo "SESSION_ROOT not set" >&2
    return 2
  fi
  if [ -z "${SESSION_ID:-}" ]; then
    echo "SESSION_ID not set" >&2
    return 2
  fi

  # Validate JSON
  if ! echo "$json" | jq -e . >/dev/null 2>&1; then
    echo "append_journal_event: invalid JSON" >&2
    return 1
  fi

  # Inject ts + session_id if absent
  local ts
  ts=$(iso_now)
  local enriched
  if [ -n "${SEED_ID:-}" ]; then
    # v3.1 Gap 4 closure: when SEED_ID is exported by the dispatching
    # subagent (inner-loop.md Step 0.5), auto-inject it as seed_id —
    # overriding any seed_id in the payload (RHS wins in jq's object +).
    # SEED_ID is a numeric string; jq's tonumber coerces to JSON number.
    enriched=$(echo "$json" | jq -c \
      --arg ts "$ts" --arg sid "$SESSION_ID" --arg seed "${SEED_ID}" \
      'if has("ts") then . else . + {ts:$ts} end
       | if has("session_id") then . else . + {session_id:$sid} end
       | . + {seed_id: ($seed|tonumber)}')
  else
    # v3.0 / v2 backward-compat path — no seed_id injection
    enriched=$(echo "$json" | jq -c --arg ts "$ts" --arg sid "$SESSION_ID" \
      'if has("ts") then . else . + {ts:$ts} end
       | if has("session_id") then . else . + {session_id:$sid} end')
  fi

  local journal="$SESSION_ROOT/journal.jsonl"
  acquire_project_lock || { echo "append_journal_event: lock failed" >&2; return 3; }
  # printf '%s\n' is safe against escape-interpretation (\n/\t/\0 in JSON strings);
  # echo can corrupt when xpg_echo is set. See review W-5.
  printf '%s\n' "$enriched" >> "$journal"
  release_project_lock
  return 0
}

# --- v3.1.0 kill queue helpers (spec § 5.5 W-9 kill atomicity) ---
#
# kill_queue.jsonl captures scheduler-decided kills that cannot fire
# immediately because the target seed has an in-flight block (per T18's
# in_flight_block synthesis). Entries are drained when the block
# completes, at which point the kill applies and a seed_killed journal
# event is emitted with queued_at + applied_at timestamps + final_q +
# experiments_used (spec § 9.2 key fields for downstream synthesis
# baseline-select cascade).

# Whitelist of spec § 5.5 condition strings. Callers MUST supply one of
# these verbatim — a typo'd condition would otherwise pollute seed_killed
# events and downstream consumers (synthesis, --status view, meta-archive).
_KILL_CONDITION_WHITELIST="crash_give_up sustained_regression shortcut_quarantine budget_exhausted_underperform user_requested"

# Append one entry to $SESSION_ROOT/kill_queue.jsonl.
# Usage: append_kill_queue_entry <seed_id> <condition> <final_q> <experiments_used>
#   final_q: numeric (may be fractional); downstream synthesis
#     baseline-select cascade reads this to distinguish killed-at-high-Q
#     from killed-at-zero-Q.
#   experiments_used: non-negative integer; meta-archive aggregation.
cmd_append_kill_queue_entry() {
  local seed_id="${1:-}"
  local condition="${2:-}"
  local final_q="${3:-}"
  local experiments_used="${4:-}"

  if [ -z "$seed_id" ] || [ -z "$condition" ] \
      || [ -z "$final_q" ] || [ -z "$experiments_used" ]; then
    echo "usage: append_kill_queue_entry <seed_id> <condition> <final_q> <experiments_used>" >&2
    return 2
  fi
  if [ -z "${SESSION_ROOT:-}" ]; then
    echo "append_kill_queue_entry: SESSION_ROOT not set" >&2
    return 2
  fi

  # Seed ID validation — positive integer, no leading zeros (W-5)
  if ! [[ "$seed_id" =~ ^[1-9][0-9]*$ ]]; then
    echo "append_kill_queue_entry: seed_id must be a positive integer with no leading zeros, got: $seed_id" >&2
    return 2
  fi

  # Condition whitelist (I-5 — prevent typo'd condition strings)
  local found=0
  for allowed in $_KILL_CONDITION_WHITELIST; do
    if [ "$condition" = "$allowed" ]; then
      found=1
      break
    fi
  done
  if [ "$found" -eq 0 ]; then
    echo "append_kill_queue_entry: condition must be one of: $_KILL_CONDITION_WHITELIST. Got: $condition" >&2
    return 2
  fi

  # final_q: numeric (may be negative, may be fractional)
  if ! [[ "$final_q" =~ ^-?[0-9]+(\.[0-9]+)?$ ]]; then
    echo "append_kill_queue_entry: final_q must be numeric, got: $final_q" >&2
    return 2
  fi
  # experiments_used: non-negative integer
  if ! [[ "$experiments_used" =~ ^[0-9]+$ ]]; then
    echo "append_kill_queue_entry: experiments_used must be non-negative integer, got: $experiments_used" >&2
    return 2
  fi

  local queue="$SESSION_ROOT/kill_queue.jsonl"
  local ts
  ts="$(iso_now)"

  local line
  if ! line="$(jq -cn --argjson sid "$seed_id" --arg cond "$condition" \
      --argjson fq "$final_q" --argjson eu "$experiments_used" \
      --arg ts "$ts" \
      '{seed_id: $sid, condition: $cond, final_q: $fq, experiments_used: $eu, queued_at: $ts}')"; then
    echo "append_kill_queue_entry: jq failed to build entry" >&2
    return 2
  fi

  acquire_project_lock || {
    echo "append_kill_queue_entry: lock failed" >&2
    return 3
  }
  # printf '%s\n' is safe vs xpg_echo reinterpretation (W-5).
  # rc-guard the write: disk-full / permission failures must surface
  # as rc=2 + stderr message rather than silently aborting under
  # set -Eeuo pipefail (aff23c9 contract — no silent masking).
  if ! printf '%s\n' "$line" >> "$queue"; then
    echo "append_kill_queue_entry: write to $queue failed" >&2
    release_project_lock
    return 2
  fi
  release_project_lock
  return 0
}

# Drain any queued kills for a seed whose block just completed.
# Usage: drain_kill_queue <completed_seed_id>
#
# Atomicity design (C-1/W-9 fix — snapshot-then-process):
#   Phase 1: acquire lock, cp $queue → $snapshot, release lock.
#   Phase 2: process $snapshot WITHOUT lock — emit seed_killed for
#            matches (each cmd_append_journal_event acquires its own
#            short-lived lock), accumulate survivors.
#   Phase 3: re-acquire lock; compute set-difference of current $queue
#            vs $snapshot to find concurrent appends that landed during
#            Phase 2; merge them into survivors; mv survivors → $queue.
#
# This bounds lock-hold time to the snapshot copy + the merge step
# rather than the O(N · jq-startup-time) parse loop, and guarantees
# concurrent appends during the unlocked Phase 2 are not lost.
#
# For each matching entry in kill_queue.jsonl, emits a seed_killed
# journal event with queued_at + applied_at + final_q + experiments_used
# (spec § 9.2 key fields). Malformed lines are PRESERVED in the
# survivors partition (dead-letter) for operator inspection — never
# silently deleted (C-3). The journal append runs inside
# `(unset SEED_ID; cmd_append_journal_event "$event")` subshell so the
# coordinator's ambient SEED_ID does not override the queued seed_id
# (T16 auto-inject prevention).
cmd_drain_kill_queue() {
  local completed_seed_id="${1:-}"

  if [ -z "$completed_seed_id" ]; then
    echo "usage: drain_kill_queue <completed_seed_id>" >&2
    return 2
  fi
  if [ -z "${SESSION_ROOT:-}" ]; then
    echo "drain_kill_queue: SESSION_ROOT not set" >&2
    return 2
  fi
  # W-2: SESSION_ID required by downstream cmd_append_journal_event;
  # fail fast here rather than letting the inner call fail and hit the
  # preserve-queue-entry branch.
  if [ -z "${SESSION_ID:-}" ]; then
    echo "drain_kill_queue: SESSION_ID not set (required for journal append)" >&2
    return 2
  fi
  # Positive integer, no leading zeros (mirrors W-5 in append)
  if ! [[ "$completed_seed_id" =~ ^[1-9][0-9]*$ ]]; then
    echo "drain_kill_queue: completed_seed_id must be a positive integer with no leading zeros, got: $completed_seed_id" >&2
    return 2
  fi

  local queue="$SESSION_ROOT/kill_queue.jsonl"
  # Missing or empty file → nothing to drain (no-op success)
  if [ ! -f "$queue" ] || [ ! -s "$queue" ]; then
    return 0
  fi

  # ---- Phase 1: snapshot under lock ----
  local snapshot="$queue.snap.$$"
  acquire_project_lock || {
    echo "drain_kill_queue: lock failed (snapshot phase)" >&2
    return 3
  }
  if ! cp "$queue" "$snapshot"; then
    # cp may leave a partial $snapshot on failure — clean up orphan.
    rm -f "$snapshot"
    release_project_lock
    echo "drain_kill_queue: failed to snapshot queue" >&2
    return 2
  fi
  release_project_lock

  # ---- Phase 2: process snapshot WITHOUT lock ----
  local survivors="$queue.survivors.$$"
  : > "$survivors"
  local applied_ts
  applied_ts="$(iso_now)"
  local matches_count=0
  local emit_failed_count=0

  while IFS= read -r raw_line || [ -n "$raw_line" ]; do
    # Skip blank lines silently
    [ -z "$raw_line" ] && continue

    local entry_seed
    if ! entry_seed="$(printf '%s' "$raw_line" \
        | jq -r '.seed_id // empty' 2>/dev/null)"; then
      # C-3: preserve malformed line (dead-letter). Never silently drop.
      echo "drain_kill_queue: malformed queue line preserved for inspection: $raw_line" >&2
      printf '%s\n' "$raw_line" >> "$survivors"
      continue
    fi
    if [ -z "$entry_seed" ]; then
      echo "drain_kill_queue: line without seed_id preserved: $raw_line" >&2
      printf '%s\n' "$raw_line" >> "$survivors"
      continue
    fi

    if [ "$entry_seed" = "$completed_seed_id" ]; then
      # Match: extract fields + emit seed_killed.
      # Consolidated into ONE rc-guarded jq call (vs 4 bare assignments)
      # so a jq crash/OOM falls through to the dead-letter path rather
      # than aborting the function under set -Eeuo pipefail (T20 rc-guard
      # contract + C-3 dead-letter invariant). Also reduces jq process
      # count by 3 per match (small perf win).
      local extracted
      if ! extracted="$(printf '%s' "$raw_line" | jq -r \
          '[.condition // "unknown",
            .queued_at // "",
            (.final_q // 0 | tostring),
            (.experiments_used // 0 | tostring)] | join("\t")')"; then
        echo "drain_kill_queue: field extraction failed for seed $entry_seed — preserving entry" >&2
        printf '%s\n' "$raw_line" >> "$survivors"
        emit_failed_count=$((emit_failed_count + 1))
        continue
      fi
      local cond queued_at final_q experiments_used
      IFS=$'\t' read -r cond queued_at final_q experiments_used <<< "$extracted"

      local killed_event
      if ! killed_event="$(jq -cn \
          --argjson sid "$entry_seed" \
          --arg cond "$cond" \
          --argjson fq "$final_q" \
          --argjson eu "$experiments_used" \
          --arg q_at "$queued_at" \
          --arg a_at "$applied_ts" \
          '{event: "seed_killed",
            seed_id: $sid,
            condition: $cond,
            final_q: $fq,
            experiments_used: $eu,
            queued_at: $q_at,
            applied_at: $a_at,
            reasoning: ("queued kill drained at block completion: " + $cond)}')"; then
        echo "drain_kill_queue: jq failed to build seed_killed event for seed $entry_seed — preserving entry" >&2
        printf '%s\n' "$raw_line" >> "$survivors"
        emit_failed_count=$((emit_failed_count + 1))
        continue
      fi

      # (unset SEED_ID; ...) subshell: only the append call is wrapped;
      # surrounding lock/state stays in the parent shell (I-4). The
      # append helper takes its own lock, so we are NOT holding our
      # project lock here (Phase 2 is unlocked by design).
      local rc=0
      (unset SEED_ID; cmd_append_journal_event "$killed_event") || rc=$?
      if [ "$rc" -ne 0 ]; then
        echo "drain_kill_queue: append_journal_event failed (rc=$rc) — preserving entry" >&2
        printf '%s\n' "$raw_line" >> "$survivors"
        emit_failed_count=$((emit_failed_count + 1))
        continue
      fi
      matches_count=$((matches_count + 1))
    else
      # Non-match: preserve in survivors
      printf '%s\n' "$raw_line" >> "$survivors"
    fi
  done < "$snapshot"

  # ---- Phase 3: merge concurrent appends under lock, then replace ----
  # During Phase 2, concurrent cmd_append_kill_queue_entry calls may
  # have appended new lines to $queue. Detect them by set-difference
  # of current $queue vs $snapshot (entire lines as opaque tokens),
  # append to survivors before atomic replace.
  acquire_project_lock || {
    echo "drain_kill_queue: lock failed (merge phase)" >&2
    rm -f "$snapshot" "$survivors"
    return 3
  }

  if [ -f "$queue" ]; then
    # awk preserves order; NR==FNR builds a seen-set from $snapshot,
    # then emits only lines in $queue not in $snapshot.
    if ! awk 'NR==FNR{seen[$0]=1; next} !seen[$0]' "$snapshot" "$queue" >> "$survivors"; then
      echo "drain_kill_queue: failed to compute concurrent-append delta" >&2
      release_project_lock
      rm -f "$snapshot" "$survivors"
      return 2
    fi
  fi

  if ! mv "$survivors" "$queue"; then
    echo "drain_kill_queue: failed to replace queue with survivors" >&2
    release_project_lock
    rm -f "$snapshot" "$survivors"
    return 2
  fi
  rm -f "$snapshot"
  release_project_lock

  # Diagnostic: how many drained + how many emit-failures remain queued.
  # W-7: use jq + printf for JSON emit (never echo manually-built JSON —
  # xpg_echo may re-interpret `\"` escapes).
  local diag
  if ! diag="$(jq -cn --argjson n "$matches_count" \
      --argjson sid "$completed_seed_id" \
      --argjson failed "$emit_failed_count" \
      '{drained: $n, seed_id: $sid, emit_failed: $failed}')"; then
    diag="{\"drained\":$matches_count,\"seed_id\":$completed_seed_id,\"emit_failed\":$emit_failed_count}"
  fi
  printf '%s\n' "$diag"
  return 0
}

# === END of helper function definitions ===

# If sourced (not executed), skip ALL execution-time side effects:
# global flag parsing, PROJECT_ROOT computation, and subcommand dispatch.
# Sourcing scripts (kill-request-writer.sh, future G11 helpers) get only
# the function bodies — they're responsible for setting their own
# PROJECT_ROOT and parsing their own flags.
if [ -n "${HELPER_SOURCED:-}" ]; then
  return 0 2>/dev/null || true
fi

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
  resolve_helper_path) cmd_resolve_helper_path "$@" ;;
  create_seed_worktree)   cmd_create_seed_worktree "$@" ;;
  validate_seed_worktree) cmd_validate_seed_worktree "$@" ;;
  remove_seed_worktree)   cmd_remove_seed_worktree "$@" ;;
  compute_init_budget_split)  cmd_compute_init_budget_split "$@" ;;
  compute_grow_allocation)    cmd_compute_grow_allocation "$@" ;;
  append_forum_event)    cmd_append_forum_event "$@" ;;
  tail_forum)            cmd_tail_forum "$@" ;;
  append_journal_event)  cmd_append_journal_event "$@" ;;
  append_kill_queue_entry)  cmd_append_kill_queue_entry "$@" ;;
  drain_kill_queue)         cmd_drain_kill_queue "$@" ;;
  *) echo "session-helper: unknown subcommand '$SUBCMD'" >&2; exit 1 ;;
esac
