---
name: deep-evolve
description: |
  Autonomous experimentation protocol. Analyzes your project, generates an evaluation
  harness, and runs experiment loops to systematically improve code toward your goal.
  Supports init, resume, and completion workflows via state-based auto-routing.
allowed_tools: all
# Note: Bash tool is allowed but protect-readonly.sh hook intercepts shell writes
# to .deep-evolve/prepare.py, prepare-protocol.md, and program.md during active experiment runs.
---

You are running the **deep-evolve** autonomous experimentation protocol.

## 핵심 불변식

- **Scoring Contract**: score는 항상 higher-is-better. minimize 메트릭은 evaluation harness 내부에서 `score = BASELINE_SCORE / raw_score` 변환 적용 (clamp 없음, >1.0 허용). baseline=1.0, 개선 시 >1.0, 악화 시 <1.0.
- **보호 파일**: `prepare.py`, `prepare-protocol.md`, `strategy.yaml` — `DEEP_EVOLVE_META_MODE` 설정 없이는 수정 불가 (protect-readonly hook)
- **상태 파일**: `session.yaml` (세션 설정+진행), `journal.jsonl` (이벤트 로그), `results.tsv` (실험 결과)

## Step 0: Parse Arguments

Arguments: `$ARGUMENTS`

- If arguments contain `--archive-prune`: → Read `skills/deep-evolve-workflow/protocols/transfer.md`, execute **Section F: Archive Prune**
- If arguments contain a number (e.g., `50`): set `REQUESTED_COUNT` to that number
- If arguments contain a quoted string (e.g., `"new goal"`): set `NEW_GOAL` to that string
- Otherwise: `REQUESTED_COUNT = null`, `NEW_GOAL = null`

## Step 1: State Detection & Routing

Check if `.deep-evolve/session.yaml` exists in the current project root.

**If NO session.yaml exists** (or `NEW_GOAL` is set):
→ Read `skills/deep-evolve-workflow/protocols/init.md` → Init 실행

**If session.yaml exists**, read the `status` field:
- `status: active` → Read `skills/deep-evolve-workflow/protocols/inner-loop.md` → Resume Flow
- `status: paused` → Ask the user via AskUserQuestion:
  "이전 세션이 중단되었습니다. 이어서 진행할까요?"
  Options: "이어서 진행" / "새로 시작"
  - "이어서 진행" → Read `protocols/inner-loop.md` → Resume Flow
  - "새로 시작" → Delete `.deep-evolve/`, Read `protocols/init.md` → Init Flow
- `status: completed` → Ask the user:
  "이전 세션이 완료되었습니다. 새 세션을 시작할까요?"
  Options: "새로 시작" / "결과 다시 보기"
  - "새로 시작" → Delete `.deep-evolve/`, Read `protocols/init.md` → Init Flow
  - "결과 다시 보기" → Read and display `.deep-evolve/report.md`

## Protocol Routing Summary

```
Init           → protocols/init.md
Inner Loop     → protocols/inner-loop.md  (includes Resume + Section D: Prepare Expansion)
Outer Loop     → protocols/outer-loop.md  (매 outer_loop_interval 회)
Archive        → protocols/archive.md     (분기/복원 필요 시)
Transfer       → protocols/transfer.md    (A.2.5 lookup + E.0 recording + Section F prune)
Completion     → protocols/completion.md  (세션 완료)
```

## 상태 관리

### session.yaml 핵심 스키마

```yaml
goal: "<목표>"
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

| status/event         | 설명 |
|----------------------|------|
| planned              | 아이디어 선택됨 |
| committed            | 코드 커밋됨 |
| evaluated            | 평가 완료, score 기록 |
| kept                 | keep 판정 |
| discarded            | discard 판정 |
| rollback_completed   | git reset 완료 |
| outer_loop           | Outer Loop Q(v) 기록 |
| strategy_update      | strategy.yaml 변경 |
| strategy_judgment    | 전략 keep/discard 판정 |
| strategy_stagnation  | Outer Loop 정체 감지 |
| branch_fork          | Code Archive backtrack |
