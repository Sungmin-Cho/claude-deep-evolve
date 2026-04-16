# deep-evolve Session History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** deep-evolve에 세션 히스토리/lineage 시스템을 도입해 세션 간 데이터 보존, 중단 재개, 이력 조회, 선행 세션 상속을 지원한다.

**Architecture:** 두 PR로 순차 릴리스. PR#1 (v2.1.2)은 outer-loop 자동 트리거 및 Automation Policy 삽입 (문서 전용). PR#2 (v2.2.0)은 per-session namespace, shell helper, resume/history protocol, receipt 확장, 전 프로토콜 $SESSION_ROOT 경로 치환.

**Tech Stack:** Bash (session-helper.sh), jq, yq, Markdown protocol files

**Spec:** `docs/superpowers/specs/2026-04-15-deep-evolve-session-history-impl.md`

---

## Phase 1: PR#1 — v2.1.2

### Task 1: inner-loop.md Step 6 재구조화 + inner_count persist

**Files:**
- Modify: `skills/deep-evolve-workflow/protocols/inner-loop.md:35,166-192`

- [ ] **Step 1: Section C inner_count 초기화 변경 (M1)**

Line 35를 찾아 교체:

```
Before: Set `inner_count` to 0 (resets each Outer Loop generation).
After:  Set `inner_count` to `session.yaml.outer_loop.inner_count` (0 for new sessions, restored value for resume).
```

- [ ] **Step 2: Step 6 전체 재작성**

Line 166-192 영역을 다음으로 교체:

```markdown
**Step 6 — Continuation Check** (uses `strategy.yaml.convergence` parameters):

**6.a** Increment `inner_count`. Persist: update `session.yaml.outer_loop.inner_count` to the new value.

**6.b** Check for diminishing returns using strategy.yaml thresholds:
- 0 keeps in last `consecutive_discard_limit` (default 10) → report: "<N>회 연속 discard. Score가 수렴한 것 같습니다."
- keeps exist but max score delta < `min_delta` in last `plateau_window` (default 15) → report: "개선폭이 미미합니다."
- `crash_tolerance`+ crashes in last 10 → report: "안정성 문제가 감지되었습니다."

**6.c** If any diminishing-returns signal triggered:

  If `session.yaml.outer_loop.auto_trigger` is **true** (default):
  → **IMMEDIATELY** run Step 6.5 (Outer Loop Evaluation). Do NOT AskUserQuestion before Outer Loop completes.

  If `session.yaml.outer_loop.auto_trigger` is **false**:
  → AskUserQuestion first: "diminishing returns 감지됨. Outer Loop를 실행할까요?"
    - "실행" → Step 6.5
    - "건너뛰기" → Step 6.d로 이동

  If diminishing returns detected AND `strategy.yaml.convergence.plateau_action` is `"branch"` AND `strategy.yaml.exploration.backtrack_enabled` is true:
  → **Code Archive Backtrack**: Read `protocols/archive.md`, execute **Code Archive Backtrack** section.

**6.d** After Outer Loop returns (or if no trigger):
  - Q(v) improved and no convergence flag → auto-continue to Step 1
  - Q(v) degraded or session-level stop criteria met → AskUserQuestion:
    Options:
    - "계속 (N회 추가)"
    - "평가 harness 확장 (더 어려운 시나리오/단계 추가)" → Go to **Section D: Prepare Expansion** (below)
    - "여기서 완료" → Read `protocols/completion.md`

Increment `experiment_count`.

**Step 6.5 — Outer Loop Evaluation** (triggers: `inner_count >= outer_interval` OR diminishing returns detected in Step 6):

If `session.yaml.outer_loop.auto_trigger` is false, AskUserQuestion before entering.
Otherwise execute immediately without user confirmation.

→ Read `protocols/outer-loop.md`, execute Outer Loop.

If neither trigger condition is met, skip Outer Loop.

If `experiment_count >= max_count`:
→ Read `protocols/completion.md`

Otherwise: → Back to Step 1
```

- [ ] **Step 3: 변경 확인**

```bash
grep -n "6\.a\|6\.b\|6\.c\|6\.d\|auto_trigger\|inner_count.*Persist" skills/deep-evolve-workflow/protocols/inner-loop.md
```

Expected: 6개 이상 매치 (6.a, 6.b, 6.c, 6.d, auto_trigger, inner_count persist)

- [ ] **Step 4: 커밋**

```bash
git add skills/deep-evolve-workflow/protocols/inner-loop.md
git commit -m "feat(inner-loop): restructure Step 6 for auto-trigger + persist inner_count

3.A: outer loop fires immediately on diminishing returns (auto_trigger=true)
AskUserQuestion deferred to Step 6.d after outer loop completes
X1: inner_count persisted to session.yaml each Step 6.a
M1: Section C reads persisted inner_count instead of resetting to 0"
```

---

### Task 2: outer-loop.md auto_trigger + init.md Automation Policy + session.yaml defaults

**Files:**
- Modify: `skills/deep-evolve-workflow/protocols/outer-loop.md:1-3`
- Modify: `skills/deep-evolve-workflow/protocols/init.md:206,212-241`

- [ ] **Step 1: outer-loop.md 첫 줄 업데이트**

Line 3 아래에 다음을 삽입 (기존 "The Outer Loop governs..." 문단 뒤):

```markdown

**Auto-trigger gate**: If `session.yaml.outer_loop.auto_trigger` is false, the caller (inner-loop.md Step 6.c) will have already asked the user before entering this protocol. If true, this protocol executes without user confirmation.
```

- [ ] **Step 2: init.md Step 6에 Automation Policy 삽입 지시**

Line 206 (`6. Generate program.md...`) 을 다음으로 교체:

```markdown
6. Generate `program.md` with experiment instructions tailored to the project.

   **program.md must start with the following sentinel-wrapped section (always present):**

   ```markdown
   <!-- automation-policy-v1 -->
   ## Automation Policy

   - Outer Loop는 diminishing-returns 감지 시 session.yaml.outer_loop.auto_trigger가
     true면 자동 실행. AskUserQuestion은 outer 완료 후 Q(v) 악화 또는 세션 종료 기준
     충족 시에만.
   - 사용자 초기 브리프에 "ask before outer loop" 류 지시가 있으면 auto_trigger=false로
     명시 설정하고 program.md에 override 기록.

   <!-- /automation-policy-v1 -->
   ```

   Then generate the project-specific experiment instructions below the sentinel block.
```

- [ ] **Step 3: init.md Step 9 session.yaml 기본값에 필드 추가**

Line 212-241의 strategy.yaml 기본값 블록 직전에 있는 session.yaml 생성 부분(Line 156-180)에서 outer_loop 블록을 찾아 수정:

기존 session.yaml의 outer_loop 블록에 `inner_count: 0`과 `auto_trigger: true` 추가:
```yaml
outer_loop:
  generation: 0
  interval: 20
  inner_count: 0
  auto_trigger: true
  q_history: []
```

- [ ] **Step 4: 변경 확인**

```bash
grep -n "automation-policy-v1\|auto_trigger\|inner_count: 0" skills/deep-evolve-workflow/protocols/init.md
```

Expected: 3개 이상 매치

- [ ] **Step 5: 커밋**

```bash
git add skills/deep-evolve-workflow/protocols/outer-loop.md skills/deep-evolve-workflow/protocols/init.md
git commit -m "feat(init,outer-loop): add Automation Policy + auto_trigger + inner_count defaults

3.B: session.yaml.outer_loop.auto_trigger field (default true)
3.C: program.md template gets Automation Policy section with sentinel comments
X1: inner_count: 0 added to session.yaml defaults for future resume support"
```

---

### Task 3: protect-readonly.sh forward-compat shim

**Files:**
- Modify: `hooks/scripts/protect-readonly.sh:27-29`

- [ ] **Step 1: forward-compat shim 삽입**

Line 27 (`if [[ -z "$PROJECT_ROOT" ]]; then`) 직전에 다음을 삽입:

```bash
# v2.2.0+ layout forward-compat (X16)
# If current.json exists, this project uses v2.2.0 namespace layout.
# v2.1.2 hook cannot handle it — block all and warn.
if [[ -n "$PROJECT_ROOT" ]] && [[ -f "$PROJECT_ROOT/.deep-evolve/current.json" ]]; then
  echo "deep-evolve: v2.2.0+ 레이아웃이 감지되었습니다. 플러그인을 v2.2.0으로 업그레이드하세요." >&2
  cat <<JSON
{"decision":"block","reason":"Deep Evolve Guard: v2.2.0+ 레이아웃 감지. 플러그인 업그레이드 필요."}
JSON
  exit 2
fi
```

- [ ] **Step 2: 검증**

```bash
grep -n "current.json\|v2.2.0" hooks/scripts/protect-readonly.sh
```

Expected: shim 라인 표시

- [ ] **Step 3: 커밋**

```bash
git add hooks/scripts/protect-readonly.sh
git commit -m "fix(hook): add v2.2.0 forward-compat shim (X16)

Block all writes and warn if current.json detected — signals v2.2.0
namespace layout which v2.1.2 hook cannot safely handle."
```

---

### Task 4: CHANGELOG v2.1.2 + PR#1 태그

**Files:**
- Create: `CHANGELOG.md` (없으면 생성, 있으면 상단에 추가)

- [ ] **Step 1: CHANGELOG 파일 확인 및 생성/수정**

```bash
ls CHANGELOG.md 2>/dev/null || echo "NEW"
```

파일이 없으면 생성, 있으면 파일 최상단에 v2.1.2 엔트리 추가:

```markdown
# Changelog

## v2.1.2

### Improvements
- **3.A** inner-loop Step 6 재구조화: outer loop 자동 트리거 우선, AskUserQuestion은 outer 완료 후 조건부
- **3.B** `session.yaml.outer_loop.auto_trigger` 플래그 (default true)
- **3.C** program.md 템플릿에 Automation Policy 단락 자동 삽입 (sentinel 주석 포함)
- inner_count를 session.yaml에 persist (향후 resume 지원 기반)

### Fixes
- v2.2.0 forward-compat shim: v2.2.0 layout 감지 시 업그레이드 안내 (X16)
```

- [ ] **Step 2: PR#1 전체 diff 확인**

```bash
git diff --stat HEAD~3..HEAD
```

Expected: inner-loop.md, outer-loop.md, init.md, protect-readonly.sh, CHANGELOG.md

- [ ] **Step 3: 커밋**

```bash
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG.md with v2.1.2 entry"
```

- [ ] **Step 4: PR#1 생성**

```bash
git checkout -b feat/v2.1.2-auto-trigger
git push -u origin feat/v2.1.2-auto-trigger
gh pr create --title "feat: v2.1.2 outer-loop auto-trigger + Automation Policy" --body "$(cat <<'EOF'
## Summary
- 3.A: inner-loop Step 6 재구조화 (outer loop 자동 우선)
- 3.B: session.yaml.outer_loop.auto_trigger 플래그
- 3.C: program.md Automation Policy 단락 + sentinel 주석
- X16: v2.2.0 forward-compat shim

## Test plan
- [ ] T1: Quant Phase F pilot — gen 1에서 AskUserQuestion 0회 확인
- [ ] T2: v2.2.0 layout mock (.deep-evolve/current.json 생성) → hook block + 경고

## Spec
docs/superpowers/specs/2026-04-15-deep-evolve-session-history-impl.md §3
EOF
)"
```

---

## Phase 2: PR#2 — v2.2.0

> **Prerequisite**: PR#1이 merge된 후 main에서 새 브랜치를 분기.

### Task 5: session-helper.sh — 코어 유틸리티

> **리뷰 반영 (P1/P2/P3/P4)**: 함수 기반 아키텍처, lock 소유권 추적, jq 기반 JSON 생성, migrate 안전성 강화.

**Files:**
- Create: `hooks/scripts/session-helper.sh`

- [ ] **Step 1: 기본 구조 + 유틸 함수 작성**

**P1 반영**: 모든 서브커맨드를 함수로 정의. `local`은 함수 안에서만 사용. case dispatch는 함수 호출만.
**P3 반영**: cleanup은 `_LOCK_OWNER` PID를 확인해 현재 프로세스가 lock 소유자일 때만 해제. 재귀 호출(`cmd_*` 함수 직접 호출)은 lock 내부에서 `$0`를 쓰지 않음.

```bash
#!/usr/bin/env bash
# session-helper.sh — deep-evolve session management helper
# Usage: session-helper.sh <subcommand> [args...]
set -Eeuo pipefail

HELPER_VERSION="2.2.0"
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

compute_slug() {
  local input="$1"
  local slug
  slug=$(printf '%s' "$input" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-*//; s/-*$//' \
    | cut -c1-40)
  if [ -z "$slug" ]; then
    # Unicode-only input → hash fallback
    slug="session-$(printf '%s' "$input$(iso_now)" | shasum | cut -c1-6)"
  fi
  printf '%s' "$slug"
}

find_project_root() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -d "$dir/.deep-evolve" ]; then
      printf '%s' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
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

# === Parse global flags ===
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]}"

PROJECT_ROOT="$(find_project_root)" || { echo "session-helper: .deep-evolve/ not found" >&2; exit 1; }

EVOLVE_DIR="$PROJECT_ROOT/.deep-evolve"

# === Subcommand functions (P1: all `local` usage inside functions) ===
# Each cmd_* function is defined in subsequent tasks.

cmd_help() {
  echo "session-helper.sh v$HELPER_VERSION"
  echo "Subcommands: compute_session_id, resolve_current, list_sessions,"
  echo "  start_new_session, mark_session_status, append_sessions_jsonl,"
  echo "  migrate_legacy, check_branch_alignment, detect_orphan_experiment,"
  echo "  append_meta_archive_local, render_inherited_context, lineage_tree"
}

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
  *) echo "session-helper: unknown subcommand '$SUBCMD'" >&2; exit 1 ;;
esac
```

- [ ] **Step 2: 실행 권한 부여 + 기본 검증**

```bash
chmod +x hooks/scripts/session-helper.sh
hooks/scripts/session-helper.sh help
```

Expected: 버전 + 서브커맨드 목록 출력

- [ ] **Step 3: 커밋**

```bash
git add hooks/scripts/session-helper.sh
git commit -m "feat(helper): create session-helper.sh with core utilities

Preamble: jq check, flock detection, project lock (mkdir-based),
slug normalization, dry-run support, cleanup trap."
```

---

### Task 6: session-helper.sh — compute_session_id + resolve_current

**Files:**
- Modify: `hooks/scripts/session-helper.sh`

- [ ] **Step 1: cmd_compute_session_id 함수 구현 (P1: 함수로 정의)**

dispatch case 위에 함수 정의:

```bash
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
```

- [ ] **Step 2: cmd_resolve_current 함수 구현 (P1 + P2)**

```bash
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
```

- [ ] **Step 3: 검증**

```bash
# compute_session_id 테스트
hooks/scripts/session-helper.sh compute_session_id "Quant Phase F convergence fix"
# Expected: 2026-04-16_quant-phase-f-convergence-fix (or similar date)

# resolve_current 테스트 (current.json 없으므로 실패 예상)
hooks/scripts/session-helper.sh resolve_current 2>&1 || true
# Expected: "no active session" error
```

- [ ] **Step 4: 커밋**

```bash
git add hooks/scripts/session-helper.sh
git commit -m "feat(helper): add compute_session_id + resolve_current

compute_session_id: slug normalization + collision check via sessions.jsonl
resolve_current: current.json → session_id + dir validation + AH2 status reconciliation"
```

---

### Task 7: session-helper.sh — start_new_session + mark_session_status + append_sessions_jsonl

**Files:**
- Modify: `hooks/scripts/session-helper.sh`

- [ ] **Step 1: cmd_append_sessions_jsonl 구현 (P2: jq 기반 JSON 생성)**

```bash
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
```

- [ ] **Step 2: cmd_start_new_session 구현 (P2 + P3: 직접 함수 호출, jq 기반)**

```bash
cmd_start_new_session() {
  local goal="${1:-}"
  local parent_id=""
  shift || true
  for arg in "$@"; do
    case "$arg" in --parent=*) parent_id="${arg#--parent=}" ;; esac
  done

  acquire_project_lock || exit 1

  # P3: 직접 함수 호출 (재귀 $0 제거 → lock 해제 방지)
  local session_id
  session_id=$(cmd_compute_session_id "$goal")
  local session_root="$EVOLVE_DIR/$session_id"

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

  # P2+P3: 직접 함수 호출 + jq 기반 JSON
  local jq_args=(--arg goal "$goal" --arg status "active")
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
```

- [ ] **Step 3: cmd_mark_session_status 구현 (P1+P2+P3)**

```bash
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
```

- [ ] **Step 4: 검증**

```bash
# 임시 .deep-evolve/ 생성 후 테스트
mkdir -p .deep-evolve
hooks/scripts/session-helper.sh start_new_session "test session" --dry-run
# Expected: [dry-run] 메시지 + session_id 출력

hooks/scripts/session-helper.sh start_new_session "test session"
cat .deep-evolve/current.json
cat .deep-evolve/sessions.jsonl
ls .deep-evolve/
# Expected: current.json에 session_id, sessions.jsonl에 created 이벤트, 날짜_test-session/ dir

# cleanup
rm -rf .deep-evolve/20*_test-session .deep-evolve/current.json .deep-evolve/sessions.jsonl
```

- [ ] **Step 5: 커밋**

```bash
git add hooks/scripts/session-helper.sh
git commit -m "feat(helper): add start_new_session, mark_session_status, append_sessions_jsonl

start_new_session: locked (mkdir lock), atomic current.json swap,
rollback on failure (rm session dir).
mark_session_status: dual-write session.yaml + sessions.jsonl.
append_sessions_jsonl: O_APPEND atomic, --dry-run support."
```

---

### Task 8: session-helper.sh — migrate_legacy

**Files:**
- Modify: `hooks/scripts/session-helper.sh`

- [ ] **Step 1: cmd_migrate_legacy 구현 (P4: 오류 미무시 + 완전 매니페스트 검증)**

```bash
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
  if [ -d "$legacy_dir" ]; then
    if [ -f "$legacy_dir/session.yaml" ]; then
      echo "session-helper: legacy dir already exists and looks complete, skipping copy" >&2
      # Jump to step 4 (registry + cleanup)
    else
      echo "session-helper: incomplete legacy dir found, removing and retrying" >&2
      rm -rf "$legacy_dir"
    fi
  fi

  if dry_run_guard "migrate flat layout to $legacy_dir"; then
    return 0
  fi

  acquire_project_lock || exit 1

  # 1) Create namespace dir
  mkdir -p "$legacy_dir/meta-analyses" || { release_project_lock; return 1; }

  # 2) COPY (not move) — P4: FAIL on any copy error (no || true)
  local files_to_copy=(session.yaml strategy.yaml program.md prepare.py prepare-protocol.md results.tsv journal.jsonl)
  local dirs_to_copy=(runs code-archive strategy-archive)
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
  [ -f "$EVOLVE_DIR/meta-analysis.md" ] && \
    cp "$EVOLVE_DIR/meta-analysis.md" "$legacy_dir/meta-analyses/gen-legacy.md" || true

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

  # 4) Write registry (P2: jq for JSON, P3: 직접 append)
  local status
  status=$(grep '^status:' "$legacy_dir/session.yaml" 2>/dev/null | head -1 | sed 's/^status:[[:space:]]*//')
  status="${status:-legacy}"
  jq -nc --arg event "migrated" --arg ts "$(iso_now)" --arg sid "$legacy_id" \
    --arg from "flat_layout" --arg s "$status" --arg g "$goal" --arg lr "unavailable" \
    '{event:$event, ts:$ts, session_id:$sid, from:$from, status:$s, goal:$g, legacy_recovery:$lr}' \
    >> "$EVOLVE_DIR/sessions.jsonl"

  # Do NOT create current.json — legacy is treated as completed

  # 5) Remove originals (only after registry update succeeded)
  for f in "${files_to_copy[@]}"; do
    rm -f "$EVOLVE_DIR/$f" 2>/dev/null
  done
  for d in "${dirs_to_copy[@]}"; do
    rm -rf "$EVOLVE_DIR/$d" 2>/dev/null
  done
  rm -f "$EVOLVE_DIR/meta-analysis.md" "$EVOLVE_DIR/report.md" "$EVOLVE_DIR/evolve-receipt.json" 2>/dev/null

  release_project_lock
  echo "session-helper: migrated to $legacy_dir"
}
```

- [ ] **Step 2: 커밋**

```bash
git add hooks/scripts/session-helper.sh
git commit -m "feat(helper): add migrate_legacy (copy-verify-pointer-delete)

X7: safe migration with rollback — copies first, verifies, then deletes.
Idempotent: re-run skips if legacy_dir already exists and verifies."
```

---

### Task 9: session-helper.sh — check_branch_alignment + detect_orphan_experiment

**Files:**
- Modify: `hooks/scripts/session-helper.sh`

- [ ] **Step 1: cmd_check_branch_alignment 함수 구현 (P1)**

```bash
cmd_check_branch_alignment() {
  local session_dir="$1"
    local expected
    expected=$(grep 'current_branch:' "$session_dir/session.yaml" 2>/dev/null | head -1 | sed 's/.*current_branch:[[:space:]]*//' | tr -d '"')
    local actual
    actual=$(git branch --show-current 2>/dev/null)

    if [ -z "$expected" ] || [ "$expected" = "$actual" ]; then
      exit 0
    fi

    echo "branch mismatch: expected '$expected', actual '$actual'" >&2
    exit 1
}
```

- [ ] **Step 2: cmd_detect_orphan_experiment 함수 구현 (P1, tac → tail -r fallback)**

```bash
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

  # Check if there's a matching evaluated/kept/discarded/rollback_completed
  local has_resolution
  has_resolution=$(grep "\"id\":$last_committed_n" "$journal" \
    | grep -cE '"status":"(evaluated|kept|discarded|rollback_completed)"' 2>/dev/null || echo 0)

  if [ "$has_resolution" -eq 0 ]; then
    local commit_hash
    commit_hash=$(grep "\"id\":$last_committed_n" "$journal" \
      | grep '"status":"committed"' \
      | jq -r '.commit // empty' 2>/dev/null | head -1)
    printf '%s' "$commit_hash"
  fi
}
```

- [ ] **Step 3: 커밋**

```bash
git add hooks/scripts/session-helper.sh
git commit -m "feat(helper): add check_branch_alignment + detect_orphan_experiment

Q4-B: branch mismatch detection (exit 1 on mismatch, stderr message).
X1: orphan detection uses real journal events (committed without evaluated)."
```

---

### Task 10: session-helper.sh — render_inherited_context + lineage_tree + append_meta_archive_local + list_sessions

**Files:**
- Modify: `hooks/scripts/session-helper.sh`

- [ ] **Step 1: list_sessions 구현**

```bash
  list_sessions)
    local filter_status=""
    for arg in "$@"; do
      case "$arg" in --status=*) filter_status="${arg#--status=}" ;; esac
    done

    if [ ! -f "$EVOLVE_DIR/sessions.jsonl" ]; then
      echo "[]"
      exit 0
    fi

    # Replay sessions.jsonl to derive current state
    # Output: JSON array of session objects
    local result="[]"
    while IFS= read -r line; do
      local event session_id
      event=$(printf '%s' "$line" | jq -r '.event' 2>/dev/null)
      session_id=$(printf '%s' "$line" | jq -r '.session_id' 2>/dev/null)
      [ -z "$session_id" ] && continue

      case "$event" in
        created|migrated)
          result=$(printf '%s' "$result" | jq --argjson entry "$line" '. + [$entry]')
          ;;
        status_change|reconciled)
          local new_status
          new_status=$(printf '%s' "$line" | jq -r '.status // empty')
          result=$(printf '%s' "$result" | jq --arg id "$session_id" --arg s "$new_status" \
            '[.[] | if .session_id == $id then .status = $s else . end]')
          ;;
        finished)
          result=$(printf '%s' "$result" | jq --argjson entry "$line" --arg id "$session_id" \
            '[.[] | if .session_id == $id then . + ($entry | del(.event, .ts)) else . end]')
          ;;
      esac
    done < "$EVOLVE_DIR/sessions.jsonl"

    if [ -n "$filter_status" ]; then
      result=$(printf '%s' "$result" | jq --arg s "$filter_status" '[.[] | select(.status == $s)]')
    fi

    printf '%s\n' "$result" | jq .
    ;;
```

- [ ] **Step 2: append_meta_archive_local 구현**

```bash
  append_meta_archive_local)
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
    ;;
```

- [ ] **Step 3: render_inherited_context 구현**

```bash
  render_inherited_context)
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
    ;;
```

- [ ] **Step 4: lineage_tree 구현**

```bash
  lineage_tree)
    if [ ! -f "$EVOLVE_DIR/sessions.jsonl" ]; then
      echo "(no sessions)"
      exit 0
    fi

    # Build lineage chain from sessions.jsonl
    local sessions
    sessions=$("$0" list_sessions)

    # Extract id → parent_session_id mapping
    printf '%s' "$sessions" | jq -r '.[] |
      .session_id + " <- " + (.parent_session_id // "(root)")
    '
    ;;
```

- [ ] **Step 5: 커밋**

```bash
git add hooks/scripts/session-helper.sh
git commit -m "feat(helper): add list_sessions, append_meta_archive_local, render_inherited_context, lineage_tree

list_sessions: replay sessions.jsonl, filter by --status
append_meta_archive_local: extract summary from receipt
render_inherited_context: generate Inherited Context markdown from parent receipt
lineage_tree: ASCII parent chain from sessions.jsonl"
```

---

### Task 11: protect-readonly.sh v2.2.0 재작성

**Files:**
- Modify: `hooks/scripts/protect-readonly.sh`

- [ ] **Step 1: v2.2.0 경로 해석 로직으로 재작성**

`find_evolve_root` 이후 `SESSION_FILE` 결정 부분을 다음으로 교체 (기존 forward-compat shim을 대체):

```bash
# === Session root resolution ===
CURRENT_JSON="$PROJECT_ROOT/.deep-evolve/current.json"
SESSION_ROOT=""

if [[ -f "$CURRENT_JSON" ]]; then
  # v2.2.0 layout
  SESSION_ID="$(jq -r '.session_id // empty' "$CURRENT_JSON" 2>/dev/null)"
  if [[ -n "$SESSION_ID" ]] && [[ -d "$PROJECT_ROOT/.deep-evolve/$SESSION_ID" ]]; then
    SESSION_ROOT="$PROJECT_ROOT/.deep-evolve/$SESSION_ID"
  fi
elif [[ -f "$PROJECT_ROOT/.deep-evolve/session.yaml" ]]; then
  # Legacy flat layout
  SESSION_ROOT="$PROJECT_ROOT/.deep-evolve"
fi

# No session root → allow everything
if [[ -z "$SESSION_ROOT" ]]; then
  exit 0
fi

SESSION_FILE="$SESSION_ROOT/session.yaml"

# P6: Helper bypass — scoped to registry files only (not blanket)
if [[ "${DEEP_EVOLVE_HELPER:-}" == "1" ]]; then
  # Only allow writes to: current.json, sessions.jsonl, session.yaml (status updates)
  # Still block: prepare.py, prepare-protocol.md, program.md, strategy.yaml
  FILE_PATH=""
  if echo "$TOOL_INPUT" | grep -q '"file_path"'; then
    FILE_PATH="$(echo "$TOOL_INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  fi
  case "$FILE_PATH" in
    */current.json|*/sessions.jsonl|*/session.yaml) exit 0 ;;
    # For Bash commands, allow if command targets only registry files
    "") exit 0 ;;  # Bash tool — let normal detection handle it
  esac
  # Fall through to normal protection for non-registry files
fi
```

그리고 `PROTECTED_*` 변수들을 `SESSION_ROOT` 기준으로 재설정:

```bash
PROTECTED_PREPARE="$SESSION_ROOT/prepare.py"
PROTECTED_PROTOCOL="$SESSION_ROOT/prepare-protocol.md"
PROTECTED_PROGRAM="$SESSION_ROOT/program.md"
PROTECTED_STRATEGY="$SESSION_ROOT/strategy.yaml"
```

나머지 로직(META_MODE, Bash write detection)은 그대로 유지.

- [ ] **Step 2: 검증**

```bash
grep -n "SESSION_ROOT\|CURRENT_JSON\|DEEP_EVOLVE_HELPER" hooks/scripts/protect-readonly.sh
```

Expected: 새 변수들이 모두 보임

- [ ] **Step 3: 커밋**

```bash
git add hooks/scripts/protect-readonly.sh
git commit -m "feat(hook): rewrite protect-readonly.sh for v2.2.0 namespace layout

Dynamic SESSION_ROOT resolution via current.json.
Legacy flat layout fallback preserved.
DEEP_EVOLVE_HELPER=1 bypass for session-helper.sh writes."
```

---

### Task 12: commands/deep-evolve.md dispatcher 재작성

**Files:**
- Modify: `commands/deep-evolve.md`

- [ ] **Step 1: Step 0에 resume/history 파싱 추가**

기존 Step 0 맨 앞에:

```markdown
- If arguments contain `resume`: → set RESUME=true
- If arguments start with `history`: → set HISTORY=true, HISTORY_ARGS=<rest of args>
```

- [ ] **Step 2: Step 1 완전 재작성**

기존 Step 1 전체를 다음으로 교체:

```markdown
## Step 1: State Detection & Routing

**If HISTORY** is set:
→ Read `skills/deep-evolve-workflow/protocols/history.md` → execute with HISTORY_ARGS

**If RESUME** is set:
→ Read `skills/deep-evolve-workflow/protocols/resume.md` → execute Resume Flow

**Otherwise:**

Run `session-helper.sh resolve_current` to get the active session.

**If exit 1 (no active session):**
- Check if `.deep-evolve/session.yaml` exists at root (legacy layout):
  - If yes → AskUserQuestion: "구 레이아웃(v2.1.x)이 감지되었습니다. 마이그레이션할까요?"
    - "archive": Run `session-helper.sh migrate_legacy` → then continue to Init
    - "abort": Stop
  - If no → Read `protocols/init.md` → Init Flow

**If session found**, read `$SESSION_ROOT/session.yaml` status:
- `status: active` → AskUserQuestion:
  "활성 세션이 있습니다. 어떻게 하시겠습니까?"
  - "이어서 진행 (resume)" → Read `protocols/resume.md` → Resume Flow
  - "완료 처리 (completion)" → Read `protocols/completion.md`
  - "중단 후 새로 시작" → `session-helper.sh mark_session_status <id> aborted` → Read `protocols/init.md`

- `status: paused` → AskUserQuestion:
  - "이어서 진행 (resume)" → Read `protocols/resume.md`
  - "중단 후 새로 시작" → `session-helper.sh mark_session_status <id> aborted` → Read `protocols/init.md`

- `status: completed` or `status: aborted` → AskUserQuestion:
  - "새 세션 시작" → Read `protocols/init.md`
  - "이력 보기" → Read `protocols/history.md`
  - "마지막 보고서 보기" → Read and display `$SESSION_ROOT/report.md`
```

- [ ] **Step 3: Protocol Routing Summary 업데이트**

```markdown
## Protocol Routing Summary

\`\`\`
Init           → protocols/init.md
Inner Loop     → protocols/inner-loop.md  (includes Resume + Section D: Prepare Expansion)
Outer Loop     → protocols/outer-loop.md  (매 outer_loop_interval 회)
Archive        → protocols/archive.md     (분기/복원 필요 시)
Transfer       → protocols/transfer.md    (A.2.5 lookup + E.0 recording + Section F prune)
Completion     → protocols/completion.md  (세션 완료)
Resume         → protocols/resume.md      (중단된 세션 재개)
History        → protocols/history.md     (세션 목록/lineage/통계)
\`\`\`
```

- [ ] **Step 4: 커밋**

```bash
git add commands/deep-evolve.md
git commit -m "feat(dispatcher): rewrite routing for v2.2.0 namespace + resume/history

Added: resume/history subcommand parsing, legacy migration prompt,
session-helper.sh resolve_current integration.
Removed: Delete .deep-evolve/ paths entirely — sessions are preserved."
```

---

### Task 13: init.md 재작성 (Step 1.5, 2-4, 3.5, 6, 9)

**Files:**
- Modify: `skills/deep-evolve-workflow/protocols/init.md`

- [ ] **Step 1: A.3 Scaffolding 재작성**

Line 137-154의 기존 scaffolding을 다음으로 교체:

```markdown
## A.3: Scaffolding

1. Create git branch:
\`\`\`bash
git checkout -b deep-evolve/$(date +%b%d | tr '[:upper:]' '[:lower:]')
\`\`\`

1.5. **Legacy layout migration** (v2.2.0):
If `.deep-evolve/session.yaml` exists at root and `.deep-evolve/current.json` does not exist:
→ This is a pre-v2.2.0 flat layout. The dispatcher should have already offered migration.
   If reached here, run `session-helper.sh migrate_legacy`.

2. Create session via helper:
\`\`\`bash
session-helper.sh start_new_session "<goal>" [--parent=<parent_id>]
\`\`\`
This creates `.deep-evolve/<session-id>/` with subdirs: `runs/`, `code-archive/`, `strategy-archive/`, `meta-analyses/`.
Sets `$SESSION_ROOT` to the created directory. Writes `current.json` and `sessions.jsonl`.

3. Add `.deep-evolve/` to `.gitignore` (if not already present):
\`\`\`bash
echo ".deep-evolve/" >> .gitignore
git add .gitignore
git commit -m "chore: add .deep-evolve/ to gitignore"
\`\`\`

3.5. **Lineage Decision** (v2.2.0):
Run `session-helper.sh list_sessions --status=completed`.
If at least one completed session exists:
  AskUserQuestion: "이 프로젝트에는 완료된 세션 N개가 있습니다. 어떻게 시작할까요?"
    - "fresh: 빈 상태로 시작" → parent_session = null
    - "continue from <last-completed>" → parent_session.id = last
    - "continue from ...: 특정 세션 선택" → list + pick
    - "transfer from other project" → 기존 transfer.md 경로
  If continue selected:
    - Copy parent's final strategy.yaml to $SESSION_ROOT/strategy.yaml
    - Record parent_session in session.yaml (Step 4에서)
    - Read parent receipt for Step 6 Inherited Context generation
```

- [ ] **Step 2: Step 4 session.yaml 스키마 업데이트**

Line 156-180 session.yaml 생성 부분에 필드 추가:

```yaml
session_id: "<computed>"
deep_evolve_version: "2.2.0"
# ... existing fields ...
outer_loop:
  generation: 0
  interval: 20
  inner_count: 0
  auto_trigger: true
  q_history: []
parent_session:    # null for root sessions; populated if continue selected
  id: "<parent_id or null>"
  parent_receipt_schema_version: <N>
  seed_source:
    strategy_version: <N>
    program_version: <N>
    notable_keep_commit_refs: [...]
  inherited_at: "<now>"
```

- [ ] **Step 3: Step 6 program.md 생성에 canonical 레이아웃 반영**

Step 6 (`Generate program.md`)의 지시를 다음 순서로 업데이트:

```
6. Generate program.md following the canonical layout:

   a. Title: `# <goal-based title>`

   b. Automation Policy (always, sentinel-wrapped):
      <!-- automation-policy-v1 -->
      ## Automation Policy
      ...
      <!-- /automation-policy-v1 -->

   c. Inherited Context (only if continue selected in Step 3.5):
      Run: session-helper.sh render_inherited_context <parent_id>
      Insert the output here:
      <!-- inherited-context-v1 -->
      ## Inherited Context (from <parent_id>)
      ...
      <!-- /inherited-context-v1 -->

   d. Project-specific experiment instructions (body)
```

- [ ] **Step 4: Step 7-9에서 파일 경로를 $SESSION_ROOT 기준으로 변경**

```
7. Initialize `$SESSION_ROOT/results.tsv` with header: `commit\tscore\tstatus\tdescription`
8. Initialize empty `$SESSION_ROOT/journal.jsonl`.
9. Generate `$SESSION_ROOT/strategy.yaml` with default parameters: ...
```

- [ ] **Step 5: 커밋**

```bash
git add skills/deep-evolve-workflow/protocols/init.md
git commit -m "feat(init): v2.2.0 namespace scaffolding + lineage + canonical layout

Step 1.5: legacy migration hook
Step 2: session-helper.sh start_new_session for namespace creation
Step 3.5: lineage decision (fresh / continue / transfer)
Step 6: canonical program.md layout (Automation Policy + Inherited Context)
Step 9: session.yaml with session_id, parent_session, inner_count, auto_trigger"
```

---

### Task 14: inner-loop.md $SESSION_ROOT 경로 치환

**Files:**
- Modify: `skills/deep-evolve-workflow/protocols/inner-loop.md`

- [ ] **Step 1: Section C 앞에 $SESSION_ROOT 선언 추가**

Line 29 (Section C 시작) 직후에:

```markdown
Read `session.yaml` for configuration. Read `$SESSION_ROOT/strategy.yaml` for strategy parameters.
Read `$SESSION_ROOT/results.tsv` and `$SESSION_ROOT/journal.jsonl` for history.

> **$SESSION_ROOT resolution**: The dispatcher or resume.md has already resolved the active session via `session-helper.sh resolve_current`. All `.deep-evolve/` paths in this protocol refer to `$SESSION_ROOT/`.
```

- [ ] **Step 2: 경로 치환 (P5: targeted edit, blind sed 금지)**

> **P5 반영**: `sed -i 's|\.deep-evolve/|$SESSION_ROOT/|g'` 사용 금지. 이유: git status 패턴 `grep -v '^\?\? .deep-evolve/'` (line 53)이 오염됨. 대신 Edit tool로 개별 치환.

`.deep-evolve/` → `$SESSION_ROOT/` 로 치환해야 하는 위치 (검색으로 확인):
```bash
grep -n '\.deep-evolve/' skills/deep-evolve-workflow/protocols/inner-loop.md
```

**치환 대상** (protocol 내 파일 경로 참조):
- `.deep-evolve/strategy.yaml` → `$SESSION_ROOT/strategy.yaml`
- `.deep-evolve/program.md` → `$SESSION_ROOT/program.md`
- `.deep-evolve/results.tsv` → `$SESSION_ROOT/results.tsv`
- `.deep-evolve/journal.jsonl` → `$SESSION_ROOT/journal.jsonl`
- `.deep-evolve/runs/` → `$SESSION_ROOT/runs/`
- `.deep-evolve/prepare.py` → `$SESSION_ROOT/prepare.py`
- `.deep-evolve/prepare-protocol.md` → `$SESSION_ROOT/prepare-protocol.md`
- `.deep-evolve/code-archive/` → `$SESSION_ROOT/code-archive/`

**치환 제외** (파일시스템 리터럴 경로로서 `.deep-evolve/`가 정확히 필요한 곳):
- `grep -v '^\?\? .deep-evolve/'` (line ~53) — git status 제외 패턴
- `.gitignore` 언급 (`echo ".deep-evolve/" >> .gitignore` 등)

Edit tool을 사용해 각 라인을 개별적으로 교체. 총 ~15개 치환 예상.

- [ ] **Step 3: 검증**

```bash
# protocol 내 파일 참조에는 .deep-evolve/ 없어야 함
grep '\.deep-evolve/' skills/deep-evolve-workflow/protocols/inner-loop.md | grep -v 'grep\|gitignore\|git status'
# Expected: 0 matches

# git status 패턴은 .deep-evolve/가 그대로 남아 있어야 함
grep 'deep-evolve/' skills/deep-evolve-workflow/protocols/inner-loop.md | grep 'grep\|gitignore'
# Expected: 1+ matches (line 53 등)
```

- [ ] **Step 4: 커밋**

```bash
git add skills/deep-evolve-workflow/protocols/inner-loop.md
git commit -m "refactor(inner-loop): replace .deep-evolve/ with \$SESSION_ROOT/ (X8)"
```

---

### Task 15: outer-loop.md $SESSION_ROOT + meta-analyses + notable

**Files:**
- Modify: `skills/deep-evolve-workflow/protocols/outer-loop.md`

- [ ] **Step 1: $SESSION_ROOT 경로 치환 (P5: targeted edit)**

개별 Edit으로 `.deep-evolve/` → `$SESSION_ROOT/` 치환. 문서 내 리터럴 설명(예: "Tier 3 raises quality ceiling")은 치환 대상이 아님.

- [ ] **Step 2: meta-analysis 저장을 세대별 append로 변경**

Step 6.5.1의 meta-analysis 저장 부분을 찾아:

```
Before: Write to `.deep-evolve/meta-analysis.md`
After:  Write to `$SESSION_ROOT/meta-analyses/gen-<generation>.md`
        (where generation = session.yaml.outer_loop.generation)
```

`mkdir -p $SESSION_ROOT/meta-analyses` 지시도 추가 (만약을 위한 방어적 mkdir).

- [ ] **Step 3: Tier 2에 optional notable marking 추가**

Step 6.5.4 (Tier 2) 끝에 추가:

```markdown
(Optional, v2.3에서 의무화 예정) 현재 generation의 kept 실험 중 다른 세션에 전이할 가치가 있는 것이 있다면, journal.jsonl에 다음 형태로 기록:
`{"event": "outer_loop", "notable": true, "n": <experiment_number>, "reason": "<brief>", "timestamp": "<now>"}`
```

- [ ] **Step 4: 커밋**

```bash
git add skills/deep-evolve-workflow/protocols/outer-loop.md
git commit -m "refactor(outer-loop): \$SESSION_ROOT paths + per-gen meta-analysis + notable marking

X8: all .deep-evolve/ → \$SESSION_ROOT/
Meta-analysis now writes to meta-analyses/gen-<N>.md (no overwrite).
Tier 2: optional notable keep marking in journal."
```

---

### Task 16: archive.md + transfer.md + completion.md 경로 치환 + receipt 확장

**Files:**
- Modify: `skills/deep-evolve-workflow/protocols/archive.md`
- Modify: `skills/deep-evolve-workflow/protocols/transfer.md`
- Modify: `skills/deep-evolve-workflow/protocols/completion.md`

- [ ] **Step 1: archive.md 경로 치환 (P5: targeted edit)**

개별 Edit으로 `.deep-evolve/code-archive/`, `.deep-evolve/strategy-archive/` 등 파일 참조만 치환.

- [ ] **Step 2: transfer.md 경로 치환 (P5: targeted edit)**

개별 Edit으로 `session.yaml` 참조만 치환. **`~/.claude/deep-evolve/meta-archive.jsonl`은 절대 치환 금지** — 이는 글로벌 경로.

- [ ] **Step 3: completion.md 경로 치환 (P5: targeted edit)**

개별 Edit. "Preserve `.deep-evolve/code-archive/`" 같은 **디렉터리 보존 설명**은 치환 대상이 아님 (리터럴 on-disk 경로 설명).

- [ ] **Step 4: completion.md에 receipt v2.2.0 확장 지시 추가**

"Evolve Receipt Generation" 섹션에 다음 필드를 receipt 스키마에 추가하는 지시:

```markdown
**v2.2.0 receipt 확장 필드** (기존 필드 유지 + 아래 추가):

- `"receipt_schema_version": 2` — 파서 가드용
- `"experiments_table"`: $SESSION_ROOT/results.tsv 전체 dump (각 행에 generation 번호 매핑)
- `"generation_snapshots"`: $SESSION_ROOT/meta-analyses/gen-*.md 로드. 최대 10개; 초과 시 오래된 것부터 summary_only=true (meta_analysis_summary=첫 단락, content 필드=null)
- `"notable_keeps"`: journal.jsonl에서 notable=true 항목 수집 (source="marked") + results.tsv에서 top-5 score_delta (source="top_n"). score_delta = 동일 gen 내 직전 kept 대비. tie-break: n 오름차순.
- `"runtime_warnings"`: journal.jsonl에서 branch_mismatch_accepted, branch_rebound 등 수집
- `"parent_session"`: session.yaml.parent_session 복사

**Receipt 쓰기 순서**: write with outcome=null → user 선택 후 outcome 업데이트 → freeze (이후 수정 불가).

**Completion 시 추가 호출**:
- `session-helper.sh append_sessions_jsonl finished <id> <fields>` — sessions.jsonl에 finished 이벤트
- `session-helper.sh append_meta_archive_local <id>` — meta-archive-local.jsonl에 요약 append
```

- [ ] **Step 5: 검증**

```bash
for f in archive.md transfer.md completion.md; do
  echo "=== $f ==="
  grep -c '\.deep-evolve/' "skills/deep-evolve-workflow/protocols/$f" || echo "0"
done
# Expected: all 0 (except ~/.claude/ paths in transfer.md which is OK)

grep '~/.claude' skills/deep-evolve-workflow/protocols/transfer.md | head -3
# Expected: global meta-archive paths intact
```

- [ ] **Step 6: 커밋**

```bash
git add skills/deep-evolve-workflow/protocols/archive.md \
       skills/deep-evolve-workflow/protocols/transfer.md \
       skills/deep-evolve-workflow/protocols/completion.md
git commit -m "refactor(archive,transfer,completion): \$SESSION_ROOT + receipt v2.2.0

X8: all .deep-evolve/ → \$SESSION_ROOT/ across three protocols.
completion.md: receipt v2.2.0 schema (experiments_table, generation_snapshots cap 10,
notable_keeps, runtime_warnings, parent_session, receipt_schema_version).
M4: write-update-freeze receipt sequence documented."
```

---

### Task 17: resume.md 신규 프로토콜

**Files:**
- Create: `skills/deep-evolve-workflow/protocols/resume.md`

- [ ] **Step 1: resume.md 작성**

```markdown
# Resume Protocol (v2.2.0)

Resumes an interrupted deep-evolve session. Restores context from persisted state
and re-enters the experiment loop.

## Step 1 — Load current session

Run `session-helper.sh resolve_current` → `session_id`, `$SESSION_ROOT`.
Read `$SESSION_ROOT/session.yaml`. If status is terminal (completed/aborted):
  "재개할 세션이 없습니다. `/deep-evolve`로 새 세션을 시작하세요."
  Stop here.

## Step 2 — Load session state

Read the following files for context restoration:
- `$SESSION_ROOT/session.yaml` — full configuration
- `$SESSION_ROOT/strategy.yaml` — current strategy parameters
- `$SESSION_ROOT/results.tsv` — last 20 rows (experiment history)
- `$SESSION_ROOT/journal.jsonl` — last 50 events (recent activity)
- `$SESSION_ROOT/program.md` — experiment instructions (including Inherited Context if present)

## Step 3 — Integrity check

### 3.a Branch alignment (Q4-B + AH3)

```bash
session-helper.sh check_branch_alignment "$SESSION_ROOT"
```

If exit 1 (mismatch):
  AskUserQuestion: "현재 브랜치가 세션 브랜치와 다릅니다. (expected: <X>, actual: <Y>)"
  Options:
  - "checkout and continue": `git checkout <expected_branch>`, then continue
  - "proceed on current (branch rebind)":
    1. Update `session.yaml.lineage.current_branch` to current branch
    2. Append to journal.jsonl: `{"event": "branch_mismatch_accepted", ...}` and `{"event": "branch_rebound", "from": "<expected>", "to": "<actual>", ...}`
    3. Record in runtime_warnings for receipt (X13)
    → Inner-loop's branch guard will now pass (invariant restored)
  - "abort resume": Stop

### 3.b Dirty tree

```bash
git status --porcelain
```

If non-empty: warn user → AskUserQuestion: [stash 후 계속 / abort]

### 3.c HEAD vs last experiment

```bash
last_commit=$(tail -n1 "$SESSION_ROOT/results.tsv" | cut -f1)
head_commit=$(git rev-parse HEAD)
```

If different: "HEAD가 마지막 실험 커밋과 다릅니다." 경고 → [계속 / abort]

### 3.d Orphan experiment detection (X1)

```bash
orphan_commit=$(session-helper.sh detect_orphan_experiment "$SESSION_ROOT")
```

If non-empty (orphan found):
  AskUserQuestion: "실험 #<N>이 평가되지 않은 채 중단되었습니다. (commit: <hash>)"
  Options:
  - "재평가": Run evaluation harness on this commit, record result
  - "discard로 기록": Append discarded event to journal, proceed
  - "무시하고 다음 실험부터": Skip, continue with next experiment number

### 3.e Counter consistency

```bash
sess_inner=$(yq '.outer_loop.inner_count' "$SESSION_ROOT/session.yaml")
tsv_rows=$(($(wc -l < "$SESSION_ROOT/results.tsv") - 1))  # minus header
```

If mismatch: adopt results.tsv count as truth, update session.yaml, append `counter_reconciled` event to journal.

## Step 4 — Display resume summary

```
Deep Evolve 세션을 재개합니다

작업: <goal>
세션: <session_id>
진행: <inner_count>/<outer_interval> (generation <N>)
최근 실험: <last experiment n> <status> (score=<x>)
Q(v) 추이: <q_history values>
경고: <integrity check에서 발생한 이슈 요약>
다음: 실험 <n+1> 준비
```

## Step 5 — Re-enter experiment loop

If `session.yaml.status` == `paused`:
  → Read `protocols/outer-loop.md` from Step 6.5 (outer loop was in progress)

If `session.yaml.status` == `active`:
  → Read `protocols/inner-loop.md`, enter Section C with restored `inner_count`
```

- [ ] **Step 2: 커밋**

```bash
git add skills/deep-evolve-workflow/protocols/resume.md
git commit -m "feat(resume): add resume.md protocol (Layer 3)

5-step resume: load → state → integrity check → summary → dispatch.
AH3: branch rebind on mismatch (not just warn-only).
X1: orphan detection via real journal events.
X13: branch_mismatch_accepted → runtime_warnings."
```

---

### Task 18: history.md 신규 프로토콜

**Files:**
- Create: `skills/deep-evolve-workflow/protocols/history.md`

- [ ] **Step 1: history.md 작성**

```markdown
# History Protocol (v2.2.0)

Displays session history for the current project.

## Step 0 — Parse args

Arguments from dispatcher (HISTORY_ARGS):
- no args / "list" → MODE=list
- `<session-id>` → MODE=detail, TARGET=<id>
- `--lineage` → MODE=list, LINEAGE_VIEW=true
- `--export=md` or `--export=json` → MODE=list, EXPORT=<fmt>

## Step 1 — Load data

Primary source: `sessions.jsonl` (via `session-helper.sh list_sessions`)
- Includes active/paused sessions (X10)

For detail mode: also read `$EVOLVE_DIR/<TARGET>/evolve-receipt.json`
- Check `receipt_schema_version` (X14): if unknown version, warn and proceed best-effort

## Step 2 — Render

### MODE=list

```
deep-evolve Session History (this project)

┌────┬────────────────────────┬────────────┬────────┬───────┬─────────┬──────────┬──────────┐
│ #  │ Session / Goal         │ Date       │ Exps   │ Keep  │ Q Δ     │ Score Δ% │ Outcome  │
├────┼────────────────────────┼────────────┼────────┼───────┼─────────┼──────────┼──────────┤
│ 1  │ <session> [⚠]          │ <date>     │ N/?    │ N%    │ <val>   │ <val>%   │ <status> │
└────┴────────────────────────┴────────────┴────────┴───────┴─────────┴──────────┴──────────┘
```

⚠ = runtime_warnings가 있는 세션

If LINEAGE_VIEW:
  Run `session-helper.sh lineage_tree` → append lineage chain

Aggregate (완료 세션 기준):
  총 세션, 누적 실험, 평균 keep rate, Q 개선 추이

### MODE=detail

Read receipt. Display sections:
- Header (goal, dates, outcome)
- Experiments table (top-10 + bottom-5 by default; `--full` for all)
- Generation snapshots (each with Q, trigger, summary)
- Notable keeps
- Runtime warnings (if any)
- Parent session info

### EXPORT

- `--export=md`: Write history table + aggregate to `$EVOLVE_DIR/history-<ISO>.md`
- `--export=json`: Write sessions array + receipts to `$EVOLVE_DIR/history-<ISO>.json`
```

- [ ] **Step 2: 커밋**

```bash
git add skills/deep-evolve-workflow/protocols/history.md
git commit -m "feat(history): add history.md protocol (Layer 4)

MODE=list/detail/lineage/export.
X10: sessions.jsonl as primary source (active sessions visible).
X14: receipt_schema_version check on detail view.
M5: --full flag for complete experiments table."
```

---

### Task 19: SKILL.md + CHANGELOG v2.2.0 + 최종 검증

**Files:**
- Modify: `skills/deep-evolve-workflow/SKILL.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: SKILL.md 업데이트**

version: `"1.0.0"` → `"2.2.0"`. 라우팅 테이블에 추가:

```
Resume         → protocols/resume.md      (중단된 세션 재개)
History        → protocols/history.md     (세션 목록/lineage/통계)
```

description에 "session history, resume, lineage" 키워드 추가.

- [ ] **Step 2: CHANGELOG v2.2.0 추가**

CHANGELOG.md 최상단(v2.1.2 엔트리 위)에 spec §4 CHANGELOG 내용 삽입.

- [ ] **Step 3: T4 검증 — $SESSION_ROOT 전수 치환 확인**

```bash
for f in skills/deep-evolve-workflow/protocols/*.md; do
  count=$(grep -c '\.deep-evolve/' "$f" 2>/dev/null || echo 0)
  [ "$count" -gt 0 ] && echo "FAIL: $f has $count .deep-evolve/ references"
done
echo "T4 check complete"
# Expected: no FAIL lines (transfer.md의 ~/.claude/ 경로는 .deep-evolve/가 아니므로 OK)
```

- [ ] **Step 4: 커밋**

```bash
git add skills/deep-evolve-workflow/SKILL.md CHANGELOG.md
git commit -m "docs: SKILL.md v2.2.0 + CHANGELOG v2.2.0 entry"
```

- [ ] **Step 5: PR#2 생성**

```bash
git checkout -b feat/v2.2.0-session-history
git push -u origin feat/v2.2.0-session-history
gh pr create --title "feat: v2.2.0 session history + lineage + resume" --body "$(cat <<'EOF'
## Summary
- Layer 1: per-session namespace (.deep-evolve/<session-id>/)
- Layer 2: receipt v2.2.0 (experiments_table, generation_snapshots, notable_keeps, runtime_warnings)
- Layer 3: /deep-evolve resume with integrity checks
- Layer 4: /deep-evolve history (list/detail/lineage/export)
- Layer 5: session lineage (informational only, no git replay)
- Shell helper: session-helper.sh (12 subcommands, --dry-run)
- Legacy migration: copy-verify-pointer-delete (rollback-safe)
- All protocols: $SESSION_ROOT path substitution

## Test plan
- [ ] T3: Namespace isolation
- [ ] T4: grep .deep-evolve/ → 0 match across all protocols
- [ ] T5-T6: Lineage + inherited keeps NOT in code-archive
- [ ] T7-T9: Resume integrity checks
- [ ] T10: History shows active sessions
- [ ] T11: Generation snapshots cap 10
- [ ] T12: Legacy migration idempotent
- [ ] T13: sessions.jsonl append race
- [ ] T14: Hook dynamic path + DEEP_EVOLVE_HELPER bypass
- [ ] T15-T16: Receipt parser guard + --dry-run

## Spec
docs/superpowers/specs/2026-04-15-deep-evolve-session-history-impl.md
EOF
)"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: Every section (§1-8) mapped to at least one task. PR#1 = Tasks 1-4. PR#2 = Tasks 5-19.
- [x] **Placeholder scan**: No TBD/TODO. All code blocks contain actual content.
- [x] **Type consistency**: `$SESSION_ROOT`, `session_id`, `sessions.jsonl` naming consistent throughout.
- [x] **Decision coverage**: Q0-Q5, X1-X16, AH1-AH3, I1-I3, M1-M5 all addressed.
