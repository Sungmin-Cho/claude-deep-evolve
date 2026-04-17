---
name: deep-evolve
description: |
  Autonomous experimentation protocol. Analyzes your project, generates an evaluation
  harness, and runs experiment loops to systematically improve code toward your goal.
  Supports init, resume, and completion workflows via state-based auto-routing.
allowed_tools: all
# Note: Bash tool is allowed but protect-readonly.sh hook intercepts shell writes
# to .deep-evolve/prepare.py, prepare-protocol.md, program.md, and strategy.yaml during active experiment runs.
---

You are running the **deep-evolve** autonomous experimentation protocol.

## 핵심 불변식

- **Scoring Contract**: score는 항상 higher-is-better. minimize 메트릭은 evaluation harness 내부에서 `score = BASELINE_SCORE / raw_score` 변환 적용 (clamp 없음, >1.0 허용). baseline=1.0, 개선 시 >1.0, 악화 시 <1.0. init.md Step 11 writeback으로 minimize 메트릭도 baseline=1.0 보장 (v2.2.2/C-7).
- **보호 파일**: `prepare.py`, `prepare-protocol.md`, `strategy.yaml` — `DEEP_EVOLVE_META_MODE` 설정 없이는 수정 불가 (protect-readonly hook). status=`initializing` 동안에는 hook 미적용 (init 중 writeback 허용, v2.2.2/C-7).
- **상태 파일**: `session.yaml` (세션 설정+진행), `journal.jsonl` (이벤트 로그), `results.tsv` (실험 결과)
- **세션 생명주기 (v2.2.2)**: `initializing` → `active` → `paused` (outer loop 중) → `active` → `completed` / `aborted`
- **Resume 불변식 (v2.2.2)**: Outer Loop 각 sub-step은 journal 이벤트(`outer_loop`, `strategy_update`, `strategy_judgment`, `notable_marked`, `program_skip`)로 식별되며, resume 시 해당 이벤트가 이미 있으면 스킵 → idempotent.

## Step 0: Parse Arguments

Arguments: `$ARGUMENTS`

- If the **first token** of arguments is exactly `resume`: → set RESUME=true (not substring — "resume flaky tests" is a goal, not a resume command)
- If the **first token** of arguments is exactly `history`: → set HISTORY=true, HISTORY_ARGS=<rest of args>
- If arguments contain `--archive-prune`: → Read `skills/deep-evolve-workflow/protocols/transfer.md`, execute **Section F: Archive Prune**
- If arguments contain a number (e.g., `50`): set `REQUESTED_COUNT` to that number
- If arguments contain a quoted string (e.g., `"new goal"`): set `NEW_GOAL` to that string
- Otherwise: `REQUESTED_COUNT = null`, `NEW_GOAL = null`

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
- `status: initializing` → v2.2.2: Init을 중간에 중단한 세션. baseline writeback 전에 crash. AskUserQuestion:
  "init 중간에 중단된 세션이 있습니다 (baseline 측정 미완료). 어떻게 하시겠습니까?"
  - "init 재개" → Read `protocols/init.md` Step 11부터 재실행 (baseline 측정+writeback+active 전환)
  - "중단 후 새로 시작" → `session-helper.sh mark_session_status <id> aborted` → Read `protocols/init.md`

- `status: active` → AskUserQuestion:
  "활성 세션이 있습니다. 어떻게 하시겠습니까?"
  - "이어서 진행 (resume)" → Read `protocols/resume.md` → Resume Flow
  - "완료 처리 (completion)" → Read `protocols/completion.md`
  - "중단 후 새로 시작" → `session-helper.sh mark_session_status <id> aborted` → Read `protocols/init.md`

- `status: paused` → v2.2.2: Outer Loop 실행 중 중단된 세션. AskUserQuestion:
  - "이어서 진행 (resume)" → Read `protocols/resume.md` → Step 5는 outer-loop.md를 journal-event idempotent로 재진입
  - "중단 후 새로 시작" → `session-helper.sh mark_session_status <id> aborted` → Read `protocols/init.md`

- `status: completed` or `status: aborted` → AskUserQuestion:
  - "새 세션 시작" → Read `protocols/init.md`
  - "이력 보기" → Read `protocols/history.md`
  - "마지막 보고서 보기" → Read and display `$SESSION_ROOT/report.md`

## Protocol Routing Summary

```
Init           → protocols/init.md
Inner Loop     → protocols/inner-loop.md  (includes Resume + Section D: Prepare Expansion)
Outer Loop     → protocols/outer-loop.md  (매 outer_loop_interval 회)
Archive        → protocols/archive.md     (분기/복원 필요 시)
Transfer       → protocols/transfer.md    (A.2.5 lookup + E.0 recording + Section F prune)
Completion     → protocols/completion.md  (세션 완료)
Resume         → protocols/resume.md      (중단된 세션 재개)
History        → protocols/history.md     (세션 목록/lineage/통계)
```

## 상태 관리

### session.yaml 핵심 스키마

```yaml
goal: "<목표>"
created_at: "<ISO 8601>"               # 세션 생성 시각 (duration_minutes 계산용)
eval_mode: cli | protocol              # 평가 모드
metric:
  name: "<메트릭명>"
  direction: minimize | maximize
  baseline: <float>
  current: <float>
  best: <float>
experiments:
  total: <N>
  kept: <N>
  discarded: <N>
  crashed: <N>
  requested: <N or null>
target_files: [...]
program:
  version: <N>
  history: [...]
outer_loop:
  generation: <N>
  interval: 20
  inner_count: <N>
  auto_trigger: true
  q_history: [{generation, Q, epoch}, ...]
evaluation_epoch:
  current: <N>
  history:
    - epoch: <N>
      prepare_version: <N>
      generations: [...]
      best_Q: <float or null>
lineage:
  current_branch: "<branch name>"
  forked_from: {commit, keep_id, reason} | null
  previous_branches: [...]
transfer:
  source_id: "<archive_id or null>"
```

### journal.jsonl 이벤트 타입

| status/event                | 설명 |
|-----------------------------|------|
| planned                     | 아이디어 선택됨 |
| committed                   | 코드 커밋됨 (v2.2.2+: full 40-char SHA) |
| evaluated                   | 평가 완료, score 기록 |
| kept                        | keep 판정 |
| discarded                   | discard 판정 |
| rollback_completed          | git reset 완료 (note: "commit unresolvable" / "already removed from HEAD ancestry" 포함 가능) |
| outer_loop                  | Outer Loop Q(v) 기록 (idempotent 재진입 앵커, v2.2.2/R-1) |
| strategy_update             | strategy.yaml 변경 (idempotent 앵커) |
| strategy_judgment           | 전략 keep/discard/marginal/**epoch_baseline**(v2.2.2/H-2) 판정 |
| strategy_stagnation         | Outer Loop 정체 감지 |
| branch_fork                 | Code Archive backtrack |
| notable_marked              | Notable keep 자동/수동 마킹 |
| program_skip                | v2.2.2/R-1: 사용자가 Step 6.5.4 program.md 업데이트 거절 (resume 시 재프롬프트 방지) |
| branch_mismatch_accepted    | Resume 시 브랜치 불일치 수용 |
| branch_rebound              | Resume 시 session.yaml의 current_branch를 현재 브랜치로 갱신 |
| counter_reconciled          | Resume 시 inner_count 정정 |
