---
name: deep-evolve-workflow
version: "3.3.2"
description: |
  This skill should be used when the user wants to run autonomous, measured
  code-improvement experiments — analyzing the project, generating an evaluation
  harness, and iterating until a goal metric improves. Also handles session
  resume, history queries, lineage tracking, outer-loop strategy evolution,
  and meta-archive transfer across projects. The actual command entry point
  is `commands/deep-evolve.md` (invoked as `/deep-evolve`).
  Trigger phrases include: "deep evolve", "deep-evolve", "autonomous experiment",
  "자율 실험", "auto improve", "자동 개선", "experiment loop", "실험 루프",
  "프로젝트 개선", "코드 최적화", "self-evolution", "자기 진화",
  "strategy", "전략 진화", "outer loop", "strategy evolution", "meta-archive",
  "stepping stones", "session history", "resume", "이어서 실험", "lineage",
  "entropy tracking", "shortcut detection", "diagnose retry", "legibility",
  "evidence-rich hill-climbing", or `/deep-evolve` invocation.
---

# Deep Evolve: Autonomous Experimentation Protocol

Goal-driven experiment loops that systematically improve any project through
measured code modifications. The user runs `/deep-evolve`; this skill governs
how the LLM analyzes the project, builds an evaluation harness, runs the
experiment loop, and reports results.

## Workflow

```
/deep-evolve → 프로젝트 분석 (init) → 평가 harness 생성 → 자율 실험 루프 (inner/outer) → 완료 보고
```

## Routing Table

All routing is owned by `commands/deep-evolve.md` (Step 1: State Detection & Routing).
This table lists every protocol file under `protocols/` and when it is entered.

| 진입 트리거 | Protocol 파일 | 책임 |
|---|---|---|
| 새 세션 (no active) | `protocols/init.md` | 프로젝트 분석, 평가 harness scaffolding, baseline 측정, Step 12에서 VERSION_TIER로 분기 |
| `v3_1_plus` 활성 세션 | `protocols/coordinator.md` | multi-seed dispatch + scheduler-decide + cross-seed forum + synthesis cascade |
| `v3_0` / `pre_v3` 활성 세션, 또는 coordinator의 per-seed 서브에이전트 | `protocols/inner-loop.md` | 단일 seed AAR Inner Loop (Steps 1-6), Section B(Resume), Section D(Prepare Expansion) |
| `outer_loop_interval` 도달 시 | `protocols/outer-loop.md` | 전략(strategy.yaml) 갱신, program.md 진화, Tier 1-3 자동 확장 |
| `/deep-evolve resume` 또는 `paused` 세션 | `protocols/resume.md` | journal-event idempotent 재진입, Step 3.5 reconciliation, Step 5에서 status × VERSION_TIER 분기 |
| `v3_1_plus` 세션 종료 직전 | `protocols/synthesis.md` | cross-seed cascade fallback + baseline 통합 |
| 세션 완료 처리 | `protocols/completion.md` | 최종 보고서, evolve-receipt envelope, archive 처리 |
| `/deep-evolve history [...]` | `protocols/history.md` | 세션 목록, lineage tree, 통계 |
| 분기/복원 | `protocols/archive.md` | Code Archive backtrack, branch_fork 이벤트 |
| `/deep-evolve --archive-prune` 또는 cross-project lookup | `protocols/transfer.md` | A.2.5 meta-archive lookup, E.0 recording, Section F prune |
| 다른 protocol에서 참조 (라우팅 대상 아님) | `protocols/taxonomy.md` | 공용 상수 (status enum, journal event type 등) |

## State Machine

`session.yaml.status` 가 다음 5가지 상태를 순환한다. 각 상태별 라우팅 결정은
`commands/deep-evolve.md` Step 1 의 AskUserQuestion 분기를 따른다.

```
initializing → active → paused (outer loop 중) → active → completed / aborted
```

- `initializing` — Init 도중 중단. Step 11(baseline writeback)부터 재실행
- `active` — Inner Loop 진행. resume/completion/abort 분기
- `paused` — Outer Loop 진행. journal-event idempotent로 안전하게 재진입
- `completed` — 정상 종료
- `aborted` — 사용자 중단

## 핵심 불변식

상세 정의는 `commands/deep-evolve.md` "핵심 불변식" 섹션 참조.

1. **고정 평가, 가변 코드**: prepare.py는 ground truth. target 파일만 수정한다
2. **Scoring Contract**: score는 항상 higher-is-better. minimize 메트릭은 `BASELINE_SCORE / raw_score` 변환
3. **보호 파일**: `prepare.py`, `prepare-protocol.md`, `program.md`, `strategy.yaml` 은 `DEEP_EVOLVE_META_MODE` 없이 수정 불가 (protect-readonly hook)
4. **측정 기반**: 모든 변경은 score로 평가. 개선 없으면 discard
5. **간결함 우선**: 동일 score에 더 단순한 코드 = keep
6. **이력 학습**: discard 이유를 기억하고 같은 실수 반복 안 함
7. **Resume 불변식**: Outer Loop sub-step 들은 journal 이벤트(`outer_loop`, `strategy_update`, `strategy_judgment`, `notable_marked`, `program_skip`)로 식별 → 재진입 idempotent

## 사용자 명령 (`/deep-evolve` 인자 매트릭스)

| 인자 | 의미 |
|---|---|
| (없음) | 새 세션 시작 또는 활성 세션 재개 |
| `<숫자>` (예: `50`) | 요청 실험 횟수 |
| `"<목표>"` | 새 목표로 세션 시작 |
| `resume` | 명시적 resume (첫 토큰이 정확히 `resume`일 때만) |
| `history` | 세션 이력 조회 |
| `history <session-id>` | 특정 세션 상세 |
| `history --lineage` | lineage tree |
| `--no-parallel` | A.2.6 가상-병렬 disable, 단일 seed 강제 |
| `--n-min=<1-9>` | 가상-병렬 최소 동시 seed 수 |
| `--n-max=<1-9>` | 가상-병렬 최대 동시 seed 수 (N_MIN ≤ N_MAX 보증) |
| `--kill-seed=<id>` | 진행 중인 seed 종료 요청을 큐에 작성 (T23) 후 즉시 exit |
| `--status` | 활성 세션 read-only 대시보드 (status-dashboard.py) |
| `--archive-prune` | meta-archive prune (transfer.md Section F) |

## 지원 도메인

| 도메인 | 예시 | 평가 모드 |
|--------|------|-----------|
| ML 훈련 | val_bpb 최소화 | cli (stdout 파싱) |
| 테스트 | 커버리지 80%+ | cli (테스트 실행) |
| 코드 품질 | 보안/패턴 개선 | cli (시나리오 통과율) |
| 전략 최적화 | sharpe ratio 최대화 | cli (백테스트 결과) |
| 게임 엔진 | 리플레이 정확도, 프레임 타임 | protocol (Unity MCP, Unreal 등) |
| GUI 앱 | UI 상태 검증, 접근성 | protocol (브라우저/앱 자동화) |
| 외부 시스템 | API 정확도, 파이프라인 결과 | protocol (MCP/HTTP) |

**평가 모드**:
- `cli` — 셸 명령으로 메트릭 획득 (대부분의 프로젝트)
- `protocol` — MCP/도구 기반 평가 프로토콜 (에디터/런타임 의존 프로젝트)
