# 변경 이력

## [3.0.0] — 2026-04-22 (AAR 기반 증거 중심 Hill-Climbing)

AAR 논문(Wen et al. 2026, Anthropic Alignment Science Blog)에서 영감 받은 4개
동작 레이어를 Inner/Outer Loop에 추가하는 major 릴리스. `session.yaml.deep_evolve_version: "3.0.0"`로 게이팅.
v2.2.2 세션은 soft migration으로 완전 지원.

### 추가
- **Idea-category entropy 추적** (§7.1): 10-카테고리 taxonomy
  (`protocols/taxonomy.md`); Outer Loop마다 Shannon entropy 계산
  (`session-helper.sh entropy_compute` 신규); `entropy_snapshot` / `entropy_collapse`
  journal 이벤트; Tier 1 entropy overlay (6.5.3).
- **Legibility Gate** (§6 Step 5.d): 모든 `kept` 이벤트에 rationale 강제 (Medium).
  Flagged keep은 Hard로 승격 — 설명 불가 시 discard 전환. 누락 카운터는 완료
  리포트에 노출.
- **Shortcut Detector** (§6 Step 5.c + 6.a.5): `score_delta ≥ 0.05 AND loc_delta ≤ 5` 기준 flag.
  누적 3회 시 Section D prepare 확장 강제 발화, flagged commit의 diff를 재생성
  프롬프트에 주입 (§7.3). Hard-reject 시에도 포렌식 row 기록.
  End-to-end opt-in `seal_prepare_read` — strategy.yaml → `DEEP_EVOLVE_SEAL_PREPARE=1`
  → PreToolUse hook이 prepare.py Read 차단.
- **Diagnose-and-Retry** (§6 Step 5.a): crash / severe drop(>5%) / 에러 키워드 시
  1회 복구 재시도. 세션 상한 10회. Retry는 reset + new commit + `retry_of` 링크.
  Give_up 경로 별도 기록. Per-experiment 재시도 journal replay로 1회 강제.
- **10-카테고리 taxonomy**: `parameter_tune, refactor_simplify, add_guard,
  algorithm_swap, data_preprocessing, caching_memoization, error_handling,
  api_redesign, test_expansion, other`.
- **v2→v3 결정론적 매핑** — meta-archive A.2.5 lookup (§8.2).
  `session-helper.sh migrate_v2_weights` 서브커맨드로 변환.
- **신규 `session-helper.sh` 서브커맨드**: `entropy_compute`, `migrate_v2_weights`,
  `count_flagged_since_last_expansion`, `retry_budget_remaining`.
- **pytest 테스트 스위트** (`hooks/scripts/tests/`, 9개 테스트).
- **Fixtures** (`hooks/scripts/tests/fixtures/`): `shortcut_bait/` (Scenario B),
  `legibility_medium/` (Scenario A), `dogfood_target/` (self-dogfooding).

### 변경
- `strategy.yaml` 스키마 `version: 2` (v3 세션) — 10 카테고리 weights + 신규
  `shortcut_detection`, `legibility`, `entropy_tracking` 섹션 + `judgment.diagnose_retry`.
- `session.yaml`에 `shortcut`, `diagnose_retry`, `legibility`, `entropy` 블록
  추가 (v3 세션). `deep_evolve_version`을 `"3.0.0"`로 업그레이드.
- `results.tsv` v3 세션은 9 컬럼 (`category`, `score_delta`, `loc_delta`,
  `flagged`, `rationale` 추가). v2 세션은 4 컬럼 유지.
  Consumer(completion.md/resume.md)가 header의 column 수로 auto-detect.
- `journal.jsonl` 확장: `planned.idea_category`, `committed.retry_of`,
  `kept.{rationale, score_delta, loc_delta, flagged}`, `discarded.reason` 확장.
  신규 이벤트: `diagnose_retry_started/completed`, `shortcut_flagged`,
  `shortcut_escalation`, `entropy_snapshot`, `entropy_collapse`,
  `rationale_missing`, `tier3_flagged_reset`.
- Completion report에 "v3.0.0 Signals" 섹션 추가.
- `hooks.json` matcher에 `Read` 추가 (`DEEP_EVOLVE_SEAL_PREPARE=1` opt-in으로만
  활성화, default off — v2 행동 보존).
- `protect-readonly.sh`에 상대 경로 정규화 포함 opt-in Read branch 추가.

### 마이그레이션
- v2.2.2 세션 resume 시 기존 v2 코드 경로 그대로 + 경고 배너 (`resume.md` Step 4).
- v2 meta-archive 엔트리는 A.2.5 read 시 결정론적 매핑으로 변환 (floor는
  pre-normalize seed, post-normalize invariant 아님 — spec §5.1 참조).
- Deprecation 로드맵: 3.0.x v2 full support → 3.1.0 warning → 3.2.0 read-only
  completion → 4.0.0 v2 스키마 제거.

### 3.0.0에 미포함 (3.1.0로 연기)
- Virtual parallel N-seed per epoch.
- Cross-project transfer upstream-signal validation gate.

---

## v2.2.2

### Critical Fixes
- **prepare.py cwd 회귀 (C-2)**: v2.2.0 namespace 레이아웃에서 `Path(__file__).parent.parent`가 `.deep-evolve/`를 가리키던 버그 수정. 세 템플릿 모두 `.deep-evolve/` 부모로 역탐색. namespace/flat 레이아웃 모두 지원.
- **paused 세션 상태 + journal-event 기반 idempotent resume (C-1, R-1)**: Outer Loop 진입/복귀 시 `mark_session_status paused|active`. Outer Loop 자체도 각 sub-step의 완료 이벤트(`outer_loop`, `strategy_update`, `strategy_judgment`, `notable_marked`, `program_skip`)를 journal에서 확인해 idempotent하게 스킵. 별도 `current_phase` 필드 없이 기존 이벤트 재사용.
- **migrate_legacy unbound 변수 (C-3)**: `files_to_copy`, `dirs_to_copy`를 `skip_copy` 가드 바깥으로 선언. `set -u` 하 idempotent 재실행 abort 제거.
- **DEEP_EVOLVE_HELPER 우회 + TOOL_NAME 가드 (C-4, R-6)**: 파일 기반 도구 + 명시적 non-Bash TOOL_NAME일 때만 허용. 빈 TOOL_NAME은 Bash-like 취급(안전한 기본값: 전체 검사).
- **prepare-test-runner.py lint TIMEOUT (C-5)**: `run_lint`가 설정된 `TIMEOUT`을 존중.
- **resume 커밋 해시 비교 (C-6, R-2, R-4)**: journal에 full 40-char SHA 기록. 기존 short-hash 엔트리는 `git rev-parse`로 resolve 후 비교. `--is-ancestor` semantics 정정 — ancestor=true면 "reset HEAD~1^로 롤백 가능"(사용자 프롬프트), ancestor=false면 "이미 제거됨"(idempotent skip).
- **minimize baseline writeback (C-7, R-7, 신규)**: init.md Step 11이 측정된 raw baseline을 `BASELINE_SCORE`로 writeback, 재측정(score=1.0 확인) 후 그 1.0을 `session.yaml.metric.baseline`으로 기록. init 중 session.yaml.status="initializing", Step 11 완료 시 "active" 전환.

### High-Priority Fixes
- **session_id TOCTOU (H-1)**: collision 체크를 프로젝트 락 내부로 이동. suffix 재시도로 동시 init 경쟁 해결.
- **epoch 전환 시 archive save (H-2)**: Tier 3 자동 확장 직후 generation을 새 epoch 기준선으로 자동 keep.
- **pending 메타 아카이브 source 업데이트 (H-3)**: `.pending-archive.jsonl`에 `new_entry`/`update_source` 태그 레코드. flock timeout 시 `transfer_success_rate` 업데이트 손실 방지.
- **다중 프레임워크 테스트 파싱 (H-4, R-8)**: jest, vitest, cargo test, go test, pytest 명시적 지원. 파싱 불가 출력은 0/0 반환 (기존 false-positive `(PASS|ok|\.)` fallback 제거).
- **lint 요약 + 진단 라인 fallback (H-5, R-10)**: `"N errors"` 요약 라인 카운트; 요약 없으면 `error:`/`warning:` 진단 라인 카운트로 fallback (clippy/rustc 스타일 지원).
- **coverage TOTAL 앵커 (H-6)**: `TOTAL`/`Total`/`All files` 라인 우선, 마지막 `%` 값 폴백.
- **pytest skipped 제외 (R-9)**: `passed+failed+errors`로 total 계산 (skipped는 pytest 관행상 pass/fail 어느 쪽도 아님).

### Medium/Low Fixes
- **init.md lineage canonical (M-1, R-12)**: `lineage_set` 이벤트가 유일한 canonical 경로. `--parent=<id>` 플래그는 helper가 하위 호환으로 파싱하지만 init.md에서는 호출하지 않음.
- **`current_branch:` 2-space 앵커 (M-2, R-11)**: `cmd_check_branch_alignment`가 awk로 최상위 `lineage.current_branch`(2-space)만 매칭. 중첩 필드 무시.
- **receipt 타입 주석 (M-3)**: `evolve-receipt.json`의 모든 필드에 number/string/boolean 타입 주석.
- **dirty-tree targeted whitelist (L-1, R-3)**: 죽은 grep 필터를 `awk '$1 != "??" || $2 !~ /^\.deep-evolve\//'`로 교체. 실제 untracked 탐지 유지, 세션 상태만 예외.

### 템플릿 가중치
- `prepare-test-runner.py` score 합성이 활성 weight만 정규화. coverage/lint 비활성 프로젝트도 score=1.0 달성 가능.
- `prepare-stdout-parse.py` minimize 반전에 명시적 `score <= 0` 가드.

## v2.2.1

### 개선
- **Notable keep 마킹 의무화**: Outer Loop Step 6.5.4a — generation별 top-3 kept 실험을 자동으로 notable 마킹. receipt의 notable_keeps 데이터 품질 향상
- **README v2.2 기능 반영**: Session Management, Resume, History, Lineage 기능을 README에 문서화
- **SKILL.md 사용법 확장**: resume/history 커맨드를 사용법 섹션에 추가

## v2.2.0

### 추가
- **세션 네임스페이스**: `.deep-evolve/<session-id>/` 세션별 격리, 세션 간 데이터 보존
- **`/deep-evolve resume`**: 중단된 세션 재개, integrity check, orphan experiment 감지
- **`/deep-evolve history`**: 프로젝트 내 세션 목록, lineage tree, aggregate 통계
- **Session lineage**: 선행 세션의 strategy/program/notable keeps를 새 세션에 상속
- **Inherited Context**: program.md에 선행 세션 결론 자동 삽입
- **Immutable receipt v2.2.0**: experiments_table, generation_snapshots, notable_keeps, runtime_warnings, parent_session
- **Shell helper**: `hooks/scripts/session-helper.sh` 13개 서브커맨드, --dry-run 지원

### 호환성 변경
- `.deep-evolve/` 디렉터리 구조 변경: flat → per-session namespace
- 기존 flat layout 프로젝트는 첫 실행 시 자동 migration 프롬프트

## [2.1.0] — 2026-04-14

### 추가
- **크로스 플러그인 피드백 (Phase 3A):**
  - deep-dashboard 연동을 위한 `evolve-receipt.json` 생성
  - merge/PR 전 deep-review 트리거 및 실패 fallback
  - deep-review의 `recurring-findings.json` 소비 (init Stage 3.5)
  - meta-archive 기반 `evolve-insights.json` 내보내기 (Section E.1)
  - 6개 통합 완료 옵션 메뉴
  - receipt에 세션 처리 결과 추적용 `outcome` 필드

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
