# 변경 이력

## [2.0.0] - 2026-04-13

### 추가
- 자기 진화 실험 루프 (2계층 아키텍처)
- strategy.yaml: 진화 가능한 전략 파라미터 계층
- Outer Loop: Q(v) 메타 메트릭을 통한 자동 전략 진화
- 3계층 자기 진화: 파라미터 + 전략 텍스트 + 평가 확장
- Stepping stones 기반 전략 아카이브 및 부모 선택
- 이름 지정 브랜치 기반 코드 아카이브 및 백트래킹
- 아이디어 앙상블 (실험당 다중 후보 선택)
- 메타 아카이브를 통한 크로스 프로젝트 전략 전이
- prepare.py 버전 관리를 위한 Evaluation Epoch 분리
- 메타 아카이브용 flock 기반 동시성 안전

### 수정
- protect-readonly.sh: grep 파이프 로직 오류 (P0-1)
- prepare-stdout-parse.py: minimize 메트릭 반전 오류 (P0-2)
- 통합 스코어링 계약: score는 항상 higher-is-better
- package.json/plugin.json: repository URL 수정

### 변경
- Meta Analysis: program.md 자동 개정 (Phase 1)
- Section D (Prepare 확장): 수동 → 수렴 시 자동 트리거

## [1.1.0] - 2026-04-07

### 추가
- **개방형 프로젝트 분석**: 게임 엔진, 커스텀 빌드 시스템, 비표준 프로젝트도 분석 가능
- **프로토콜 평가 모드**: MCP 서버, 브라우저 자동화, 외부 API 등 도구 기반 평가 지원
- `prepare-protocol.md` 템플릿: CLI로 평가할 수 없는 프로젝트를 위한 프로토콜 정의
- protect-readonly.sh에 prepare-protocol.md 보호 추가

### 변경
- Stage 1-2 분석을 하드코딩된 파일 목록에서 개방형 신호 기반 탐색으로 전환
- 미지의 프로젝트에서 거부 대신 사용자에게 질문하며 진행
- 평가 모드 자동 추천 (cli/protocol) 추가

## [1.0.0] - 2026-04-06

### 추가
- 최초 릴리스
- 프로젝트 심층 분석을 통한 대화형 초기화 (5단계)
- 세 가지 prepare.py 템플릿: stdout 파싱, 테스트 러너, 시나리오
- 저널 기반 원자적 상태 머신을 활용한 실험 루프
- 수확 체감 감지
- 세션 간 재개 지원
- prepare.py 버전 관리 및 확장
- 실험 안전을 위한 protect-readonly.sh 훅 (Write/Edit/Bash)
- 결과 적용 옵션이 포함된 완료 보고서 (merge/PR/keep/discard)
- 안전한 롤백을 위한 브랜치 및 클린 트리 가드
