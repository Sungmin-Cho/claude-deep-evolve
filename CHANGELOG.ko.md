# 변경 이력

이 프로젝트의 모든 주요 변경 사항을 여기에 기록합니다.

형식은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 따르며,
[유의적 버전](https://semver.org/spec/v2.0.0.html)을 준수합니다.

## [3.5.0] — 2026-07-11

### Added

- 네이티브 Node 평가 및 릴리스 검사가 Ubuntu, macOS, Windows 11을 지원합니다.

### Changed

- Claude Code와 Codex가 동일한 워크플로우, 상태 계약, 레거시 세션 마이그레이션 동작을 공유합니다.

### Fixed

- 크로스 플랫폼 읽기 전용 훅이 셸 확장, 중복 등록, 호스트 시작 오류 없이 fail-closed로 동작합니다.

## [3.4.3] — 2026-07-07 (stagnation 감지 복원 + coordinator 종료조건 경화)

### Fixed

- **stagnation 감지가 조용히 비활성화돼 있던 문제.** outer-loop이 `q_history`를 flat 최상위 경로에서 읽었지만 journal은 이를 `outer_loop.q_history` 아래에 중첩 저장하므로, stagnation 검사가 항상 빈 history를 보고 한 번도 발화하지 않았습니다. 이제 중첩 경로에서 읽습니다(malformed / `Q` 누락 엔트리는 skip).
- `coordinator` § 8.1 종료 조건을 프롬프트 해석에 의존하지 않고 결정론적으로 인라인화하여, 루프가 자신의 정지 조건을 인식하지 못하던 liveness 갭을 닫았습니다.
- `coordinator`의 hook/script 호출이 이제 `${CLAUDE_PLUGIN_ROOT}` 경로를 인용하여, 공백이 포함된 plugin root에서도 `hooks/scripts/*` 호출이 깨지지 않습니다.
- `evolve-receipt` payload가 이제 필수 `session_id` 필드를 담습니다(이전에는 누락되어 emit 시 스키마 검증에 실패).

## [3.4.2] — 2026-05-18 (Codex 네이티브 플러그인 manifest 및 AGENTS 가이드)

### 추가

- `.codex-plugin/plugin.json` — Claude Code manifest와 동일한 skill/hook 표면을 가리키는 Codex 네이티브 플러그인 manifest. 기존 `claude-deep-*` repository identity 유지.
- `AGENTS.md` — runtime surface와 검증 명령을 다루는 Codex 프로젝트 가이드.

### 변경

- README가 기존 Claude Code 표면과 함께 Codex 호환성을 명시.

## [3.4.1] — 2026-05-18 (Codex 1024자 description 한계 대응)

### Fixed

- `deep-evolve-workflow` 스킬 description을 Codex의 1024자 한계에 맞게 trim. Codex가 로드 시점에 스킬을 조용히 스킵하여 v3.4.0의 cross-platform parity가 깨져 있었음. 동작 변경 없음.

## [3.4.0] — 2026-05-18 (command → skill 전환: cross-platform parity)

### 변경

- `/deep-evolve`가 슬래시 커맨드가 아닌 `user-invocable: true` 스킬로 전환됨. Claude Code 사용자는 그대로 `/deep-evolve [args…]` 입력하면 동작하고, Codex / Copilot CLI / Gemini CLI / Agent SDK 호출자는 동일 워크플로우를 `Skill({ skill: "deep-evolve:deep-evolve", args: "…" })`로 호출 가능.

### 마이그레이션

사용자 액션 불요. 기존 세션, `.deep-evolve/` 상태, journal 이벤트는 영향 없음; resume도 그대로 동작.

## [3.3.3] — 2026-05-13 (plugin-dev 검증 클린업 + manifest drift CI 가드)

### 추가

- `.claude-plugin/plugin.json`, `package.json`, 워크플로우 스킬 frontmatter, `session-helper.sh` `HELPER_VERSION` 네 곳이 동기 상태인지 단언하는 버전 drift 가드.
- `ubuntu-latest` + `macos-latest` CI 매트릭스에 `pytest` 단계 추가.

### 변경

- 워크플로우 `SKILL.md`를 전체 라우팅 표(11개 protocol), 상태 머신 표, CLI 인자 매트릭스로 재작성하여 스킬만으로 워크플로우 진입 가능.
- 플러그인 가드 `hooks.json` description을 현행 v3.0+ 동작에 맞게 갱신; PreToolUse hook timeout을 macOS cold-cache 헤드룸 확보를 위해 2초 → 5초로 상향(보호 파일 집합과 deny-by-default 동작은 변경 없음).
- `package.json` description을 플러그인 manifest와 정렬.

## [3.3.2] — 2026-05-12 (중단 세션 복구 테스트)

### 추가

- 손상된 state에 대해 `session-helper.sh`의 `resolve_current`와 `detect_orphan_experiment`의 dangling-state 계약을 핀하는 session-recovery 테스트. 프로덕션 코드 변경 없음.

## [3.3.1] — 2026-05-12 (protect-readonly hook golden 테스트)

### 추가

- `protect-readonly` PreToolUse hook의 exit code · decision · reason을 도구 × 세션 상태 × 메타 모드 조합에 대해 핀하는 golden-fixture 회귀 커버리지. 훅 동작 변경 없음.

## [3.3.0] — 2026-05-12 (reverse handoff + compaction telemetry)

### 추가

- `emit-handoff.js` — 세션 완료 시점에 reverse handoff envelope(`handoff_kind: evolve-to-deep-work`)을 emit하며, round-trip을 닫기 위해 상위 forward handoff에 `parent_run_id`를 chain.
- `emit-compaction-state.js` — 세션 완료 경계마다 `compaction-state` envelope(`trigger: loop-epoch-end`, `strategy: receipt-only`)을 emit하여 대시보드 compaction 메트릭을 구동.

### 변경

- envelope helper와 CI validator가 `handoff` · `compaction-state` artifact kind를 허용하도록 확장.

### 노트

- producer-only: deep-evolve는 이 산출물을 emit하지만 consume하지는 않음.

## [3.2.0] — 2026-05-08 (M3 공통 아티팩트 envelope)

`evolve-receipt.json`과 `evolve-insights.json`을 M3 cross-plugin envelope 컨트랙트로 전환. 3.2.0 이전 receipt는 그대로 읽히며, `session.yaml` 스키마 변경 없음, resume 중단 없음.

### 추가

- `envelope.js` — ULID 생성, git 감지, envelope wrap/unwrap, strict identity check(producer / artifact_kind / schema.name)를 제공하는 zero-dep helper.
- `wrap-evolve-envelope.js` — atomic temp+rename write로 receipt/insights를 wrap하는 CLI wrapper. 동시 finisher · mid-write 중단 시에도 truncated JSON이 남지 않음.
- suite-side 스키마(ULID, SemVer 2.0.0, RFC 3339, kebab-case, `additionalProperties` strict)를 mirror하는 self-test validator.

### 변경

- `evolve-receipt`와 `evolve-insights`가 suite 전역 envelope(`schema_version: "1.0"` + `envelope` + `payload`)을 emit. `evolve-insights`는 multi-source aggregator로 `parent_run_id`를 omit하고 consumed source를 `provenance.source_artifacts[]`에 기록.
- init이 `recurring-findings.json`을 envelope-aware로 읽고(bash fast path + jq identity guard) consumed `run_id`를 기록하여 completion이 `parent_run_id`를 chain 가능.

### Cross-plugin chain

- `evolve-receipt.envelope.parent_run_id`가, consumed deep-review `recurring-findings`가 envelope일 때 그 `envelope.run_id`로 chain.

### 호환성

- legacy(3.2.0 이전) receipt는 fall-through로 그대로 읽힘; receipt 경로의 foreign-producer envelope은 identity guard가 거부. worktree 마이그레이션 불요.

## [3.1.1] — 2026-04-26 (런타임 가드 강화)

v3.1.0 런타임 가드를 강화하는 패치 릴리스. 프로토콜·세션 스키마 변경 없음; v3.1.0 세션은 그대로 resume.

### 수정

- `protect-readonly.sh`가 deny-by-default 매칭으로 `prepare.py` / `prepare-protocol.md`의 Bash 측 읽기(`cat`, `less`, `tee -a`, `perl -i` 등)를 차단하면서 `python prepare.py` 실행은 허용.
- seed worktree 하위의 per-seed `program.md`가 세션 루트 `program.md`와 동일한 META_MODE 게이트를 공유.
- `scheduler-signals.py`가 legacy `status`-키 journal 이벤트를 허용하고, `evaluated`-이벤트 score lookup으로 fallback하며, boolean의 numeric 강제 변환을 거부하고, per-seed `experiments_used_this_epoch` 신호를 추가.
- `baseline-select.py` non-quarantine 필터가 `status == "killed_shortcut_quarantine"`도 거부.
- `status-dashboard.py`가 terminal `kept`/`discarded` 이벤트만 `(seed_id, experiment_id)` 키로 dedup하여 중복 카운팅 제거.
- `seed_killed` 파싱이 null/비-string `condition`을 허용하고 raw condition과 자유 텍스트 사유를 분리.
- `prepare-stdout-parse.py`가 stdout에 선언된 메트릭이 누락되면 score를 `0.0`으로 collapse — 이전엔 partial-parse 실패를 무한 개선으로 오인하던 `2.0` ceiling을 부여했음.

### 마이그레이션

없음. 새 가드는 다음 hook 발화 시 in-flight 세션에 자동 적용.

## [3.1.0] — 2026-04-26 (virtual parallel N-seed)

v3.0 Inner/Outer Loop에 parallel N-seed 탐색을 추가하는 major 릴리스. 각 세션이 N=1–9개 독립 seed worktree를 적응형 스케줄러로 공유 forum 위에서 조정하고, 세션 종료 시 synthesis로 per-seed 결과를 단일 best 브랜치로 병합. v3.0.x 세션은 version-tier 라우팅으로 완전 지원.

### 추가

- **Virtual parallel N-seed** — `.deep-evolve/<sid>/seeds/<seed_id>/worktree/` 하위 N=1–9 seed worktree; coordinator가 subagent를 발화하고 per-seed inner loop는 journal 이벤트에 `seed_id`를 주입한 채 기존 코드로 동작.
- **β/γ seed 구분** — β는 init 시 의도적으로 모호한 방향, γ는 `grow_then_schedule` 결정에 의한 세션 중 AI 재생성.
- **적응형 스케줄러** — `scheduler-decide.py`가 per-seed 신호(Q, in-flight block, borrows-received MIN-wins, last-keep age)와 session-wide 신호(allocation floor, fairness deficit)로부터 `schedule` / `kill_then_schedule` / `grow_then_schedule`을 반환.
- **Forum + cross-seed borrow 교환** — append-only flock 보호 `forum.jsonl`과 2단계 borrow lifecycle(`borrow_planned` → `cross_seed_borrow`, `borrow_abandoned` janitor 정리), borrow preflight 가드레일.
- **Convergence classifier** — `convergence-detect.py`가 borrow를 `evidence_based` / `borrow_chain_convergence` / `contagion_suspected`로 분류하고 Outer Loop에서 다르게 가중.
- **Kill 관리** — condition whitelist, `--kill-seed` CLI 큐, in-flight 지연 kill 드레이닝 + AskUserQuestion 확정.
- **세션 종료 synthesis** — synthesis worktree가 seed 브랜치를 4-step cascade fallback(preferred → non-quarantine → best-effort → no-baseline)과 구조화 fallback 노트로 병합.
- **Init / resume / meta-archive schema_v4** — AI가 프로젝트를 suggested N으로 분류하고 AskUserQuestion으로 확정; resume이 yaml/journal drift를 prefer-journal로 reconcile; meta-archive entry에 `virtual_parallel` snapshot 추가(v2/v3/v4 공존).
- **CLI 플래그** — `--no-parallel`, `--n-min`, `--n-max`(N_MIN ≤ N_MAX 강제), `--kill-seed`, `--status` per-seed 대시보드.

### 변경

- `session.yaml`에 `virtual_parallel` 블록 추가(`n_current`, `n_initial`, `n_range`, `budget_total` 및 per-seed 항목); `deep_evolve_version: "3.1.0"`.
- `journal.jsonl`에 v3.1 이벤트 추가(`seed_initialized`, `seed_block_completed/failed`, `seed_killed`, `init_vp_analysis`, `resume_drift_detected`, `synthesis_commit/failed`, `borrow_planned`, `borrow_abandoned`, `seed_scheduled`); forum 측 이벤트는 `forum.jsonl`에 기록.
- 신규 runtime 파일 `forum.jsonl`, `kill_requests.jsonl`; `session-helper.sh`에 seed/synthesis/kill-queue 서브커맨드 추가.

### 마이그레이션

- v3.0.x 세션은 version-tier 라우팅으로 single-seed 경로 그대로 resume; 스키마 마이그레이션 없음.
- v3.1 세션은 N=1(`--no-parallel`)로 실행 가능하며 v3.0 single-seed와 동작 등가.
- Deprecation 로드맵(변경 없음): 3.0.x v2 full support → 3.1.0 warning → 3.2.0 read-only completion → 4.0.0 v2 스키마 제거.

### 알려진 문제 (3.1.x로 연기)

`scheduler-decide.py` / `coordinator.md`의 5개 non-blocking polish 항목(signals 파싱 순서, type/business exit-code 분리, pseudocode/시그니처 정렬, scheduler cross-field 검증)을 비-차단으로 검증하고 patch backlog로 ticketing.

## [3.0.0] — 2026-04-22 (AAR 기반 증거 중심 hill-climbing)

Inner/Outer Loop에 AAR 기반 4개 동작 레이어를 추가하는 major 릴리스. `deep_evolve_version: "3.0.0"`로 게이팅. v2.2.2 세션은 soft migration으로 완전 지원. (참고: Wen et al. 2026, "Automated Weak-to-Strong Researcher".)

### 추가

- **Idea-category entropy 추적** — 10-카테고리 taxonomy로 Outer Loop마다 Shannon entropy를 계산하여 탐색 collapse 방지.
- **Legibility Gate** — 모든 `kept` 이벤트에 rationale 강제; 유효한 rationale 없는 flagged keep은 discard로 전환.
- **Shortcut Detector** — 작은 코드 변경이 큰 score 점프를 내는 keep을 flag; 누적 3회 시 적대적 시나리오와 함께 Section D prepare 확장 강제. opt-in `seal_prepare_read`로 inner loop 중 `prepare.py` 읽기 차단.
- **Diagnose-and-Retry** — crash, severe drop, 에러 키워드 시 1회 복구; 세션 상한 10회, per-experiment 재시도 1회 제한.

### 변경

- `strategy.yaml` 스키마 `version: 2`에 카테고리 weights와 shortcut/legibility/entropy 섹션 추가; `session.yaml`에 매칭 tracking 블록 추가; v3 `results.tsv`는 9 컬럼(헤더로 auto-detect). Completion report에 "v3.0.0 Signals" 섹션 추가.

### 마이그레이션

- v2.2.2 세션은 v2 코드 경로 그대로 resume(경고 배너). v2 meta-archive entry는 read 시 결정론적 매핑으로 변환.

---

## v2.2.2

### 수정

- **prepare.py cwd 회귀** — 세 CLI 템플릿 모두 `.deep-evolve/`의 부모를 역탐색하여 v2.2.0 namespace와 legacy flat 레이아웃 모두 지원.
- **paused 세션 상태 + idempotent resume** — Outer Loop이 `paused`/`active`를 토글하고 이미 완료된 sub-step을 journal 이벤트로 확인해 스킵.
- **resume 커밋 해시 비교** — journal에 full 40-char SHA 기록; legacy short-hash는 비교 전 resolve하고 `--is-ancestor` semantics 정정.
- **minimize baseline writeback** — init이 측정된 raw baseline을 persist하고 재측정하여 `session.yaml.metric.baseline == 1.0` 보장.
- **session_id 충돌** — 충돌 체크를 프로젝트 락 내부로 이동, suffix 재시도로 동시 init 경쟁 해결.
- **다중 프레임워크 테스트 파싱** — jest / vitest / cargo test / go test / pytest 명시적 감지; 파싱 불가 출력은 pass rate를 부풀리는 대신 0/0 반환.
- **lint + coverage 파싱** — 요약 라인(없으면 진단 라인)에서 errors/warnings 카운트, coverage를 `TOTAL` 라인에 앵커.
- 다수의 `set -u` / lint-timeout / dirty-tree-whitelist 견고성 수정.

### 변경

- `prepare-test-runner.py`가 활성 weight만으로 score를 정규화하여 test-only 프로젝트도 1.0 달성 가능; `prepare-stdout-parse.py` minimize 반전에 명시적 `score <= 0` 가드.

## v2.2.1

### 추가

- Notable keep을 자동 마킹(generation별 top-3 kept 실험)하여 receipt `notable_keeps` 품질 향상.

### 변경

- README가 v2.2 Session Management / Resume / History / Lineage 기능을 문서화; 사용법 문서에 resume/history 커맨드 추가.

## v2.2.0

### 추가

- **세션 네임스페이스** — `.deep-evolve/<session-id>/` 세션별 격리, 세션 간 데이터 보존.
- `/deep-evolve resume` — integrity check와 orphan-experiment 감지로 중단 세션 재개.
- `/deep-evolve history` — 세션 목록, lineage tree, aggregate 통계.
- **Session lineage** — 새 세션이 선행 세션의 strategy / program / notable keeps를 상속(informational), `program.md`에 자동 삽입.
- **Immutable receipt v2.2.0** — experiments table, generation snapshots, notable keeps, runtime warnings, parent-session 참조.
- `--dry-run`을 지원하는 `session-helper.sh` 셸 helper.

### 변경

- **호환성 변경:** `.deep-evolve/` 레이아웃을 flat → per-session namespace로 변경(첫 실행 시 자동 migration 프롬프트); 세션은 삭제 대신 보존; `sessions.json` → event-sourced `sessions.jsonl`.

## v2.1.2

### 변경

- Inner-loop Step 6을 Outer Loop 자동 트리거 우선으로 재구조화하고 AskUserQuestion은 이후 조건부로 변경; `outer_loop.auto_trigger` 플래그(default true)와 `program.md` 템플릿의 Automation Policy 블록 추가. inner count를 `session.yaml`에 persist.

### 수정

- v2.2.0 레이아웃을 감지해 업그레이드 안내를 출력하는 forward-compat shim.

## [2.1.0] — 2026-04-14

### 추가

- **크로스 플러그인 피드백 (Phase 3A)** — deep-dashboard용 `evolve-receipt.json`, merge/PR 전 deep-review 트리거 및 실패 fallback, init 중 `recurring-findings.json` 소비, deep-work/deep-review용 `evolve-insights.json` 내보내기, 6개 통합 완료 옵션 메뉴, 세션 처리 결과 추적용 `outcome` 필드.

## [2.0.0] — 2026-04-13

### 추가

- **자기 진화 실험 루프** — 진화 가능한 `strategy.yaml` 파라미터 계층과 Q(v) 메타 메트릭으로 전략을 변이시키는 Outer Loop를 갖춘 2계층 아키텍처.
- 3계층 자기 진화(파라미터 + 전략 텍스트 + 평가 확장).
- 전략 아카이브(stepping stones + 부모 선택), 코드 아카이브(이름 지정 브랜치 백트래킹), 아이디어 앙상블(실험당 다중 후보 선택).
- flock 보호 메타 아카이브를 통한 크로스 프로젝트 전략 전이; `prepare.py` 버전 관리를 위한 Evaluation Epoch 분리.

### 변경

- Meta Analysis가 `program.md`를 자동 개정; Section D(prepare 확장)를 수동 → 수렴 시 자동 트리거로 변경.

### 수정

- `protect-readonly.sh` grep 파이프 로직; `prepare-stdout-parse.py` minimize 반전; 통합 스코어링 계약(항상 higher-is-better); repository URL 정정.

## [1.1.0] — 2026-04-07

### 추가

- **개방형 프로젝트 분석** — 게임 엔진, 커스텀 빌드 시스템, 비표준 프로젝트도 분석 가능.
- **프로토콜 평가 모드** — MCP 서버, 브라우저 자동화, 외부 API 등 도구 기반 평가와 `prepare-protocol.md` 템플릿(역시 `protect-readonly.sh`로 보호).

### 변경

- Stage 1–2 분석을 하드코딩 파일 목록에서 개방형 신호 기반 탐색으로 전환; 미지의 프로젝트는 거부 대신 사용자에게 질문; 평가 모드(cli/protocol) 자동 추천.

## [1.0.0] — 2026-04-06

### 추가

- 최초 릴리스.
- 5단계 프로젝트 심층 분석을 통한 대화형 초기화.
- 세 가지 `prepare.py` 템플릿: stdout-parse, test-runner, scenario.
- 저널 기반 원자적 상태 머신을 활용한 실험 루프와 수확 체감 감지.
- 세션 간 재개 지원; `prepare.py` 버전 관리 및 확장.
- 실험 안전을 위한 `protect-readonly.sh` 훅(Write/Edit/Bash)과 안전한 롤백을 위한 브랜치 및 클린 트리 가드.
- 결과 적용 옵션(merge/PR/keep/discard)이 포함된 완료 보고서.
