[English](./README.md) | **한국어**

# deep-evolve

> Claude Code · Codex용 자율 실험 플러그인 — 목표를 지정하면 deep-evolve가 측정 기반 실험 루프를 통해 프로젝트를 체계적으로 개선합니다.

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/claude-deep-evolve?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/claude-deep-evolve)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/claude-deep-suite)

deep-evolve는 AI 에이전트에게 코드베이스와 fitness 메트릭을 주고 자율적으로 실험하게 합니다 — 코드를 수정하고, 결과를 평가하고, 개선은 유지하고, 회귀는 폐기하며 — 목표가 달성되거나 수익이 감소할 때까지 반복합니다. 프로젝트에 맞춘 평가 harness를 생성하고, 전용 브랜치에서 crash-safe한 journal 기반 실험 루프를 실행하며, 실험 **전략** 자체를 시간에 따라 진화시킬 수 있습니다.

## deep-suite에서의 역할

deep-evolve는 [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite)의 자율 실험 담당 플러그인입니다. 표준 [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) 피드포워드/피드백 루프 **밖에서** 동작합니다: 일반 개발 과정의 안내·감지 대신, 어떤 가이드나 센서도 제안하지 않을 개선점을 자동화된 실험으로 발견하며 자체적인 실험 → 평가 → 유지/폐기 사이클을 따릅니다. deep-review의 recurring findings를 소비해 실험 방향을 잡고, deep-dashboard와 deep-work가 소비하는 receipt/insights를 emit합니다.

## 영감

deep-evolve는 Andrej Karpathy의 [autoresearch](https://github.com/karpathy/autoresearch)에서 영감을 받았습니다 — AI 에이전트에게 코드베이스를 주고 밤새 실험하게 한 뒤 아침에 더 나은 프로젝트를 확인하는, 자율 연구 실험입니다. 자기 진화 아키텍처는 [HyperAgents](https://arxiv.org/abs/2603.19461)에서 비롯됐습니다 — 대상 코드뿐 아니라 메타 학습으로 자체 전략을 진화시키는 에이전트입니다. 동작 레이어(entropy 추적, legibility gate, shortcut detection, diagnose-and-retry)는 Wen et al. 2026, "Automated Weak-to-Strong Researcher"를 따릅니다. deep-evolve는 이 방법론을 ML 훈련에서 **모든 소프트웨어 프로젝트**로 일반화합니다.

## 설치

### Deep Suite 마켓플레이스 (권장)

```bash
# Claude Code
/plugin marketplace add Sungmin-Cho/claude-deep-suite
/plugin install deep-evolve@claude-deep-suite

# Codex
codex plugin install deep-evolve
```

### 단독 설치

```bash
/plugin marketplace add Sungmin-Cho/claude-deep-evolve
/plugin install deep-evolve@Sungmin-Cho-claude-deep-evolve
```

저장소에는 Claude Code manifest(`.claude-plugin/plugin.json`)와 Codex 네이티브 manifest(`.codex-plugin/plugin.json`)가 함께 포함됩니다. Codex 프로젝트 가이드는 [`AGENTS.md`](AGENTS.md)를 참조하세요. Claude Code에서는 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)가 필요합니다.

지원 실행 환경은 macOS, Linux, 네이티브 Windows 11의 Node 22입니다.
Windows 경로에는 Git Bash나 Python이 필요하지 않습니다. 레거시 세션은 재개할
때 기록된 실험 이력을 보존한 채 마이그레이션됩니다.

## 빠른 시작

```bash
# 새 세션 시작 (대화형 목표/대상 선택)
/deep-evolve

# 이번 배치에서 N개 실험 실행
/deep-evolve 50

# 특정 목표로 시작
/deep-evolve "minimize val_bpb"

# 중단된 세션 재개
/deep-evolve resume

# 세션 이력 / lineage tree 보기
/deep-evolve history
/deep-evolve history --lineage

# Virtual parallel 탐색
/deep-evolve --no-parallel               # 단일 seed 강제 (N=1)
/deep-evolve --n-min=2 --n-max=5         # AI의 N 결정 범위 좁히기
/deep-evolve --kill-seed=<seed_id>       # 세션 중 seed 은퇴
/deep-evolve --status                    # per-seed 대시보드 (읽기 전용)
```

Codex는 동일한 공개 워크플로우를 `$deep-evolve:deep-evolve`와 같은 인자
문자열로 호출합니다(예: `$deep-evolve:deep-evolve resume`). Claude Code는
위의 slash 호출을 그대로 사용합니다.

## 방법론

### 중요한 세 가지 파일

방법론은 엄격한 관심사 분리를 중심으로 합니다:

- **평가 harness** — 고정된 ground truth. 실험 중 에이전트가 절대 수정하지 않습니다. 두 형태: `prepare.cjs`와 `prepare.config.json`(CLI 메트릭), 또는 `prepare-protocol.md`(사용자가 제공한 고정 도구 프로토콜).
- **대상 파일** — 개선 대상 코드. 아키텍처, 파라미터, 로직, 패턴 등 메트릭을 올바른 방향으로 움직이는 모든 것이 대상.
- **`program.md`** — 에이전트 지침: 목표, 제약, 실험 전략. 인간은 코드가 아닌 프로세스를 프로그래밍합니다.

### 실험 루프

각 실험은 동일 사이클을 따르며, 중단될 때까지 자율적으로 진행됩니다: 아이디어 선택(이전 keep/discard 이력 학습) → 코드 수정(커밋당 1 아이디어, 대상 파일만) → 평가(harness 실행, score 획득) → 비교 → score가 개선되면 **keep**, 아니면 **discard**(`git reset --hard HEAD~1`). 목표 달성 또는 수익 감소까지 반복.

### 하나의 메트릭, 하나의 진실

모든 실험은 단일 합성 score로 판단되어 모호성을 제거합니다:

- **score 개선** → 아무리 작아도 keep.
- **score 동일 또는 악화** → 아무리 영리한 아이디어여도 discard.
- **crash** → discard, 실패 기록, 다음으로.

메트릭은 측정 가능한 어떤 것이든 가능합니다 — validation loss, test pass rate, Sharpe ratio, 시나리오 커버리지 — 단 **실험 중 고정**되어야 합니다. 움직이는 목표는 최적화할 수 없습니다.

### 간결함 기준

다른 조건이 같다면 단순한 쪽이 낫습니다. 추한 복잡성을 더하는 작은 개선은 가치가 없고, 동등하거나 더 나은 결과를 내며 코드를 제거하는 것은 승리입니다.

> 20줄의 hacky 코드를 더하는 0.001 개선? 아마 가치 없음.
> 코드를 삭제하는 0.001 개선? 반드시 keep.
> 개선은 ~0이지만 훨씬 단순한 코드? Keep.

### 감소 수익

실험은 감소 수익 곡선을 따릅니다. deep-evolve는 이를 자동 감지합니다: 최근 10개 실험이 개선을 내지 못하면 계속할지, 더 어려운 시나리오로 평가 harness를 확장할지, 멈출지 묻습니다.

### 자기 진화

deep-evolve는 대상 코드만 개선하는 것이 아니라, 개선하는 프로세스 자체를 세 계층에서 진화시킵니다:

| 계층 | 파일 | 진화 대상 | 방법 |
|---|---|---|---|
| 파라미터 | `strategy.yaml` | mutation rate, focus areas, idea bank | Outer Loop가 epoch마다 변이 |
| 전략 텍스트 | `program.md` | 에이전트 지침, 실험 접근법 | 수렴 시 자동 개정 |
| 평가 | `prepare.cjs` + `prepare.config.json` | 시나리오, 난이도, 커버리지 | plateau 시 자동 트리거 |

**Inner Loop**는 현재 `strategy.yaml`로 실험을 실행하고, **Outer Loop**는 각 epoch 후 개선 속도 Q(v)를 측정하여 전략을 변이시킵니다. 우수 전략은 stepping stone으로, 코드 상태는 이름 지정 git 브랜치로 아카이브되며, 검증된 전략은 런타임이 원자적으로 관리하는 meta-archive를 통해 프로젝트 간 전이됩니다.

### Virtual parallel 탐색

한 세션은 N=1–9개 독립 seed worktree를 적응형 스케줄러로 병렬 실행할 수 있습니다. seed들은 공유 forum을 통해 서로를 관찰하고 유망한 아이디어를 차용하며, 세션 종료 시 synthesis가 per-seed 결과를 cascade-fallback baseline 선택으로 단일 best 브랜치에 병합합니다.

## deep-evolve 작동 방식

1. **프로젝트 분석** — 5단계 심층 분석(구조 스캔, 의존성/도구, 코드 심층 읽기, 실제 eval 명령 실행을 통한 메트릭 검증, 확인). 모든 판단은 실제 파일 읽기에 근거합니다.
2. **평가 harness 생성** — deep-evolve가 CLI 또는 프로토콜 모드로 프로젝트에 맞춘 harness를 생성합니다. 두 모드 모두 동일한 `score: X.XXXXXX` 형식을 출력하여 루프를 도메인 독립적으로 만듭니다.
3. **자율 실험 루프** — 현재 세션에서 실행되며, state를 원자적으로 journaling(crash-safe)하고, 전용 브랜치에 커밋하며, 모든 롤백 전 브랜치/worktree 안전성을 검증합니다.
4. **세션 간 재개** — 언제든 중단하고 `/deep-evolve`를 다시 실행하면 활성 세션을 감지하고 integrity check 후 이어서 진행합니다.
5. **완료 보고서** — 실험 통계, score 진행, 핵심 발견, 폐기 실험에서의 교훈을 제공한 뒤 main 병합 / PR 생성 / 브랜치 유지 / 폐기를 묻습니다.

## 지원 도메인

**CLI 모드 (`prepare.cjs` + `prepare.config.json`):**

| 도메인 | 평가자 | 예시 메트릭 |
|---|---|---|
| ML / 훈련 | stdout 메트릭 파싱 | val_bpb, loss, accuracy, perplexity |
| 테스트 | test pass rate + coverage | jest, pytest, vitest, cargo test, go test |
| 코드 품질 | 커스텀 test 시나리오 | 보안 패턴, hook 신뢰성, lint 규칙 |
| 전략 최적화 | 백테스트 결과 | Sharpe ratio, max drawdown, 합성 score |

**프로토콜 모드 (`prepare-protocol.md`):**

| 도메인 | 평가 도구 | 예시 메트릭 |
|---|---|---|
| 게임 엔진 | Unity / Unreal MCP | replay accuracy, frame time, test pass rate |
| GUI 앱 | 브라우저/앱 자동화 | UI state match rate, accessibility score |
| 외부 시스템 | MCP/HTTP 호출 | API accuracy, pipeline success rate |

프로토콜 모드는 CLI로 평가할 수 없는 프로젝트(게임 엔진, GUI 앱, 외부 런타임 의존성)를 평가합니다. 호스트를 통해 사용자가 제공한 도구를 실행하며 deep-evolve는 MCP 서버를 번들하지 않습니다. 적절한 모드는 프로젝트 분석 중 자동으로 추천됩니다.

## 링크

- [변경 이력](CHANGELOG.ko.md) ([English](CHANGELOG.md)) — 릴리스 이력
- [Deep Suite 마켓플레이스](https://github.com/Sungmin-Cho/claude-deep-suite)
- [기여 가이드](CONTRIBUTING.md) · [보안 정책](SECURITY.md)

## 라이선스

[MIT](LICENSE)
