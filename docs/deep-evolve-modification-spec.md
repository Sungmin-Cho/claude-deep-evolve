# Deep-Evolve Self-Evolutionary Architecture — Modification Spec

이 문서는 deep-evolve를 자기 진화적 구조로 확장하기 위한 구체적 수정 사양이다.
반드시 `deep-evolve-research-context.md`를 먼저 읽고 맥락을 파악한 후 작업한다.

---

## 수정 범위

| 플러그인 | 수정 여부 | 이유 |
|----------|-----------|------|
| **deep-evolve** | ✅ 주 대상 | P0 버그 수정 + Loop 2 완성 + 자기 진화적 실험 루프 (2-Tier, 3계층, 아카이브) + 크로스 플러그인 인터페이스 |
| **deep-dashboard** | ✅ Phase 3 | collector/effectiveness/action-router에 evolve 차원 추가 |
| **deep-review** | ✅ Phase 3 | recurring findings 내보내기 추가 |
| **deep-work** | ⬜ Phase 3 선택적 | research context에 harnessability/evolve insights 소비 (1개 조건 블록) |
| deep-wiki | 변경 없음 | — |
| deep-docs | 변경 없음 | — |

Phase 1-2는 deep-evolve 단독으로 완결된다. Phase 3에서 deep-dashboard, deep-review, deep-work에 최소 침습적 변경이 추가된다.

---

## Phase 0: 버그 수정 (즉시)

### P0-1: protect-readonly.sh 97행 grep 파이프 논리 오류

**파일**: `hooks/scripts/protect-readonly.sh`
**문제**: 97행의 이중 파이프 grep이 동작하지 않음

```bash
# 현재 (97행) — grep -qF는 stdout 없음 → 두 번째 grep은 항상 빈 입력
if echo "$COMMAND" | grep -qF "$PROTECTED" | grep -qE "(>|>>|sed\s+-i|tee\s|cp\s|mv\s)"; then
```

**수정**:
```bash
# AND 조건으로 분리
if echo "$COMMAND" | grep -qF "$PROTECTED" && echo "$COMMAND" | grep -qE "(>|>>|sed\s+-i|tee\s|cp\s|mv\s)"; then
```

### P0-2: prepare-stdout-parse.py minimize 방향 미구현

**파일**: `templates/prepare-stdout-parse.py`
**문제**: 87-90행이 `pass` 스텁. minimize 메트릭(예: val_bpb)에서 score가 반전되지 않아 Judgment 로직이 오작동.

```python
# 현재 (87-90행)
if METRIC_DIRECTION == "minimize":
    pass  # Custom inversion logic filled by deep-evolve init
```

**수정**: 전체 scoring contract를 **"score는 항상 higher-is-better"**로 통일한다. prepare.py에서 inversion을 수행하고, judgment는 항상 `score_new > score_old`로 판정한다.

#### Scoring Contract (전 harness 공통 불변식)

```
불변식: prepare.py가 출력하는 score는 항상 "높을수록 좋다".
- maximize 메트릭: score = raw metric (변환 없음)
- minimize 메트릭: score = BASELINE_SCORE / raw metric (반전)
- 모든 judgment 로직은 score_new > score_old 로만 판정
```

이 불변식은 stdout-parse, test-runner, scenario, protocol 모든 템플릿에 적용된다.

#### prepare-stdout-parse.py 수정

```python
BASELINE_SCORE = {{BASELINE}}  # deep-evolve init이 채움

# ... compute_score() 이후 ...

if METRIC_DIRECTION == "minimize":
    # Lower raw metric = better → higher score = better
    # Normalize: baseline 대비 개선 비율. 0% 개선 = 0.5, 완전 제거 = 1.0
    if BASELINE_SCORE > 0 and score > 0:
        score = max(0.0, min(1.0, BASELINE_SCORE / score))
    elif score == 0:
        score = 1.0  # 메트릭이 0이면 완전 최적화
    # maximize 방향은 score 그대로 사용
```

#### commands/deep-evolve.md Step 5 Judgment 동기화

Step 5의 judgment 로직을 scoring contract에 맞게 수정한다:

```
현재 Step 5 (수정 필요):
  minimize 메트릭: score_new < score_old → keep (낮을수록 좋음)
  maximize 메트릭: score_new > score_old → keep (높을수록 좋음)

수정 후 Step 5:
  모든 메트릭: score_new > score_old + min_delta → keep (항상 높을수록 좋음)
  
  prepare.py가 이미 minimize→higher-is-better 반전을 수행했으므로,
  judgment는 방향을 신경 쓰지 않아도 된다.
```

함께 수정해야 하는 곳:
- `commands/deep-evolve.md` Step 5: direction 분기 제거, 단일 비교로 변경
- `commands/deep-evolve.md` A.3 Scaffolding: baseline 측정 후 `BASELINE_SCORE` 기록
- `commands/deep-evolve.md` session.yaml: `metric.best` / `metric.current` 저장 시 반전된 score 사용
- `templates/prepare-test-runner.py`: 동일한 scoring contract 적용
- `templates/prepare-scenario.py`: 동일한 scoring contract 적용
- `templates/prepare-protocol.md`: protocol 모드도 "score는 항상 higher-is-better" 명시

### P0-3: package.json + plugin.json repository URL 불일치

**파일**: `package.json` (9행), `.claude-plugin/plugin.json` (8행)
**현재**: `deep-evolve.git` / `deep-evolve`
**수정**: `claude-deep-evolve.git` / `claude-deep-evolve`

---

## Phase 1: Loop 2 완성 — program.md 자동 개정

### 목표

현재 deep-evolve는 Section D(Prepare Expansion)에서 prepare.py만 수동 트리거로 확장한다. Phase 1에서는 **실험 전략(program.md) 자체를 메타 분석하여 자동 개정**하는 메커니즘을 추가한다.

### 1.1 메타 분석 로직

**위치**: `commands/deep-evolve.md`의 Section C Step 6 (Continuation Check) 확장

현재 수렴 감지(10회 연속 discard 등)에서 사용자에게 선택지를 제공하는 부분에, **자동 메타 분석** 단계를 추가:

```
Step 6 — Continuation Check 확장:

기존 수렴 감지 로직 유지. 추가:

**Step 6.5 — Meta Analysis** (매 20회 실험마다, 또는 수렴 감지 시):

results.tsv와 journal.jsonl에서 패턴 추출:

1. keep 비율 분석:
   - 어떤 종류의 idea description이 keep 비율이 높았는가?
   - 예: "parameter tuning" 관련 → 60% keep, "architectural refactor" 관련 → 10% keep

2. discard 패턴 분류:
   - 반복되는 실패 유형 (crash, regression, marginal)
   - 동일 접근법의 반복 시도 감지

3. score 개선 폭 분석:
   - 가장 큰 delta를 만든 실험의 공통점
   - score 정체 구간의 특성

4. 메타 분석 결과를 .deep-evolve/meta-analysis.md에 기록

5. program.md 개정 제안 생성:
   - 효과적이었던 전략 강화
   - 비효과적이었던 접근법 명시적 금지
   - 새로운 탐색 방향 제안

6. 사용자에게 AskUserQuestion:
   "메타 분석 기반으로 실험 전략을 업데이트할까요?"
   Options:
   - "자동 업데이트 적용" → program.md 개정, protect-readonly 일시 해제
   - "내용 확인 후 결정" → meta-analysis.md 표시
   - "현재 전략 유지"
```

### 1.2 protect-readonly.sh 수정

program.md 자동 개정을 위해, **meta analysis context에서만** program.md 쓰기를 허용하는 메커니즘이 필요하다.

**방법 A (권장)**: 환경변수 기반 일시 해제

```bash
# protect-readonly.sh에 추가
# META_ANALYSIS 모드에서는 program.md 쓰기 허용
META_MODE="${DEEP_EVOLVE_META_MODE:-}"
if [[ "$META_MODE" == "program_update" ]]; then
  # program.md만 해제, prepare.py는 여전히 보호
  case "$FILE_PATH" in
    "$PROTECTED_PREPARE"|"$PROTECTED_PROTOCOL") block_protected ;;
  esac
  exit 0
fi
```

deep-evolve.md의 Step 6.5에서 program.md 업데이트 전에 `DEEP_EVOLVE_META_MODE=program_update`를 설정하고, 업데이트 후 해제.

**방법 B**: session.yaml에 `meta_mode: program_update` 필드 추가, protect-readonly.sh가 이를 읽어 판단.

### 1.3 program.md 버전 관리

session.yaml에 program 버전 이력 추가:

```yaml
program:
  version: 2
  history:
    - version: 1
      experiments: "1-20"
      keep_rate: 0.15
      reason: "initial"
    - version: 2
      experiments: "21-40"
      keep_rate: 0.30
      reason: "meta_analysis: parameter tuning 우선, arch refactor 제한"
```

results.tsv에 program 버전 전환 시 구분선 삽입 (prepare 확장과 동일 패턴):

```
--- program v1 -> v2 (meta_analysis: keep_rate 0.15 -> target 0.30) ---
```

---

## Phase 2: 자기 진화적 실험 루프 (Self-Evolutionary Experiment Loop)

### 목표

HyperAgents의 3-Loop 자기 진화 구조를 deep-evolve에 구현한다. autoresearch의 "제약 기반 단순성"을 유지하면서, 실험 전략과 평가 범위가 **스스로 진화**하는 구조를 만든다. 도메인에 상관없이 사용자가 목표를 주면 LLM이 자율적으로 달성하는 환경을 구축한다.

### 설계 원칙

#### autoresearch에서 유지하는 것
- 평가 harness(prepare.py)의 고정성 → Goodhart 방지
- Git 기반 롤백 → 안전한 실험
- "수정 가능 vs 고정"의 명확한 분리

#### HyperAgents에서 가져오는 것
- Loop 3: 메타 전략의 자기 진화 (strategy.yaml + program.md + prepare.py 3계층)
- 아카이브 기반 stepping stones (전략 레벨 + 코드 레벨)
- 부모 선택 전략 (탐색-착취 균형)
- 크로스 도메인 전이 (프로젝트 간 전략 전이)

#### deep-evolve 고유의 적응
- Docker 격리 대신 git branch/worktree 기반 격리 (Claude Code 환경에 적합)
- Python 코드 자기 수정 대신 구조화된 3계층 진화 (검증 가능성 확보)
- 앙상블 대신 아이디어 후보 다수 생성 → 최선 선택 (코드는 단일 상태)

### 전제조건

Phase 1 (program.md 자동 개정)이 동작하는 상태여야 한다. Phase 2는 Phase 1의 meta analysis 위에 Outer Loop를 추가하는 구조이므로, Phase 1 없이 Phase 2만 독립 실행할 수 없다.

---

### 2.1 프로토콜 2계층 분리

현재 `commands/deep-evolve.md`는 하나의 파일에 인프라와 전략이 혼재되어 있다. 이것을 분리한다.

#### autoresearch와의 대응

| autoresearch | deep-evolve (현재) | deep-evolve (Phase 2) |
|---|---|---|
| `prepare.py` (고정) | `deep-evolve.md` 전체 (고정) | **Core Protocol** (고정) |
| `train.py` (에이전트 수정) | target 코드 (에이전트 수정) | target 코드 (에이전트 수정) |
| `program.md` (사람→Phase1에서 자동) | `program.md` (Phase1에서 자동) | `program.md` (자동 개정) |
| — | — | **`strategy.yaml`** (자기 진화, NEW) |

#### Core Protocol (고정, 수정 불가)

`commands/deep-evolve.md`에서 다음 요소는 고정된 인프라로 유지:
- 상태 머신 (session.yaml 관리)
- journal.jsonl 원자적 상태 기록
- git commit/reset 메커니즘
- protect-readonly.sh 보호 로직
- 메타 메트릭 Q(v) 계산 공식 (§2.3 참조)
- Outer Loop 판정 로직

#### Strategy Layer (진화 가능)

`.deep-evolve/strategy.yaml`에 진화 가능한 파라미터를 추출:

```yaml
# .deep-evolve/strategy.yaml — 자기 진화 대상
# Core Protocol이 이 파일의 값을 읽어 Inner Loop 동작을 조정
# Outer Loop가 이 파일의 값을 수정하고 Q(v)로 검증

version: 1

idea_selection:
  method: "weighted"              # random | sequential | weighted
  weights:
    parameter_tuning: 0.25
    structural_change: 0.25
    algorithm_swap: 0.25
    simplification: 0.25
  candidates_per_step: 3          # 아이디어 앙상블: N개 후보 중 최선 선택
  min_novelty_distance: 2         # 최근 N개와 유사한 아이디어 회피

judgment:
  min_delta: 0.001                # 최소 개선 폭 (이하는 marginal)
  crash_tolerance: 3              # N회 연속 crash 시 전략 재검토 트리거
  marginal_policy: "discard"      # keep | discard | accumulate

convergence:
  consecutive_discard_limit: 10   # N회 연속 discard → 전략 재검토
  plateau_window: 15              # 최근 N회에서 개선 없으면 수렴 판정
  plateau_action: "branch"        # branch(코드 아카이브에서 분기) | meta_analysis | stop

exploration:
  radical_threshold: 20           # N회 연속 marginal → 과감한 시도
  backtrack_enabled: true         # 정체 시 이전 keep 커밋에서 분기 허용
  backtrack_strategy: "least_explored"  # least_explored | highest_score | random
```

#### Init 시 strategy.yaml 생성

Section A.3 (Scaffolding)에서 기본 strategy.yaml을 생성한다. 크로스 프로젝트 전이(§2.7)에서 아카이브가 있으면 전이된 값으로 초기화.

---

### 2.2 3계층 자기 진화

Outer Loop는 3개의 계층을 순차적으로 진화시킨다. 각 계층의 자유도와 검증 방법이 다르다.

#### 계층 1: strategy.yaml 파라미터 진화

```
자유도: 낮음 — 정해진 키의 값만 변경
효과: 탐색 효율 개선 (가중치, 임계값, 정책 조정)
검증: Q(v) 메타 메트릭으로 정량 비교
트리거: 매 outer_loop_interval(기본 20)회 inner loop 완료 시
```

예시: meta analysis에서 `parameter_tuning`의 keep rate가 60%이고 `structural_change`가 10%이면:
```yaml
# v1 → v2 자동 조정
idea_selection:
  weights:
    parameter_tuning: 0.25 → 0.45
    structural_change: 0.25 → 0.10
```

#### 계층 2: program.md 전략 텍스트 진화

```
자유도: 중간 — 자연어로 새로운 지시 추가/삭제 가능
효과: 탐색 방향 변경 ("에러 핸들링 우선", "성능 최적화 집중")
검증: Q(v) 메타 메트릭으로 정량 비교
트리거: Phase 1의 meta analysis와 동시 (매 outer_loop_interval 회)
```

이것은 Phase 1에서 이미 구현된 기능이다. Phase 2에서는 Outer Loop의 keep/discard 판정 아래에서 동작한다.

#### 계층 3: prepare.py 시나리오 자동 확장

```
자유도: 높음 — 새로운 테스트 시나리오, 새로운 메트릭 추가
효과: 코드 품질의 상한 자체를 높임
검증: 확장 전 baseline 재측정 → 확장 후 점수 비교
트리거: 수렴 감지 시 (plateau_action이 작동한 후에도 개선 없을 때)
```

현재 Section D (Prepare Expansion)는 수동 트리거이다. Phase 2에서는 **수렴 후 자동 트리거**로 전환:

```
수렴 감지 → 코드 아카이브에서 분기 시도 (§2.5)
  → 분기 후에도 3세대 연속 정체
  → prepare.py 시나리오 자동 확장 (계층 3 발동)
  → ★ Evaluation Epoch 전환 (§2.3의 epoch 분리 참조)
  → 확장 후 baseline 재측정
  → 새로운 시나리오 기준으로 Inner Loop 재개
```

계층 3이 발동하면 코드 품질의 **상한 자체가 올라간다**. 이전에 "테스트 통과율 100%"에 수렴했다면, edge case 시나리오가 추가되면서 새로운 개선 공간이 열린다.

> **주의: Evaluation Epoch 전환** — prepare.py가 변경되면 이전 세대의 Q(v)와 이후 세대의 Q(v)는 **다른 harness로 측정된 것**이므로 직접 비교할 수 없다. §2.3에서 정의하는 epoch 분리 메커니즘이 반드시 함께 동작해야 한다.

#### 3계층 진화 순서

```
Inner Loop 20회 → Outer Loop 발동:
  1. 계층 1 (strategy.yaml 조정) + 계층 2 (program.md 개정) — 동시 실행
  2. Q(v_new) > Q(v_old)? → keep : discard
  3. 3세대 연속 Q 미개선? → 코드 아카이브에서 분기 (§2.5)
  4. 분기 후에도 3세대 연속 정체? → 계층 3 (prepare.py 확장) 발동
```

---

### 2.3 메타 메트릭 Q(v)

전략의 품질을 정량화하는 공식. Core Protocol에 고정되며, strategy.yaml이 조작할 수 없다.

```
Q(v) = w1 × keep_rate(v)
     + w2 × normalized_delta(v)
     + w3 × (1 - crash_rate(v))
     + w4 × idea_diversity(v)

기본 가중치:
  w1 = 0.35  # 실험 효율 — 가장 직접적인 전략 품질 지표
  w2 = 0.30  # 개선 폭 — 정규화: max_delta 대비 비율
  w3 = 0.20  # 안정성 — crash가 적을수록 좋은 전략
  w4 = 0.15  # 탐색 다양성 — 같은 아이디어 반복 방지
```

#### 각 요소의 계산

```
keep_rate(v): 해당 전략 구간(N회 inner loop)에서 keep된 실험의 비율

normalized_delta(v): 해당 구간에서 keep된 실험들의 평균 score delta
                     / 세션 전체의 최대 delta (정규화)

crash_rate(v): 해당 구간에서 crash된 실험의 비율

idea_diversity(v): 해당 구간에서 시도된 아이디어의 description들 간
                   Jaccard 거리의 평균 (높을수록 다양)
                   계산: 각 description을 단어 집합으로 변환,
                   모든 쌍의 Jaccard 거리 평균
```

#### 전략 keep/discard 판정

```
Outer Loop 세대 g에서:
  Q(v_g) 계산 (이번 세대의 전략 품질)
  Q(v_g-1) 참조 (이전 세대의 전략 품질)

  전제: 두 세대가 같은 evaluation epoch에 있어야 비교 가능 (아래 참조)

  if Q(v_g) > Q(v_g-1):
    keep: strategy.yaml v_g를 유지, 전략 아카이브에 기록
  elif Q(v_g) == Q(v_g-1) ± 0.02:
    marginal: keep하되 다음 세대에서 더 과감한 변형 시도
  else:
    discard: strategy.yaml을 v_g-1로 복원, 다른 방향의 변형 시도
```

#### Evaluation Epoch 분리

prepare.py가 확장(계층 3)되면 평가 기준 자체가 변경된다. **다른 harness로 측정된 Q(v)는 비교할 수 없다.** 이 문제를 epoch 분리로 해결한다.

```
Epoch = prepare.py의 버전 (확장될 때마다 증가)

session.yaml에 기록:
  evaluation_epoch:
    current: 2
    history:
      - epoch: 1
        prepare_version: 1
        generations: [0, 1, 2, 3]     # 이 epoch에서 실행된 Outer Loop 세대
        best_Q: 0.51
      - epoch: 2
        prepare_version: 2
        generations: [4, 5]            # prepare.py 확장 후 새 epoch
        best_Q: 0.38                   # 더 엄격한 harness이므로 낮을 수 있음
```

**규칙:**

1. **같은 epoch 내에서만 Q(v) 비교**
   - Q(v_g) vs Q(v_g-1)은 둘 다 같은 epoch에 속할 때만 유효
   - epoch가 전환되면 이전 epoch의 Q(v)와 비교하지 않음

2. **epoch 전환 시 Q(v) 리셋**
   - 계층 3이 발동하여 prepare.py가 확장되면:
     a. 현재 코드 상태로 새 harness에서 baseline 재측정
     b. normalized_delta의 분모(max_delta)를 리셋
     c. 새 epoch 시작, 세대 번호는 계속 증가하지만 Q(v) 비교는 새 epoch 내에서만

3. **전략 아카이브의 epoch 태깅**
   - 각 전략 세대에 epoch 번호를 기록
   - 부모 선택 시 **같은 epoch 내에서만** 후보를 검색
   - 다른 epoch의 전략으로 분기하려면, 해당 전략을 현재 epoch의 harness로 재평가한 후 사용

4. **크로스 프로젝트 전이의 epoch 처리**
   - meta-archive에 기록 시 최종 epoch의 데이터만 전이 대상
   - q_trajectory는 epoch별로 분리하여 기록

---

### 2.4 전략 아카이브 (Stepping Stones)

HyperAgents의 핵심 혁신을 deep-evolve에 적용한다. 모든 전략 세대를 보존하고, 정체 시 이전 세대에서 분기한다.

#### 저장 구조

```
.deep-evolve/strategy-archive/
  gen_0/
    strategy.yaml       # 초기 전략
    program.md.snapshot  # 해당 시점의 program.md
    metrics.json         # Q(v), keep_rate, experiments 범위
  gen_1/
    strategy.yaml
    program.md.snapshot
    metrics.json
    parent: gen_0        # 부모 세대
    children_count: 2    # 이 세대에서 파생된 자식 수
  gen_2/
    ...
```

#### 부모 선택 전략

HyperAgents의 `score_child_prop`을 적응:

```
전략 정체 감지 (3세대 연속 Q 미개선) 시:

1. 전략 아카이브에서 모든 세대의 Q(v)와 children_count를 수집

2. 후보 점수 계산:
   candidate_score(gen) = Q(v_gen) × exploration_penalty(gen)
   
   exploration_penalty(gen) = exp(-(children_count / 4)^3)
   → 이미 많은 변형이 시도된 세대에 페널티
   → children_count=0 → penalty=1.0 (미탐색, 최고 우선)
   → children_count=4 → penalty=0.37 (충분히 탐색됨)
   → children_count=8 → penalty≈0 (과잉 탐색)

3. 최고 candidate_score의 세대를 부모로 선택

4. 해당 세대의 strategy.yaml + program.md를 복원

5. 이전과 다른 방향의 변형을 시도:
   - 복원된 전략의 meta analysis reasoning을 참조
   - 이미 시도된 변형 방향(children의 diff)을 확인
   - 아직 시도되지 않은 방향으로 변형
```

---

### 2.5 Inner Loop 보강: 코드 아카이브

Outer Loop의 전략 아카이브에 더해, Inner Loop에서도 코드 레벨 분기 탐색을 지원한다.

#### 코드 아카이브 구조

> **설계 결정**: git tag가 아닌 **named branch**를 사용한다. tag checkout은 detached HEAD를 만들어, 기존 세션의 rollback 모델(named branch + `git reset --hard HEAD~1`)과 충돌한다. named branch를 사용하면 lineage가 유지되고, crash recovery 시 어디로 돌아가야 하는지가 명확하다.

```
.deep-evolve/code-archive/
  keep_001/
    commit: abc1234
    score: 0.82
    description: "guard clause 추가로 에러 핸들링 개선"
    children_explored: 3
    branch: "evolve/session-xxx/fork-001"  # named branch (세션 네임스페이스)
  keep_002/
    commit: def5678
    score: 0.85
    description: "루프 최적화로 성능 10% 개선"
    children_explored: 7
    branch: "evolve/session-xxx/fork-002"
  ...
```

브랜치 명명 규칙: `evolve/<session-id>/fork-<NNN>`. 세션 네임스페이스 아래에 위치하여 다른 세션과 충돌하지 않는다.

#### 코드 분기 탐색

strategy.yaml의 `convergence.plateau_action: "branch"`가 트리거되면:

```
1. 코드 아카이브에서 keep된 모든 커밋의 children_explored를 확인

2. 탐색-착취 균형 계산:
   backtrack_score(keep) = score × exp(-(children_explored / 6)^3)
   
   backtrack_strategy에 따라:
   - "least_explored": 최저 children_explored 우선
   - "highest_score": 최고 score 우선 (children_explored 페널티 적용)
   - "random": 확률적 선택 (backtrack_score에 비례)

3. 선택된 커밋에서 새 named branch 생성:
   git checkout -b evolve/session-xxx/fork-003 <selected_commit>
   
   ※ detached HEAD로 전환하지 않는다. 항상 named branch 위에서 작업한다.

4. session.yaml에 분기 lineage 기록:
   ```yaml
   lineage:
     current_branch: "evolve/session-xxx/fork-003"
     forked_from:
       commit: abc1234
       keep_id: "keep_001"
       reason: "plateau detected after 10 consecutive discards"
     previous_branches:
       - "evolve/session-xxx"        # 원래 세션 브랜치
       - "evolve/session-xxx/fork-001"  # 이전 분기 (있으면)
   ```
   
   journal.jsonl에도 분기 이벤트 기록:
   ```jsonl
   {"event":"branch_fork","from_commit":"abc1234","to_branch":"evolve/session-xxx/fork-003","reason":"plateau","timestamp":"..."}
   ```

5. 이전과 다른 방향의 코드 수정 시도:
   program.md에 "이전에 이 지점에서 <description> 방향을 시도했으나 정체됨.
   다른 접근법을 시도하라." 컨텍스트 추가

6. 새로운 keep이 발생하면 코드 아카이브에 추가 (새 분기)

7. crash recovery: session.yaml의 lineage.current_branch를 참조하여
   현재 작업 브랜치를 정확히 복원. detached HEAD 상태가 없으므로
   git reset --hard HEAD~1이 항상 올바르게 동작.
```

#### 코드 아카이브 정리

세션 종료 시:
- 최종 채택된 경로의 branch는 유지
- 나머지 fork branch는 삭제하되, code-archive/ 내 메타데이터는 보존 (분석용)
- `git branch -d evolve/session-xxx/fork-*` (merged된 것만 삭제)

---

### 2.6 아이디어 앙상블

HyperAgents의 앙상블은 코드 수정에서는 부적합하다 (코드는 단일 상태). 대신 **판단 레벨 앙상블**을 구현한다.

#### 동작 방식

strategy.yaml의 `idea_selection.candidates_per_step: 3` 설정에 의해:

```
Inner Loop Step 1 (Idea Selection) 확장:

기존: LLM이 1개의 아이디어를 선택 → 실행

변경: 
1. LLM이 N개(기본 3개)의 후보 아이디어를 동시에 제안
2. 각 후보에 대해 분석:
   - 예상 개선 폭 (results.tsv의 과거 유사 시도 참조)
   - 예상 리스크 (crash 가능성, regression 가능성)
   - 이전 시도와의 차별성 (novelty)
3. 분석 결과를 기반으로 최선의 1개를 선택하여 실행

이것은 "실행의 앙상블"이 아니라 "판단의 앙상블"이다.
추가 실행 비용 없이 (코드를 N번 수정하지 않음) 아이디어 선택의 품질을 높인다.
```

#### Outer Loop와의 연동

candidates_per_step 자체도 strategy.yaml의 파라미터이므로, Outer Loop에서 진화 가능:
- 탐색 초기: candidates_per_step=1 (빠른 탐색)
- 정밀 탐색 단계: candidates_per_step=5 (신중한 선택)
- meta analysis에서 아이디어 선택 실패율이 높으면 자동 증가

---

### 2.7 크로스 프로젝트 전이

프로젝트 간 전략 지식을 축적하고 재사용한다.

#### 전제조건 (기록 게이트)

아카이브 **기록**은 다음 조건을 모두 만족하는 세션에서만 수행:
1. Outer Loop가 최소 2세대 실행됨
2. Q(v)가 1세대 이상에서 개선됨 (전략 진화가 유효했음)

조건 미충족 시 기록하지 않는다. 아카이브 **조회**는 항상 수행한다.

#### meta-archive.jsonl

**경로**: `~/.claude/deep-evolve/meta-archive.jsonl`

```jsonl
{
  "id": "archive_001",
  "timestamp": "2026-04-13T10:00:00Z",
  "project": {
    "path_hash": "a1b2c3",
    "type": "python_ml",
    "goal_description": "CNN 이미지 분류 val_accuracy 개선",
    "eval_mode": "cli",
    "template_type": "stdout_parse",
    "code_characteristics": {
      "languages": ["python"],
      "frameworks": ["pytorch"],
      "loc_estimate": 2500,
      "target_files_count": 3
    }
  },
  "strategy_evolution": {
    "initial_strategy": { "/* strategy.yaml v1 snapshot */" },
    "final_strategy": { "/* strategy.yaml 최종 버전 snapshot */" },
    "generations": 4,
    "q_trajectory": [0.35, 0.42, 0.48, 0.51],
    "best_generation": 3,
    "program_versions": [
      {
        "version": 1,
        "keep_rate": 0.15,
        "summary": "초기 전략"
      },
      {
        "version": 2,
        "keep_rate": 0.30,
        "diff_from_prev": "--- 탐색 방향\n+파라미터 튜닝 우선...",
        "meta_analysis_reasoning": "param_tuning 60% keep vs arch_refactor 10%"
      }
    ]
  },
  "outcome": {
    "total_experiments": 80,
    "total_outer_generations": 4,
    "final_keep_rate": 0.28,
    "improvement_pct": 15.2,
    "crashed_rate": 0.04
  },
  "transfer": {
    "source_id": null,
    "adopted_patterns_kept": null,
    "initial_keep_rate_10": null
  },
  "usage_count": 0,
  "transfer_success_rate": null
}
```

#### 아카이브 조회: Init 시 (A.2.5)

```
~/.claude/deep-evolve/meta-archive.jsonl이 존재하면:

1. 활성 항목(pruned 아닌 것)의 goal_description + code_characteristics 추출

2. LLM 기반 유사도 판단:
   현재 프로젝트의 goal, 언어, 프레임워크, 규모와 함께 아카이브 항목들을 제시.
   "전략적으로 가장 유사한 프로젝트를 선택하고 이유를 설명하라."
   
   판단 기준 (우선순위):
   a. goal의 성격 (최적화 vs 품질 개선 vs 리팩토링)
   b. 코드 스택 (언어/프레임워크)
   c. 프로젝트 규모 (LOC, target 파일 수)

3. 유사 항목이 있으면:
   - final_strategy → strategy.yaml 초기값으로 사용
   - program_versions의 diff → program.md "검증된 전략 전이" 섹션에 반영
   - q_trajectory → 전이 신뢰도 판단 (상승 추세면 높은 신뢰도)

4. usage_count 증가

5. 유사 항목이 없으면 기본 strategy.yaml로 시작
```

#### 아카이브 기록: 세션 완료 시 (E.0)

기록 게이트 통과 시:
1. strategy_evolution: strategy.yaml 버전 이력, Q(v) 궤적, program.md 이력 추출
2. outcome: results.tsv + session.yaml에서 최종 통계 계산
3. transfer: 전이를 받았으면 효과 데이터 기록 + 원본 항목의 transfer_success_rate 갱신
4. meta-archive.jsonl에 append

전이 효과 간접 지표:
- **초기 keep rate**: 전이 세션의 실험 1-10회 keep rate vs 비전이 세션 평균
- **전이 채택률**: 전이된 전략 중 Outer Loop 종료 시 strategy.yaml에 남은 비율
- **Q 궤적 비교**: 전이 세션의 Q 상승 속도 vs 비전이 세션 평균

#### 피드백 루프

전이 효과 데이터가 아카이브에 반영 → 효과 검증된 항목은 다음 조회에서 우선 → 효과 없는 항목은 pruning 대상.

---

### 2.8 아카이브 관리 (Pruning + 동시성 안전)

#### 동시성 모델

meta-archive.jsonl은 사용자 전역 파일이므로 여러 세션이 동시에 접근할 수 있다. usage_count 증가와 transfer_success_rate 갱신은 read-modify-write이므로, 잠금 없이는 데이터가 손상될 수 있다.

**잠금 프로토콜 (flock 기반):**

```
모든 meta-archive.jsonl 접근은 다음 프로토콜을 따른다:

읽기 전용 (A.2.5 조회, usage_count 증가 없이 후보 검색):
  잠금 없음. JSONL은 append-only이므로 부분 읽기가 안전.

쓰기 (append, usage_count 갱신, transfer_success_rate 갱신, pruning):
  1. ~/.claude/deep-evolve/meta-archive.lock 파일에 flock 획득 (exclusive)
  2. meta-archive.jsonl을 읽고 수정
  3. 수정된 내용을 meta-archive.jsonl에 기록
  4. flock 해제
  
  타임아웃: 5초. 5초 내 잠금 획득 실패 시:
  - append (E.0 기록): 경고 표시 후 재시도 1회. 실패 시 로컬에 .pending-archive.jsonl로 임시 저장.
  - usage_count 갱신: 스킵 (치명적이지 않음)
  - transfer_success_rate 갱신: 스킵 + 경고 (다음 세션에서 재계산 가능)

구현:
  flock은 shell에서 사용 가능하므로 별도 의존성 없음.
  Claude Code의 Bash 도구로 직접 실행:
  (
    flock -x -w 5 200 || { echo "LOCK_FAILED"; exit 1; }
    # read-modify-write 수행
  ) 200>~/.claude/deep-evolve/meta-archive.lock
```

**SQLite를 사용하지 않는 이유**: deep-evolve는 Claude Code 플러그인이며, JSONL + flock은 추가 의존성 없이 모든 환경에서 동작한다. 동시 세션 빈도가 낮으므로 flock으로 충분하다.

#### 소프트 pruning (조회에서 제외, 삭제하지 않음)

아카이브 조회 시 다음 조건의 항목은 후보에서 제외:

```
제외 조건 (OR):
1. 90일 이상 미사용 AND transfer_success_rate < 0.3
2. transfer_success_rate == 0 (전이받은 프로젝트가 모두 실패)
3. outcome.total_outer_generations < 2 (Outer Loop가 충분히 실행되지 않음)
```

제외 항목에 `"pruned": true, "pruned_reason": "..."` 추가. 삭제하지 않음 (복원 가능). pruning 쓰기는 위의 flock 프로토콜을 따른다.

#### 수동 정리

`/deep-evolve --archive-prune` 실행 시:
1. 전체 아카이브 통계 표시
2. pruning 후보 목록 표시
3. 사용자 확인 후 소프트 pruning 적용 (flock 하에서 수행)

---

### 2.9 전체 실행 흐름

```
/deep-evolve 실행
  │
  ▼
Section A: Init
  ├─ A.1 프로젝트 분석
  ├─ A.2 Goal & Configuration
  ├─ A.2.5 Meta Archive Lookup (크로스 프로젝트 전이 조회)
  ├─ A.3 Scaffolding (prepare.py + program.md + strategy.yaml 생성)
  │
  ▼
Section C: 실험 루프 (2-Tier)
  │
  ├─── Outer Loop (전략 진화) ─────────────────────────────┐
  │    │                                                     │
  │    │  strategy.yaml v_g + program.md v_g 로 설정         │
  │    │                                                     │
  │    ├─── Inner Loop (코드 진화) ────────────────────┐     │
  │    │    │                                           │     │
  │    │    │  Step 1: 아이디어 앙상블 (N개 → 1개 선택) │     │
  │    │    │  Step 2: 코드 수정                        │     │
  │    │    │  Step 3: Git Commit                       │     │
  │    │    │  Step 4: 평가 (prepare.py)                │     │
  │    │    │  Step 5: Judgment (keep/discard)           │     │
  │    │    │  Step 6: 정체? → 코드 아카이브에서 분기   │     │
  │    │    │                                           │     │
  │    │    │  × N회 (기본 20회) 반복                   │     │
  │    │    └───────────────────────────────────────────┘     │
  │    │                                                     │
  │    │  Meta Analysis (Phase 1) 실행                       │
  │    │  계층 1: strategy.yaml 파라미터 조정                 │
  │    │  계층 2: program.md 전략 텍스트 개정                 │
  │    │                                                     │
  │    │  Q(v_g) 계산 → Q(v_g-1)과 비교 → keep/discard       │
  │    │                                                     │
  │    │  정체 감지?                                          │
  │    │  ├─ 3세대 연속 Q 미개선 → 전략 아카이브에서 분기    │
  │    │  └─ 분기 후에도 정체 → 계층 3 (prepare.py 확장)     │
  │    │                                                     │
  │    │  전략 아카이브에 세대 기록                           │
  │    │                                                     │
  │    └─────────────────────────────────────────────────────┘
  │
  ▼
Section E.0: Meta Archive Update (크로스 프로젝트 전이 기록)
Section E: Completion Report

---

## Phase 3: 크로스 플러그인 피드백

Phase 3는 deep-suite 전체에 걸친 변경이다. 4개 플러그인이 관여한다.

### 수정 범위 요약

| 플러그인 | 수정 파일 | 변경 유형 |
|----------|-----------|-----------|
| deep-evolve | `commands/deep-evolve.md` | receipt 생성 + review 트리거 + findings 소비 |
| deep-dashboard | `lib/dashboard/collector.js` | evolve 데이터 수집 함수 추가 |
| deep-dashboard | `lib/dashboard/effectiveness.js` | evolve 차원 추가 |
| deep-dashboard | `lib/dashboard/action-router.js` | evolve 관련 액션 매핑 추가 |
| deep-review | `commands/deep-review.md` | recurring findings 내보내기 추가 |
| deep-work | `sensors/registry.json` | evolve 메타 패턴 기반 센서 소비 (선택적) |

---

### 3.1 deep-evolve → deep-dashboard (데이터 내보내기)

#### 3.1.1 evolve-receipt.json 생성

**수정 파일**: `commands/deep-evolve.md` Section E (Completion Report)

Section E의 report.md 생성 직후, `evolve-receipt.json`을 생성한다:

**경로**: `.deep-evolve/evolve-receipt.json`

```json
{
  "plugin": "deep-evolve",
  "version": "1.2.0",
  "timestamp": "2026-04-13T10:00:00Z",
  "goal": "val_bpb minimize",
  "eval_mode": "cli",
  "experiments": {
    "total": 50,
    "kept": 12,
    "discarded": 35,
    "crashed": 3,
    "keep_rate": 0.24
  },
  "score": {
    "baseline": 0.998,
    "current": 0.955,
    "best": 0.952,
    "improvement_pct": 4.6
  },
  "program": {
    "versions": 3,
    "meta_analyses": 2
  },
  "meta_archive_updated": true,
  "duration_minutes": 240,
  "quality_score": 72
}
```

`quality_score` (0-100) 계산 공식:
```
quality_score = (
  keep_rate * 30 +                          # 실험 효율 (0-30)
  min(improvement_pct / 10, 1.0) * 40 +     # 개선 폭 (0-40)
  (1 - crashed / total) * 20 +              # 안정성 (0-20)
  min(program.meta_analyses / 3, 1.0) * 10  # 메타 학습 활용 (0-10)
)
```

#### 3.1.2 deep-dashboard collector.js 수정

**수정 파일**: `claude-deep-dashboard/lib/dashboard/collector.js`

`collectDeepEvolve()` 함수 추가:

```javascript
/**
 * Collect deep-evolve data.
 *
 * Paths:
 *   <root>/.deep-evolve/evolve-receipt.json
 *   <root>/.deep-evolve/session.yaml (status 확인용)
 */
function collectDeepEvolve(root) {
  const receiptPath = path.join(root, '.deep-evolve', 'evolve-receipt.json');
  const sessionPath = path.join(root, '.deep-evolve', 'session.yaml');

  const receipt = readJson(receiptPath);
  const hasSession = pathExists(sessionPath);

  return {
    status: receipt !== null ? 'available' : (hasSession ? 'active_session' : 'no_data'),
    receipt,
  };
}
```

`collectData()` 반환 객체에 추가:
```javascript
export function collectData(projectRoot) {
  const root = path.resolve(projectRoot);
  return {
    deepWork: collectDeepWork(root),
    deepReview: collectDeepReview(root),
    deepDocs: collectDeepDocs(root),
    deepEvolve: collectDeepEvolve(root),     // 추가
    harnessability: collectHarnessability(root),
  };
}
```

#### 3.1.3 deep-dashboard effectiveness.js 수정

**수정 파일**: `claude-deep-dashboard/lib/dashboard/effectiveness.js`

WEIGHTS에 `evolve` 차원 추가. 기존 가중치를 재분배:

```javascript
const WEIGHTS = {
  health:         0.25,  // 0.30 → 0.25
  fitness:        0.20,  // 0.25 → 0.20
  session:        0.20,  // 0.25 → 0.20
  harnessability: 0.15,  // 0.20 → 0.15
  evolve:         0.20,  // 신규
};
```

`extractEvolveScore()` 함수 추가:

```javascript
/**
 * Extract a 0-10 evolve score from deep-evolve receipt.
 *
 * Uses quality_score (0-100) → normalize to 0-10.
 */
function extractEvolveScore(data) {
  const receipt = data.deepEvolve?.receipt;
  if (receipt === null || receipt === undefined) return null;

  const qs = receipt.quality_score ?? null;
  if (qs !== null && typeof qs === 'number') {
    return Math.min(10, Math.max(0, Math.round(qs) / 10));
  }
  return null;
}
```

`calculateEffectiveness()`의 `rawScores`에 추가:
```javascript
const rawScores = {
  health:         extractHealthScore(data),
  fitness:        extractFitnessScore(data),
  session:        extractSessionScore(data),
  harnessability: extractHarnessabilityScore(data),
  evolve:         extractEvolveScore(data),    // 추가
};
```

not_applicable 재분배 패턴은 기존과 동일하게 작동 (evolve 데이터 없으면 다른 차원에 가중치 분배).

#### 3.1.4 deep-dashboard action-router.js 수정

**수정 파일**: `claude-deep-dashboard/lib/dashboard/action-router.js`

ACTION_MAP에 evolve 관련 항목 추가:

```javascript
const ACTION_MAP = {
  // ... 기존 항목 유지 ...
  'evolve-low-keep':    { action: 'Run /deep-evolve with meta analysis for strategy refinement', category: 'evolve' },
  'evolve-high-crash':  { action: 'Check eval harness stability before next /deep-evolve',      category: 'evolve' },
  'evolve-stale':       { action: 'Run /deep-evolve to continue improvement',                   category: 'evolve' },
};
```

`extractEvolveFindings()` 함수 추가:

```javascript
/**
 * Extract findings from deep-evolve receipt.
 */
function extractEvolveFindings(data) {
  const receipt = data.deepEvolve?.receipt;
  if (!receipt) return [];

  const findings = [];
  const experiments = receipt.experiments;
  if (!experiments) return findings;

  // Low keep rate
  if (experiments.keep_rate !== undefined && experiments.keep_rate < 0.15) {
    findings.push({
      finding: 'evolve-low-keep',
      severity: 'warning',
      detail: `keep rate ${(experiments.keep_rate * 100).toFixed(0)}% — meta analysis로 전략 개선 권장`,
    });
  }

  // High crash rate
  if (experiments.total > 0 && experiments.crashed / experiments.total > 0.2) {
    findings.push({
      finding: 'evolve-high-crash',
      severity: 'error',
      detail: `crash rate ${((experiments.crashed / experiments.total) * 100).toFixed(0)}% — eval harness 안정성 점검 필요`,
    });
  }

  return findings;
}
```

`getSuggestedActions()`의 rawFindings에 추가:
```javascript
const rawFindings = [
  ...extractFitnessFindings(data),
  ...extractReceiptFindings(data),
  ...extractDocsFindings(data),
  ...extractEvolveFindings(data),    // 추가
];
```

---

### 3.2 deep-evolve → deep-review (자동 트리거 제안)

**수정 파일**: `commands/deep-evolve.md` Section E (Completion Report)

Section E에서 사용자가 "main에 merge" 또는 "PR 생성"을 선택했을 때:

```
merge/PR 실행 전에 AskUserQuestion:
"deep-review로 최종 변경사항을 독립 검증할 수 있습니다."
Options:
- "deep-review 실행 후 merge" → /deep-review 실행, 완료 후 merge/PR 진행
- "바로 merge" → 즉시 진행
- "branch 유지 (나중에 review)" → branch만 유지

"deep-review 실행 후 merge" 선택 시:
1. deep-review가 deep-evolve 브랜치의 전체 diff를 리뷰
2. APPROVE → 자동 merge/PR 진행
3. REQUEST_CHANGES → 리뷰 결과 표시, 사용자에게 판단 위임
4. deep-review가 생성한 .deep-review/receipts/*.json은 deep-dashboard에서 수집 가능
```

---

### 3.3 deep-review → deep-evolve (역방향 피드백: recurring findings)

#### 3.3.1 deep-review에 recurring findings 내보내기 추가

**수정 파일**: `claude-deep-review/commands/deep-review.md`

리뷰 완료 시(Stage 6: Report 생성 후), recurring findings를 구조화 파일로 내보내는 단계 추가:

```
Stage 6.5: Recurring Findings Export

.deep-review/reports/ 내 모든 리포트를 읽어 반복 발견되는 패턴 추출:

1. 모든 리포트의 🔴 Critical + 🟡 Warning 항목을 수집
2. 같은 유형의 finding이 3회 이상 나타나면 "recurring"으로 분류
3. .deep-review/recurring-findings.json에 기록:

```json
{
  "updated_at": "2026-04-13T10:00:00Z",
  "findings": [
    {
      "type": "missing-error-handling",
      "severity": "critical",
      "occurrences": 5,
      "example_files": ["src/api/handler.ts:45", "src/worker/processor.ts:120"],
      "description": "async 함수에서 try-catch 없이 외부 API 호출"
    },
    {
      "type": "inconsistent-naming",
      "severity": "warning",
      "occurrences": 3,
      "example_files": ["src/utils/format.ts", "src/helpers/convert.ts"],
      "description": "camelCase/snake_case 혼용"
    }
  ]
}
```

이 파일은 deep-evolve가 소비할 수 있는 표준 인터페이스.
```

#### 3.3.2 deep-evolve에서 recurring findings 소비

**수정 파일**: `commands/deep-evolve.md` Section A.1 (Project Deep Analysis)

Stage 3 (Code Deep Analysis)에서 추가:

```
Stage 3 추가 — Review Findings Integration:

.deep-review/recurring-findings.json이 존재하면:
1. 파일 읽기
2. recurring findings를 prepare.py의 시나리오 생성에 반영:
   - "missing-error-handling" → 에러 핸들링 관련 시나리오 가중치 높임
   - "inconsistent-naming" → 네이밍 일관성 검사 시나리오 추가
3. program.md 생성 시 "알려진 반복 결함" 섹션에 findings 포함:
   "이 프로젝트에서 deep-review가 반복 발견한 패턴:
    - <type>: <description> (<occurrences>회)
    이 영역의 개선을 우선적으로 시도하라."
```

이렇게 하면 deep-review가 발견한 패턴이 deep-evolve의 실험 방향을 자연스럽게 조향한다.

---

### 3.4 deep-dashboard → deep-work (harnessability 기반 guide 강화)

> 이 항목은 deep-evolve 자체와는 직접 관련이 없지만, Phase 3 (크로스 플러그인 피드백)의 완결성을 위해 포함.

**수정 파일**: `claude-deep-work/commands/deep-research.md` (Phase 1 Research)

deep-work의 Phase 1 (Research) 시작 시:

```
Phase 1 추가 — Harnessability Context:

.deep-dashboard/harnessability-report.json이 존재하면:
1. 파일 읽기
2. 점수가 낮은 차원(< 5.0)을 research context에 포함:
   "이 프로젝트의 harnessability 진단 결과:
    - Type Safety: 3.2/10 → tsconfig strict 모드 활성화 고려
    - Test Infrastructure: 4.5/10 → 테스트 프레임워크 설정 우선
    이 작업에서 관련 영역을 개선할 수 있으면 함께 고려."
3. topology 감지 시 harnessability 낮은 차원을 topology template에 보강 제안으로 추가
```

이 변경은 deep-work의 Phase 1 research guide에 1개 조건 블록만 추가하면 되므로 최소 침습적.

---

### 3.5 deep-evolve → deep-work (메타 아카이브 기반 guide 강화)

**수정 파일**: `commands/deep-evolve.md` Section E.0 (Meta Archive Update) 직후

```
Section E.1: Cross-Plugin Feedback Export (선택적)

메타 아카이브의 effective_patterns 중 deep-work guide와 관련된 패턴이 있으면,
.deep-evolve/evolve-insights.json으로 내보낸다:

```json
{
  "updated_at": "2026-04-13T10:00:00Z",
  "insights_for_deep_work": [
    {
      "pattern": "guard_clause",
      "evidence": "keep_rate 0.35 across 3 projects",
      "suggestion": "Phase 3 implement 시 guard clause 패턴 우선 적용"
    }
  ],
  "insights_for_deep_review": [
    {
      "pattern": "error_handling",
      "evidence": "experiments targeting error handling had 60% keep rate",
      "suggestion": "review criteria에 error handling coverage 강화"
    }
  ]
}
```

deep-work의 Phase 1에서 이 파일이 있으면 research context로 소비.
deep-review의 init에서 이 파일이 있으면 rules.yaml 제안에 반영.
```

이 파일은 "제안" 수준이며, 각 플러그인이 소비 여부를 자체 판단한다.

---

## 구현 순서 및 체크리스트

### Phase 0 (즉시, ~30분)

- [x] `hooks/scripts/protect-readonly.sh:97` — grep 파이프 → AND 분리
- [x] `templates/prepare-stdout-parse.py:87-90` — minimize inversion 기본 로직 추가
- [x] `templates/prepare-stdout-parse.py` — `BASELINE_SCORE` 상수 자리 추가
- [x] `commands/deep-evolve.md` A.3 10단계 — baseline 측정 후 BASELINE_SCORE 기록 로직
- [x] `package.json:9` — repository URL → claude-deep-evolve
- [x] `.claude-plugin/plugin.json:8` — repository URL → claude-deep-evolve
- [x] `commands/deep-evolve.md` Step 5 — Judgment 로직을 "score 항상 higher-is-better"로 통일 (direction 분기 제거)
- [x] `templates/prepare-test-runner.py` — 동일한 scoring contract 적용
- [x] `templates/prepare-scenario.py` — 동일한 scoring contract 적용
- [x] `templates/prepare-protocol.md` — "score는 항상 higher-is-better" 명시
- [x] 테스트: minimize 방향 프로젝트에서 score 반전 + judgment 통합 동작 확인

### Phase 1 (Loop 2 완성, ~2-3시간)

- [x] `commands/deep-evolve.md` — Step 6.5 Meta Analysis 추가
- [x] `commands/deep-evolve.md` — meta-analysis.md 생성 로직
- [x] `commands/deep-evolve.md` — program.md 자동 개정 플로우
- [x] `hooks/scripts/protect-readonly.sh` — META_MODE 환경변수 지원
- [x] `commands/deep-evolve.md` — session.yaml program 버전 이력
- [x] `commands/deep-evolve.md` — results.tsv program 버전 구분선
- [x] SKILL.md 업데이트: "meta analysis", "전략 개선" 트리거 추가
- [x] README.md / README.ko.md 업데이트

### Phase 2 (자기 진화적 실험 루프, ~6-8시간)

**2-Tier 구조 (Core + Strategy):**
- [x] `commands/deep-evolve.md` — Core Protocol과 Strategy Layer 분리 설계
- [x] `commands/deep-evolve.md` — A.3 Scaffolding에 strategy.yaml 생성 로직 추가
- [x] strategy.yaml 스키마 정의 및 기본값 설정
- [x] `hooks/scripts/protect-readonly.sh` — strategy.yaml은 Outer Loop에서만 수정 가능하도록 보호 로직 추가

**Outer Loop (전략 진화):**
- [x] `commands/deep-evolve.md` — Outer Loop 세대 관리 로직 (Inner Loop N회 → meta analysis → 전략 조정)
- [x] `commands/deep-evolve.md` — 계층 1 (strategy.yaml 파라미터 자동 조정) 구현
- [x] `commands/deep-evolve.md` — 계층 2 (program.md 개정)는 Phase 1과 통합
- [x] `commands/deep-evolve.md` — 계층 3 (prepare.py 시나리오 자동 확장) — Section D를 자동 트리거로 전환
- [x] 메타 메트릭 Q(v) 계산 로직 (keep_rate, normalized_delta, crash_rate, idea_diversity)
- [x] Evaluation Epoch 분리: prepare.py 버전별 Q(v) 리셋 + epoch 네임스페이스
- [x] session.yaml에 evaluation_epoch 구조 추가 (current, history)
- [x] 전략 keep/discard 판정 로직 (Q(v) 비교)

**전략 아카이브 (Stepping Stones):**
- [x] `.deep-evolve/strategy-archive/` 디렉토리 구조 및 세대별 스냅샷 로직
- [x] 부모 선택 전략 구현 (score × exploration_penalty)
- [x] 정체 감지 → 전략 아카이브에서 분기 로직

**코드 아카이브 (Inner Loop 분기 탐색):**
- [x] `.deep-evolve/code-archive/` 구조 및 keep 커밋 기록 로직
- [x] `commands/deep-evolve.md` Section C Step 6 — 코드 분기 탐색 (backtrack) 로직
- [x] named branch 기반 keep 커밋 보존 및 분기 복원 (tag checkout 사용 금지)
- [x] session.yaml lineage 추적: 분기 시 current_branch, forked_from, previous_branches 기록
- [x] journal.jsonl에 branch_fork 이벤트 기록
- [x] 세션 종료 시 코드 아카이브 정리

**아이디어 앙상블:**
- [x] `commands/deep-evolve.md` Section C Step 1 — candidates_per_step 기반 아이디어 앙상블

**크로스 프로젝트 전이:**
- [x] `~/.claude/deep-evolve/` 디렉토리 생성 로직
- [x] meta-archive.jsonl 스키마 구현 (strategy_evolution 포함)
- [x] `commands/deep-evolve.md` A.2.5 — Meta Archive Lookup (LLM 기반 유사도 판단)
- [x] `commands/deep-evolve.md` E.0 — Meta Archive Update (기록 게이트 포함)
- [x] 전이 효과 간접 지표 (초기 keep rate, 채택률, Q 궤적 비교) 계산 로직
- [x] 아카이브 피드백 루프: 원본 항목의 transfer_success_rate 갱신

**아카이브 관리:**
- [x] meta-archive flock 기반 잠금 프로토콜 구현 (~/.claude/deep-evolve/meta-archive.lock)
- [x] 소프트 pruning 로직 (조회 시 제외 조건, flock 하에서 수행)
- [x] `/deep-evolve --archive-prune` 수동 정리 커맨드

**문서 업데이트:**
- [x] README — 자기 진화적 실험 루프 섹션 추가 (2-Tier, 3계층, 아카이브)
- [x] CHANGELOG 업데이트

### Phase 3 (크로스 플러그인, ~3-4시간)

**deep-evolve:**
- [ ] `commands/deep-evolve.md` Section E — evolve-receipt.json 생성 로직 (quality_score 공식 포함)
- [ ] `commands/deep-evolve.md` Section E — merge/PR 전 deep-review 트리거 제안
- [ ] `commands/deep-evolve.md` Section A.1 Stage 3 — recurring-findings.json 소비 로직
- [ ] `commands/deep-evolve.md` Section E.1 — evolve-insights.json 내보내기 로직

**deep-dashboard:**
- [ ] `lib/dashboard/collector.js` — `collectDeepEvolve()` 함수 추가
- [ ] `lib/dashboard/collector.js` — `collectData()` 반환값에 deepEvolve 추가
- [ ] `lib/dashboard/collector.test.js` — collectDeepEvolve 테스트 추가
- [ ] `lib/dashboard/effectiveness.js` — WEIGHTS에 evolve 차원 추가 (0.20), 기존 재분배
- [ ] `lib/dashboard/effectiveness.js` — `extractEvolveScore()` 함수 추가
- [ ] `lib/dashboard/effectiveness.test.js` — evolve 차원 테스트 추가
- [ ] `lib/dashboard/action-router.js` — ACTION_MAP에 evolve 항목 3건 추가
- [ ] `lib/dashboard/action-router.js` — `extractEvolveFindings()` 함수 추가
- [ ] `lib/dashboard/formatter.js` — evolve 섹션 포맷팅 (있으면)
- [ ] `lib/dashboard/collector.js` 주석 — Supported plugins에 deep-evolve 추가

**deep-review:**
- [ ] `commands/deep-review.md` — Stage 6.5 Recurring Findings Export 추가
- [ ] `.deep-review/recurring-findings.json` 스키마 정의

**deep-work (선택적):**
- [ ] `commands/deep-research.md` — Phase 1 Harnessability Context 추가
- [ ] `commands/deep-research.md` — evolve-insights.json 소비 로직 추가

**문서 업데이트:**
- [ ] deep-suite README — Plugin Data Flow 다이어그램에 deep-evolve 연결선 추가
- [ ] deep-suite README — Framework Coverage 표에 크로스 프로젝트 전략 전이 추가
- [ ] 각 플러그인 CHANGELOG 업데이트

---

## 변경하지 않는 것

다음은 이번 수정에서 의도적으로 건드리지 않는다:

- **Inner Loop의 기본 구조**: 실험 중 prepare.py 고정은 유지. 이것은 올바른 설계. HyperAgents도 domains/는 고정. Phase 2에서 Inner Loop에 코드 아카이브(분기 탐색)와 아이디어 앙상블이 추가되지만, 핵심 흐름(수정 → 평가 → keep/discard)은 변경하지 않음.
- **Docker 격리**: HyperAgents는 Docker를 쓰지만, Claude Code 플러그인은 git branch + worktree로 충분. 격리 수준을 올리는 것은 이 환경에서 오버엔지니어링.
- **부모 선택의 자기 수정**: HyperAgents는 select_next_parent.py를 에이전트가 수정할 수 있다. deep-evolve의 부모 선택 전략(exploration_penalty 공식)은 Core Protocol에 고정한다. 전략 아카이브의 "어떤 세대에서 분기할 것인가"는 공식으로 결정되며, 이 공식 자체는 진화 대상이 아님.
- **코드 레벨 앙상블**: HyperAgents의 ensemble.py(여러 에이전트의 출력을 결합)는 코드 수정 도메인에서 부적합 (코드는 단일 상태). 대신 판단 레벨 앙상블(아이디어 후보 다수 → 최선 선택)으로 대체.
- **Q(v) 계산 공식의 자기 수정**: Q(v)는 Core Protocol에 고정. 전략이 자기 평가 기준을 조작하는 것을 방지 (Goodhart 방지, prepare.py 고정과 동일 원칙).
- **deep-wiki, deep-docs 코드**: 이번 변경에서 직접 수정하지 않음.
- **deep-work의 hooks, sensors 코드**: Phase 3에서 deep-work는 commands/deep-research.md에 조건 블록 1개만 추가.
- **deep-dashboard의 harnessability scorer**: 기존 6차원 점수 체계는 유지. evolve는 effectiveness 쪽에만 추가.

---

## 성공 기준

Phase 1 완료 시:
- 20회 inner loop 이후 meta analysis가 실행되어 program.md가 자동 개정됨
- 개정 후 keep_rate가 개정 전보다 측정 가능하게 개선됨 (목표: +5%p 이상)

Phase 2 완료 시:
- **2-Tier 구조**: Outer Loop가 Inner Loop 20회마다 자동 발동하여 전략을 조정함
- **3계층 진화**: strategy.yaml 파라미터 + program.md 텍스트 + prepare.py 시나리오가 자동 진화함
- **Q(v) 검증**: 전략 변경이 Q(v) 기준으로 keep/discard되어, 전략 품질이 측정 가능하게 개선됨
- **전략 아카이브**: 정체 시 이전 세대의 전략에서 분기하여 local optima를 회피함
- **코드 아카이브**: Inner Loop에서 정체 시 이전 keep 커밋에서 분기하여 다른 방향 탐색 가능
- **아이디어 앙상블**: candidates_per_step으로 아이디어 선택 품질이 향상됨
- **크로스 프로젝트 전이**: 두 번째 프로젝트에서 첫 번째 프로젝트의 strategy.yaml + program.md가 전이되어 초기 탐색 효율이 개선됨
- **자기 진화 입증**: 동일 프로젝트에서 Outer Loop 세대 1→4로 진행 시 Q(v)가 단조 증가함

Phase 3 완료 시:
- `/deep-harness-dashboard` 실행 시 evolve 차원이 effectiveness 점수에 포함됨
- deep-evolve 완료 후 merge 시 deep-review 트리거 제안이 표시됨
- deep-review에서 3회 이상 발견된 패턴이 recurring-findings.json에 기록됨
- 다음 `/deep-evolve` 세션에서 recurring findings가 program.md에 자동 반영됨
- deep-suite README의 Plugin Data Flow 다이어그램에 deep-evolve가 양방향으로 연결됨
