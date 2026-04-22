# Resume Protocol (v2.2.2)

Resumes an interrupted deep-evolve session. Restores context from persisted state
and re-enters the experiment loop.

## Step 1 — Load current session

Run `session-helper.sh resolve_current` → `session_id`, `$SESSION_ROOT`.
Read `$SESSION_ROOT/session.yaml`. Branch by `status`:
- **terminal** (`completed` / `aborted`):
  "재개할 세션이 없습니다. `/deep-evolve`로 새 세션을 시작하세요." Stop here.
- **initializing** (v2.2.2): baseline writeback 전 중단 → dispatch back to
  `protocols/init.md` Step 11 (dispatcher에서 이미 처리됨; resume.md는 이 상태를
  직접 다루지 않는다).
- **active** / **paused**: continue to Step 2.

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
    **AH1 safety gate**: Before rebinding, verify that HEAD contains the last experiment commit:
    ```bash
    last_exp_commit=$(grep -v '^---' "$SESSION_ROOT/results.tsv" | tail -n1 | cut -f1)
    git merge-base --is-ancestor "$last_exp_commit" HEAD
    ```
    If the last experiment commit is NOT an ancestor of HEAD: **block rebind** — "현재 브랜치에 세션의 마지막 실험이 포함되어 있지 않습니다. checkout을 사용하세요." → abort or checkout only.
    If verified:
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
# CR2: tail -n1은 separator 행일 수 있으므로, 마지막 실제 실험 행을 찾음
last_commit=$(grep -v '^---' "$SESSION_ROOT/results.tsv" | tail -n1 | cut -f1)
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
sess_inner=$(grep 'inner_count:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/.*inner_count:[[:space:]]*//')
# CR1: inner_count는 세대별 카운터. results.tsv 전체 행이 아닌 현재 generation의 실험 수와 비교.
# 현재 generation 시작 실험 번호는 outer_loop.q_history의 마지막 entry 또는 0.
# 간이 방법: session.yaml.experiments.total - (이전 generation들의 총 실험 수)
# 실용적 접근: inner_count가 outer_interval보다 크면 이미 이상 → 경고만 표시
if [ "$sess_inner" -gt "$(grep 'interval:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/.*interval:[[:space:]]*//')" ] 2>/dev/null; then
  echo "inner_count($sess_inner) > interval — counter may be stale" >&2
  # Reset to 0, outer loop will re-evaluate
  # Update session.yaml and journal
fi
```

If counter appears inconsistent: warn and adopt safe default (0 if generation just changed, or tsv-derived if not). Append `counter_reconciled` event to journal.

## Step 4 — Display resume summary

### v2 Compatibility Banner (v3 code path)

Read `$SESSION_ROOT/session.yaml` and extract `deep_evolve_version`:

```bash
VERSION=$(grep '^deep_evolve_version:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/^deep_evolve_version:[[:space:]]*//; s/"//g')
```

IF `$VERSION` does NOT start with `3.` (i.e., `"2.2.2"` or earlier):
Display the following banner to the user before the progress summary:

```
⚠ This session uses v2.2.2 schema. v3 features (entropy tracking,
legibility enforcement, shortcut detection, diagnose-retry) are not
applied. Start a new session to enable them.
```

Then continue with the existing Step 4 flow (progress summary etc.).

ELSE ($VERSION starts with "3."):
No banner. Proceed directly to progress summary.

**Column-count auto-detect (v3 addition)**:

Read the first line of `$SESSION_ROOT/results.tsv`:

```bash
header_cols=$(head -1 "$SESSION_ROOT/results.tsv" | awk -F'\t' '{print NF}')
```

IF `$header_cols == 4`: v2 schema — columns are `commit score status description`.
IF `$header_cols == 9`: v3 schema — columns are `commit score status category score_delta loc_delta flagged rationale description`.
ELSE: abort with error: "Unexpected results.tsv column count: $header_cols. Expected 4 (v2) or 9 (v3)."

All downstream parsing in this report must use the detected column layout.

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

If `session.yaml.status == paused`:
  → A crash occurred during an Outer Loop run (see `inner-loop.md` Step 6.5, which wraps
    Outer Loop in `mark_session_status paused/active`). Read `protocols/outer-loop.md`
    and execute from the beginning. Outer Loop's **Resume safety** section inspects
    `journal.jsonl` for each sub-step's completion event and skips already-completed
    phases, so restart is idempotent — no additional work required here.

If `session.yaml.status == active`:
  → Read `protocols/inner-loop.md`, enter Section C with restored `inner_count`.
