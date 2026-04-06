---
name: deep-evolve-workflow
version: "1.0.0"
description: |
  Autonomous experimentation protocol with goal-driven experiment loops.
  Use when: "deep evolve", "deep-evolve", "autonomous experiment", "자율 실험",
  "autoresearch", "auto improve", "자동 개선", "experiment loop", "실험 루프",
  "자동으로 개선", "프로젝트 개선", "코드 최적화", or tasks that benefit from
  systematic measured improvements through iterative experimentation.
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

| 도메인 | 예시 | 메트릭 |
|--------|------|--------|
| ML 훈련 | val_bpb 최소화 | stdout 파싱 |
| 테스트 | 커버리지 80%+ | 테스트 실행 |
| 코드 품질 | 보안/패턴 개선 | 시나리오 통과율 |
| 전략 최적화 | sharpe ratio 최대화 | 백테스트 결과 |
