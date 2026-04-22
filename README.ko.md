[English](./README.md) | **한국어**

# deep-evolve

Claude Code용 자율 실험 플러그인. 목표를 지정하면 deep-evolve가 측정 기반 실험 루프를 통해 프로젝트를 체계적으로 개선합니다.

## 영감

이 프로젝트는 Andrej Karpathy의 [autoresearch](https://github.com/karpathy/autoresearch)에서 영감을 받았습니다 — AI 에이전트가 자율적으로 연구를 수행하는 실험입니다. 핵심 아이디어: AI 에이전트에게 코드베이스를 주고, 밤새 실험하게 하고 — 코드를 수정하고, 결과를 평가하고, 개선은 유지하고, 회귀는 폐기하고 — 아침에 더 나은 프로젝트를 확인합니다.

자기 진화 아키텍처(v2.0)는 [HyperAgents](https://arxiv.org/abs/2603.19461)에서 영감을 받았습니다 — 대상 코드뿐 아니라 메타 학습을 통해 자체 전략을 진화시키는 에이전트입니다.

deep-evolve는 이 방법론을 ML 훈련에서 **모든 소프트웨어 프로젝트**로 일반화하여, 자동 평가 harness 생성, journal 기반 crash recovery, 다중 도메인 템플릿 지원, 자기 진화 전략 발전을 갖춘 Claude Code 플러그인으로 패키징했습니다.

### 하네스 엔지니어링에서의 역할

deep-evolve는 표준 [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) 프레임워크 **밖에서** 동작합니다 — 측정 기반 실험 루프를 통해 코드를 반복적으로 개선하는 자율 실험 프로토콜입니다. 프레임워크가 일반 개발 과정에서의 안내와 감지에 집중하는 반면, deep-evolve는 어떤 가이드나 센서도 제안하지 않을 개선점을 자동화된 실험으로 발견하는 보완적 접근법입니다. [Deep Suite](https://github.com/Sungmin-Cho/claude-deep-suite) 생태계의 일부이지만 자체적인 실험→평가→유지/폐기 사이클을 따릅니다.

v2.0의 Outer Loop로 deep-evolve는 한 단계 더 나아갑니다: 대상 코드뿐 아니라 실험을 이끄는 **전략** 자체를 진화시키고, 수렴이 감지되면 **평가 harness** 자체를 확장할 수도 있습니다. 이 3계층 자기 진화(파라미터 → 전략 텍스트 → 평가 확장)는 시스템을 자체 개선 프로세스를 개선하는 진정한 메타 옵티마이저로 만듭니다.

## 3.0.0 신규 기능

AAR 논문에서 영감 받은 4개 동작 레이어를 Inner/Outer Loop에 추가. v3 세션에서만
활성화 — v2.2.2 세션은 기존 코드 경로 그대로 유지.

- **Idea-category entropy 추적** — 10 카테고리 taxonomy + Outer Loop마다
  Shannon entropy 계산. Tier 1 overlay로 탐험 collapse 방지.
- **Legibility Gate** — 모든 `kept` 이벤트에 rationale 강제. Flagged keep은
  빈값 또는 description과 동일 시 discard로 전환.
- **Shortcut Detector** — 작은 코드 변경으로 큰 score jump 발생 시 flag.
  누적 3회 시 Section D prepare 확장 강제 발화, flagged commit의 diff를
  기반으로 한 adversarial scenarios로 재생성.
- **Diagnose-and-Retry** — crash / severe drop / 에러 키워드 시 1회 복구
  재시도. 세션 상한 10회. Per-experiment 재시도 journal replay로 1회 강제.

참고: Wen et al. 2026, "Automated Weak-to-Strong Researcher" (Anthropic Alignment Science Blog).

## 자기 진화 실험 루프 (v2.0)

v2.0은 시스템이 대상 코드뿐 아니라 실험을 이끄는 **전략** 자체를 진화시키는 자기 진화 아키텍처를 도입합니다.

### 2계층 구조: Outer Loop + Inner Loop

```
┌─────────────────────────────────────────────────────────────┐
│  Outer Loop (전략 진화)                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  strategy.yaml: 진화 가능한 전략 파라미터              │    │
│  │  (mutation_rate, idea_bank, focus_areas, ...)       │    │
│  └───────────────────┬─────────────────────────────────┘    │
│                      ▼                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Inner Loop (실험 실행)                               │    │
│  │  현재 전략으로 N회 실험 실행                            │    │
│  │  → Q(v) 메타 메트릭 측정                               │    │
│  └───────────────────┬─────────────────────────────────┘    │
│                      ▼                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  전략 평가 & 진화                                     │    │
│  │  Q(v) = (best_score - baseline) / experiments_used  │    │
│  │  → 다음 outer 반복을 위해 strategy.yaml 변이           │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

- **Inner Loop**: 기존 실험 사이클 — 코드 수정, 평가, 유지/폐기. 이제 `strategy.yaml` 파라미터에 의해 구동됩니다.
- **Outer Loop**: 전략 자체를 진화시킵니다. 각 inner loop 에포크 후 **Q(v)**(개선 속도)를 측정하고 전략 파라미터를 변이시켜 더 나은 실험 접근법을 탐색합니다.

### 3계층 자기 진화

deep-evolve는 세 가지 계층에서 동시에 진화합니다:

| 계층 | 파일 | 진화 대상 | 방법 |
|------|------|----------|------|
| **파라미터** | `strategy.yaml` | 변이율, 집중 영역, 아이디어 뱅크 | Outer Loop가 에포크마다 변이 |
| **전략 텍스트** | `program.md` | 에이전트 지침, 실험 접근법 | Meta Analysis가 수렴 시 자동 개정 |
| **평가** | `prepare.py` | 시나리오, 난이도, 커버리지 | Section D가 고원에서 자동 트리거 |

### 전략 & 코드 아카이브 (Stepping Stones)

새로운 최고 Q(v)를 달성한 모든 전략은 **stepping stone**으로 아카이브됩니다:

- **전략 아카이브**: Q(v) 점수와 계보가 포함된 `strategy.yaml` 스냅샷을 저장합니다. 새 전략은 최신 것뿐 아니라 고성능 부모에서 육성됩니다.
- **코드 아카이브**: 이름이 지정된 git 브랜치(`archive/<name>`)가 최고 점수 코드 상태를 보존합니다. 새 전략 방향이 실패하면 아카이브된 상태로 되돌아갈 수 있습니다.
- **아이디어 앙상블**: 각 실험은 점수가 매겨지고 순위가 매겨진 여러 후보 아이디어에서 선택합니다. 아이디어 생성의 단일 실패점을 방지합니다.

### 크로스 프로젝트 전이

한 프로젝트에서 잘 작동한 전략은 다른 프로젝트로 전이할 수 있습니다:

- **메타 아카이브** (`~/.claude/deep-evolve/meta-archive.jsonl`): 모든 프로젝트에 걸친 검증된 전략의 공유, flock 보호 아카이브입니다.
- 새 프로젝트를 시작할 때, deep-evolve는 프로젝트 도메인 유사성으로 필터링된 메타 아카이브에서 초기 전략을 씨앗으로 사용합니다.
- 성공한 전략은 각 세션 후 메타 아카이브에 기여됩니다.

### 크로스 플러그인 피드백 (v2.1)

deep-evolve는 deep-suite 내 다른 플러그인과 양방향 데이터를 교환한다:

**내보내기 (Producer):**
- `evolve-receipt.json` → deep-dashboard가 수집하여 effectiveness 점수에 evolve 차원 반영
- `evolve-insights.json` → deep-work Phase 1 Research에서 참고 context로 소비
- merge/PR 전 deep-review 트리거 제안 (APPROVE/REQUEST_CHANGES/FAILURE 처리)

**소비 (Consumer):**
- `.deep-review/recurring-findings.json` → init Stage 3.5에서 읽어 실험 방향 조향 (prepare.py 시나리오 + program.md + strategy.yaml 가중치 조정)

### 세션 관리 (v2.2)

deep-evolve는 `.deep-evolve/<session-id>/` 네임스페이스에서 세션을 관리하며, 모든 실험 데이터를 세션 간 보존합니다.

- **세션 생명주기 (v2.2.2)**: `initializing` (baseline 측정/writeback) → `active` (inner loop) → `paused` (outer loop 실행 중) → `active` → `completed` / `aborted`.
- **재개 (Resume)**: 언제든 중단하세요. `/deep-evolve`를 다시 실행하면 활성 세션을 감지하고, 무결성 검사(브랜치 정렬, dirty tree, orphan 실험)를 수행한 후 이어서 진행합니다. Outer Loop 재개는 **phase 단위 idempotent**: 각 sub-step이 journal 이벤트(`outer_loop`, `strategy_update`, `strategy_judgment`, `notable_marked`, `program_skip`)로 식별되며, 이미 완료된 단계는 스킵됩니다 (v2.2.2).
- **Baseline 계약 (v2.2.2)**: minimize 방향 메트릭은 init 중 writeback되어 모든 세션에서 `session.yaml.metric.baseline == 1.0`이 보장됩니다. 모든 하류 비교(`improvement_pct`, Q(v) `normalized_delta`, archive 점수)가 공통 스케일을 공유합니다.
- **이력 (History)**: `/deep-evolve history`로 현재 프로젝트의 모든 세션을 조회합니다. 실험 횟수, keep rate, Q 궤적, score 개선을 한눈에 확인할 수 있습니다.
- **세션 계보 (Lineage)**: 새 세션은 완료된 세션을 이어받아 최종 전략, 프로그램, notable keep을 시작 컨텍스트로 상속합니다. Inherited Context(전략 패턴, 주목할 발견, 선행 세션의 교훈)가 새 세션의 `program.md`에 자동 삽입됩니다. `/deep-evolve history --lineage`로 계보를 확인할 수 있습니다.

## 방법론

### 중요한 세 가지 파일

autoresearch 방법론은 엄격한 관심사 분리를 중심으로 합니다:

```
┌─────────────────────────────────────────────────────┐
│  평가 harness  — 고정된 평가 인프라                    │
│                  Ground truth. 실험 중                │
│                  에이전트가 절대 수정하지 않음.           │
│                                                     │
│  두 가지 형태:                                        │
│  • prepare.py          — CLI 명령으로 메트릭 획득      │
│  • prepare-protocol.md — MCP/도구 기반 평가 프로토콜   │
├─────────────────────────────────────────────────────┤
│  target files  — 개선 대상 코드                       │
│                  모든 것이 수정 가능:                   │
│                  아키텍처, 파라미터, 로직,               │
│                  패턴 — 메트릭을 올바른 방향으로          │
│                  움직이는 모든 것.                      │
├─────────────────────────────────────────────────────┤
│  program.md    — 에이전트를 위한 지침                   │
│                  목표, 제약, 실험 전략을 정의.           │
│                  "Research org code" — 사람은           │
│                  코드가 아닌 프로세스를 프로그래밍.        │
└─────────────────────────────────────────────────────┘
```

### 실험 루프

각 실험은 동일한 사이클을 따릅니다. 에이전트는 허락을 구하지 않고 중단될 때까지 자율적으로 실행됩니다.

```
    ┌──────────────┐
    │  아이디어 선정  │ ← 이전 keep/discard 이력에서 학습
    └──────┬───────┘
           ▼
    ┌──────────────┐
    │  코드 수정     │ ← 커밋당 하나의 아이디어, target 파일만
    └──────┬───────┘
           ▼
    ┌──────────────┐
    │    평가       │ ← prepare.py 실행, score 획득
    └──────┬───────┘
           ▼
    ┌──────────────┐
    │    비교       │ ← Score가 개선되었는가?
    └──┬───────┬───┘
       │       │
      예      아니오
       │       │
       ▼       ▼
    ┌──────┐ ┌──────────┐
    │ 유지  │ │  폐기     │ ← git reset --hard HEAD~1
    └──┬───┘ └────┬─────┘
       │          │
       └────┬─────┘
            ▼
    ┌──────────────┐
    │    반복       │ ← 목표 달성 또는 감소 수익까지
    └──────────────┘
```

### 하나의 메트릭, 하나의 진실

모든 실험은 단일 복합 점수로 판단됩니다. 모호함이 없습니다:

- **Score 개선** → 아무리 작아도 변경 유지
- **Score 동일 또는 하락** → 아무리 영리한 아이디어였어도 폐기
- **Crash** → 폐기, 실패 기록, 다음으로 이동

메트릭은 측정 가능한 무엇이든 될 수 있습니다: validation loss, 테스트 통과율, Sharpe ratio, 시나리오 커버리지. 중요한 것은 **실험 중에 고정**되어 있다는 것 — 움직이는 표적을 최적화할 수 없습니다.

### 간결함 기준

동일 조건이라면 더 단순한 것이 좋습니다. 복잡성을 추가하는 작은 개선은 가치가 없습니다. 반대로 코드를 제거하고 동일하거나 더 나은 결과를 얻는 것은 훌륭한 성과 — 단순화 승리입니다.

> 0.001 개선에 20줄의 해킹 코드? 아마 가치 없음.
> 코드 삭제로 0.001 개선? 반드시 유지.
> ~0 개선이지만 훨씬 단순한 코드? 유지.

### 감소 수익

실험은 자연스럽게 감소 수익 곡선을 따릅니다:

```
Score
  ▲
  │    ╱──────────────────  ← 고원 (수렴)
  │   ╱
  │  ╱    ← 급격한 개선
  │ ╱
  │╱
  └──────────────────────► 실험 횟수
```

deep-evolve는 이를 자동으로 감지합니다. 최근 10회 실험에서 개선이 없으면: 계속할지, 평가 harness를 더 어려운 시나리오로 확장할지, 여기서 멈출지 물어봅니다.

### 이력에서 학습

에이전트는 매 실험 전 `results.tsv`를 읽습니다. 무엇이 효과가 있었고 없었는지 학습합니다:

```
commit   score      status    description
abc1234  0.921053   keep      perl -pi -e 파일 쓰기 패턴 추가
def5678  0.921053   discard   node -e safe 패턴 축소 (단독으로 불충분)
ghi9012  0.973684   keep      런타임 언어 파일 쓰기 패턴 추가
```

폐기된 접근법은 반복하지 않습니다. 에이전트는 축적된 증거를 기반으로 전략을 진화시킵니다.

## deep-evolve 작동 방식

### 1. 프로젝트 분석

`/deep-evolve`를 실행하면 플러그인이 프로젝트를 5단계로 정밀 분석합니다:

1. **구조 스캔** — 파일 트리, 언어, 프레임워크, 진입점
2. **의존성 & 도구** — 패키지 매니저, 테스트 프레임워크, 린터, CI/CD
3. **코드 심층 분석** — 모든 대상 파일을 완전히 읽고 아키텍처 이해
4. **메트릭 검증** — 실제로 평가 명령 실행, 출력 파싱, 시간 측정
5. **확인** — 사용자에게 분석 결과 제시 후 진행

추측 금지 — 모든 판단은 실제 파일 읽기에 근거합니다.

### 2. 평가 Harness 생성

분석을 기반으로 프로젝트에 맞는 평가 harness를 생성합니다:

**CLI 모드** (`prepare.py`):

| 도메인 신호 | 템플릿 | 예시 |
|---|---|---|
| stdout에 파싱 가능한 메트릭 | stdout-parse | ML 훈련 (val_bpb), 백테스팅 (Sharpe ratio) |
| 테스트 프레임워크 감지 | test-runner | jest, pytest, vitest, cargo test, go test |
| 코드 품질 / 패턴 목표 | scenario-based | 플러그인 hook, 보안 패턴, lint 규칙 |

**프로토콜 모드** (`prepare-protocol.md`):

| 도메인 신호 | 평가 도구 | 예시 |
|---|---|---|
| 게임 엔진 프로젝트 | MCP 서버 | Unity 리플레이 검증, Unreal 자동화 |
| GUI/데스크톱 앱 | 브라우저/앱 자동화 | UI 상태 검증, 접근성 테스트 |
| 외부 런타임 의존 | MCP/HTTP 호출 | 데이터 파이프라인, 하드웨어 테스트 |

두 모드 모두 동일한 `score: X.XXXXXX` 형식으로 출력하여 실험 루프가 도메인 독립적으로 작동합니다.

### 3. 자율 실험 루프

루프는 현재 Claude Code 세션에서 실행됩니다. 각 실험은:
- 상태를 원자적으로 journal에 기록 (crash-safe recovery)
- 전용 branch에서 커밋 (main은 깨끗하게 유지)
- 매 rollback 전 branch와 worktree 안전성 검증

### 4. 세션 간 재개

언제든 중단하세요. 나중에 `/deep-evolve`를 다시 실행하면 활성 세션을 감지하고, 진행 상황을 보여주고, 중단된 곳에서 이어갑니다. journal 기반 상태 머신이 crash 후에도 작업 손실을 방지합니다.

### 5. 완료 보고서

완료 시 deep-evolve는 보고서를 생성합니다:
- 실험 통계와 score 변화
- 평가 harness 버전별 감소 수익 곡선
- 영향도순 핵심 발견 사항
- 폐기된 실험에서 얻은 교훈

그 후 선택: main에 merge, PR 생성, branch 유지, 또는 폐기?

## 빠른 시작

```bash
# 새 세션 시작 (대화형 목표/대상 선택)
/deep-evolve

# 50회 실험 실행
/deep-evolve 50

# 특정 목표로 시작
/deep-evolve "val_bpb 최소화"

# 중단된 세션 재개
/deep-evolve resume

# 세션 이력 조회
/deep-evolve history

# lineage tree 표시
/deep-evolve history --lineage
```

## 지원 도메인

### CLI 모드 (prepare.py)

| 도메인 | 평가기 | 메트릭 예시 |
|--------|--------|------------|
| ML / 학습 | stdout 메트릭 파싱 | val_bpb, loss, accuracy, perplexity |
| 테스팅 | 테스트 통과율 + 커버리지 | jest, pytest, vitest, cargo test, go test |
| 코드 품질 | 커스텀 테스트 시나리오 | 보안 패턴, hook 신뢰성, lint 규칙 |
| 전략 최적화 | 백테스트 결과 | Sharpe ratio, max drawdown, composite score |

### 프로토콜 모드 (prepare-protocol.md)

| 도메인 | 평가 도구 | 메트릭 예시 |
|--------|----------|------------|
| 게임 엔진 | Unity MCP, Unreal MCP | 리플레이 정확도, 프레임 타임, 테스트 통과율 |
| GUI 앱 | 브라우저/앱 자동화 | UI 상태 일치율, 접근성 점수 |
| 외부 시스템 | MCP/HTTP 호출 | API 정확도, 파이프라인 성공률 |

프로토콜 모드는 CLI로 평가할 수 없는 프로젝트에서 MCP 서버, 브라우저 자동화, 외부 API 등을 통해 평가합니다. 프로젝트 분석 시 적절한 모드가 자동 추천됩니다.

## 설치

### 사전 요구사항

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 설치 및 설정 완료

### Deep Suite 마켓플레이스 (권장)

```bash
# 1. 마켓플레이스 추가
/plugin marketplace add Sungmin-Cho/claude-deep-suite

# 2. 플러그인 설치
/plugin install deep-evolve@Sungmin-Cho-claude-deep-suite
```

### 단독 설치

```bash
# 1. 이 레포를 마켓플레이스로 추가
/plugin marketplace add Sungmin-Cho/claude-deep-evolve

# 2. 설치
/plugin install deep-evolve@Sungmin-Cho-claude-deep-evolve
```

## 라이선스

MIT
