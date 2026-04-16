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
