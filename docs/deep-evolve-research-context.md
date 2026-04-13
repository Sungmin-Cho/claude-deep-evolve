# Deep-Evolve Self-Evolutionary Architecture — Research Context

이 문서는 deep-evolve의 자기 진화적 구조 확장을 위한 배경 리서치를 정리한다. Claude Code에서 작업 시 이 문서를 맥락으로 참조한다.

---

## 1. 계보: autoresearch → deep-evolve → HyperAgent 구조

### 1.1 autoresearch (Karpathy, 2026.03)

- Repo: https://github.com/karpathy/autoresearch
- 파일 3개가 전부:
  - `prepare.py` — 고정 평가 harness (데이터, 토크나이저, evaluate_bpb)
  - `train.py` — 에이전트가 수정하는 유일한 파일
  - `program.md` — 사람이 작성하는 에이전트 지시사항
- 단일 도메인: LLM 훈련 (val_bpb minimize)
- 핵심 루프: 수정 → 5분 훈련 → 개선? keep : git reset → 반복
- "NEVER STOP" — 사람이 자는 동안 ~100회 실험
- 자기 참조 없음, 아카이브 없음, program.md는 사람만 수정

### 1.2 deep-evolve (현재)

- Repo: https://github.com/Sungmin-Cho/claude-deep-evolve
- autoresearch를 Claude Code 플러그인으로 일반화:
  - 3종 prepare.py 템플릿 (stdout-parse, test-runner, scenario) + protocol 모드
  - 다중 target 파일, 다중 도메인 (ML/테스트/코드품질/게임엔진 등)
  - AI가 프로젝트 분석 후 prepare.py와 program.md 자동 생성
  - journal.jsonl 기반 크래시 복구, session.yaml 상태 머신
  - protect-readonly.sh PreToolUse 훅으로 실험 중 eval harness 보호
- 한계: autoresearch와 동일하게 **메타 레벨 고정** — prepare.py, program.md, 실험 전략이 진화하지 않음

### 1.3 HyperAgents (Meta, 2026.03)

- Paper: https://arxiv.org/abs/2603.19461
- Repo: https://github.com/facebookresearch/HyperAgents
- DGM(Darwin Gödel Machine)을 확장한 자기 참조적 자기 개선 에이전트
- 핵심 구조:
  - `meta_agent.py` (18줄) — "Modify any part of the codebase" 한 줄 지시 + LLM tools
  - `task_agent.py` (44줄) — 태스크 수행 스텁
  - `select_next_parent.py` (57줄) — 아카이브 기반 부모 선택
  - `ensemble.py` (43줄) — 앙상블 전략
  - `generate_loop.py` (1189줄) — Docker 기반 진화 루프 오케스트레이션
  - `domains/` — 고정 평가 하네스 (paper_review, genesis, imo, polyglot 등)

#### HyperAgents의 핵심 설계 원칙

1. **수정 가능 vs 고정의 분리**: meta_agent.py, task_agent.py, ensemble.py, select_next_parent.py는 수정 가능. domains/와 generate_loop.py는 고정.

2. **자기 참조**: meta_agent.py가 repo_path 안에 있으므로 자기 자신의 코드를 수정할 수 있음. "metacognitive self-modification" — 개선하는 방법 자체를 개선.

3. **아카이브 기반 탐색**: 모든 유효한 변형을 "stepping stones"로 보존. 최적만 남기는 게 아니라 다양성을 유지하여 local optima 회피.

4. **Docker 격리**: 세대(generation)마다 컨테이너 생성 → diff 적용 → meta agent 실행 → 평가 → 정리. 모델 생성 코드의 안전한 실행 보장.

5. **크로스 도메인 전이**: meta-level 개선이 도메인을 넘어 전이됨 (논문 리뷰에서 학습한 메타 전략이 수학 채점에서 imp@50=0.630 달성, 반면 hand-crafted DGM은 0.0).

#### HyperAgents가 자율적으로 진화시킨 하네스 컴포넌트

코딩, 논문 리뷰, 로보틱스, 수학 채점 도메인에서 명시적 지시 없이 독자적으로 발명:

| 컴포넌트 | 설명 | deep-suite 대응 |
|----------|------|-----------------|
| Persistent Memory | 인과 가설, 성능 트렌드, 합성 인사이트 저장 | deep-wiki (존재, 고정) |
| Performance Tracking | 세대별 메트릭, 이동평균, 회귀 감지 | deep-dashboard (존재, 고정) |
| Multi-stage Verification | 체크리스트 + 결정 규칙 기반 다단계 평가 파이프라인 | deep-review (존재, 고정) |
| Decision Protocols | 수락/거절 임계값, 신뢰도 수준 | deep-work Phase Guard (존재, 고정) |
| Domain Knowledge Bases | 환경 제약, 상태 변수, 보상 스케일링 휴리스틱 | deep-wiki (존재, 고정) |
| Retry & Self-correction | 회귀 진단 및 수정 | deep-evolve journal (존재, 고정) |

핵심 통찰: **deep-suite는 HyperAgent가 독자적으로 진화시킨 모든 컴포넌트를 이미 갖고 있지만, 그 어느 것도 스스로 진화하지 않는다.**

---

## 2. 3-Loop 아키텍처 매핑

HyperAgents는 3개의 중첩 피드백 루프로 이해할 수 있다:

### Loop 1 — Task Execution (태스크 실행)
에이전트가 입력을 받고, 추론하고, 도구를 사용하고, 출력을 생성.
- deep-suite: deep-work (plan → implement → test) ✅ 존재

### Loop 2 — Meta Improvement (메타 개선)
메타 에이전트가 태스크 에이전트를 수정 → 평가 → 더 나으면 아카이브에 추가.
- deep-suite: deep-evolve (코드 수정 → 평가 → keep/discard) △ 부분 존재
- 한계: target code만 진화, 실험 전략(program.md)과 평가 harness(prepare.py)는 고정

### Loop 3 — Metacognitive Self-modification (메타인지적 자기 수정)
메타 에이전트가 **자기 자신을 수정** → 메타 개선 효과를 평가 → 아카이브.
- deep-suite: ❌ 완전 부재
- protect-readonly.sh가 상징적으로 이를 차단

---

## 3. 현재 deep-evolve 소스 코드 구조

```
commands/deep-evolve.md          (465줄) 핵심 프로토콜 — 전체 실험 흐름 정의
skills/deep-evolve-workflow/SKILL.md  자동 트리거 스킬 메타데이터
hooks/hooks.json                 PreToolUse 훅 설정
hooks/scripts/protect-readonly.sh (103줄) 실험 중 eval harness 보호
templates/prepare-scenario.py    (163줄) 시나리오 도메인 템플릿
templates/prepare-stdout-parse.py (106줄) stdout 파싱 도메인 템플릿
templates/prepare-test-runner.py  (143줄) 테스트 러너 도메인 템플릿
templates/prepare-protocol.md    (135줄) MCP/도구 기반 평가 프로토콜 템플릿
package.json + plugin.json       플러그인 메타데이터
```

### 핵심 데이터 흐름

```
/deep-evolve 실행
  → A: Init (프로젝트 분석 5단계 → goal/config → scaffolding)
    → .deep-evolve/session.yaml     세션 상태
    → .deep-evolve/prepare.py       평가 harness (READONLY)
    → .deep-evolve/program.md       실험 지침 (READONLY)
    → .deep-evolve/results.tsv      결과 기록
    → .deep-evolve/journal.jsonl    원자적 상태 머신
  → C: Experiment Loop
    → Step 1: Idea Selection (results.tsv + program.md 참조)
    → Step 2: Code Modification (target_files만)
    → Step 3: Git Commit
    → Step 4: Evaluation (cli: prepare.py | protocol: prepare-protocol.md)
    → Step 5: Judgment (score 비교 → keep or discard+reset)
    → Step 6: Continuation Check (수렴 감지)
  → D: Prepare Expansion (수동 트리거, eval harness 확장)
  → E: Completion Report
```

---

## 4. deep-suite 크로스 플러그인 현황

### 현재 데이터 흐름 (단방향)

```
deep-work → receipts → deep-dashboard (수집)
deep-docs → last-scan.json → deep-dashboard (수집)
deep-review → verdict → 사용자 (통보)
deep-evolve → (아무것도 내보내지 않음)
```

### 부재한 역방향 피드백

- deep-review 반복 결함 → deep-work 센서 자동 추가 (없음)
- deep-dashboard harnessability → deep-work guide 강화 (없음)
- deep-evolve 메타 분석 → program.md 자동 개정 (없음)
- deep-evolve 결과 → deep-dashboard 집계 (없음)

---

## 5. 참고 자료

- autoresearch: https://github.com/karpathy/autoresearch
- HyperAgents paper: https://arxiv.org/abs/2603.19461
- HyperAgents code: https://github.com/facebookresearch/HyperAgents
- Harness Engineering (Böckeler/Fowler): https://martinfowler.com/articles/harness-engineering.html
- deep-suite: https://github.com/Sungmin-Cho/claude-deep-suite
- deep-evolve: https://github.com/Sungmin-Cho/claude-deep-evolve
