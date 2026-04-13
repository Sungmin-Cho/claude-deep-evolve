---
name: deep-evolve-workflow
version: "1.0.0"
description: |
  Autonomous experimentation protocol with goal-driven experiment loops.
  Use when: "deep evolve", "deep-evolve", "autonomous experiment", "자율 실험",
  "autoresearch", "auto improve", "자동 개선", "experiment loop", "실험 루프",
  "자동으로 개선", "프로젝트 개선", "코드 최적화", "self-evolution", "자기 진화",
  "strategy", "전략 진화", "outer loop", "strategy evolution", "meta-archive",
  "stepping stones", or tasks that benefit from systematic measured improvements
  through iterative experimentation.
---

# Deep Evolve: Autonomous Experimentation Protocol

`/deep-evolve` 하나로 프로젝트를 자동 개선합니다.

## 워크플로우

```
/deep-evolve → 프로젝트 분석 → 평가 harness 생성 → 자율 실험 루프 → 완료 보고
```

## 핵심 원칙

1. **고정 평가, 가변 코드**: prepare.py가 ground truth. target 파일만 수정
2. **측정 기반**: 모든 변경은 score로 평가. 개선 없으면 discard
3. **간결함 우선**: 동일 score에 더 단순한 코드 = keep
4. **이력 학습**: discard 이유를 기억하고 같은 실수 반복 안 함

## 사용법

- `/deep-evolve` — 새 세션 시작 또는 기존 세션 재개
- `/deep-evolve 50` — 50회 실험 요청
- `/deep-evolve "새 목표"` — 새 목표로 세션 시작

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
