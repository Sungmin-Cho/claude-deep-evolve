# 변경 이력

## [3.3.0] — 2026-05-12 (M5.7.B Reverse Handoff + Compaction Telemetry)

Cross-plugin handoff + dashboard compaction telemetry milestone의 M5.7.B
한쪽을 채택한 minor 릴리스. 상세 plan은
`claude-deep-suite/docs/superpowers/plans/2026-05-11-m5.7-plugin-adoption-handoff.md`.
deep-evolve가 이제 `handoff.json` (`handoff_kind: "evolve-to-deep-work"`,
round-trip을 닫기 위해 상위 forward handoff에 `parent_run_id` chain) 과
`compaction-state.json` (`trigger: loop-epoch-end`, `strategy: receipt-only`)
을 세션 완료 시점에 emit — deep-evolve의 canonical compaction event.

### Added

- **`hooks/scripts/emit-handoff.js`** — reverse handoff envelope을 위한 CLI
  wrapper. Identity-triplet (`producer = "deep-evolve"`, `artifact_kind = "handoff"`,
  `schema.name = "handoff"`, `schema.version = "1.0"`) 자동 설정; write 전에
  payload required 필드 enforce (`schema_version`, `handoff_kind`,
  `from{producer,completed_at}`, `to{producer,intent}`, `summary`,
  `next_action_brief`) — `claude-deep-suite/schemas/handoff.schema.json` 기준.
  플래그: `--source-parent` (상위 envelope(forward handoff 또는 evolve-receipt)
  로부터 `parent_run_id` chain), `--source-evolve-receipt` (semantic clarity용 alias),
  `--source` (provenance-only 항목).
- **`hooks/scripts/emit-compaction-state.js`** — compaction-state envelope을
  위한 CLI wrapper. Trigger enum을 suite schema 기준으로 검증
  (`phase-transition`, `slice-green`, `loop-epoch-end`, `window-threshold`,
  `manual`, `session-stop`); strategy enum도 검증. 두 입력 모드: protocol-driven
  emit용 CLI 플래그 또는 skill-composed emit용 `--payload-file`. Dashboard 메트릭
  `suite.compaction.frequency` + `suite.compaction.preserved_artifact_ratio`를 구동.
- **`skills/deep-evolve-workflow/protocols/completion.md`** — `M5.7.B — Loop-epoch-end
  compaction-state emit` 새 섹션이 evolve-receipt wrap 직후 apply-path 분기
  전에 실행. 세션 완료 시점에 항상 emit하여 dashboard에 telemetry를 공급.
  Preserved: evolve-receipt; discarded: code-archive + strategy-archive
  하위 디렉토리. Strategy: receipt-only.
- **`skills/deep-evolve-workflow/protocols/completion.md`** — `M5.7.B — Optional
  reverse-handoff emit` 새 섹션. `.deep-work/handoffs/*.json`에서 상위 forward
  handoff을 자동 감지 (`to.producer === "deep-evolve"`로 필터, 가장 최근 선택)
  하고 `parent_run_id`를 chain. forward handoff이 없을 때는 evolve-receipt를
  chain parent로 fallback.
- **`tests/handoff-roundtrip.test.js`** — M5.5 #8 (deep-evolve 절반) 14개 assertion:
  `HANDOFF_REQUIRED`/`COMPACTION_REQUIRED`가 dashboard
  `PAYLOAD_REQUIRED_FIELDS["deep-evolve/{handoff,compaction-state}"]`와 동일,
  mirror된 `unwrapStrict`를 만족하는 envelope을 emit하는 reverse-handoff CLI
  roundtrip, round-trip closure (`reverse-handoff.envelope.parent_run_id ===
  forward-handoff.envelope.run_id`), trigger enum 6개 값 커버리지, 실패 경로
  (필수 필드 누락 → exit 1).

### Changed

- **`hooks/scripts/envelope.js`** — `ALLOWED_ARTIFACT_KINDS`를
  `{evolve-receipt, evolve-insights}`에서 `handoff`와 `compaction-state` 포함으로
  확장. evolve-receipt / evolve-insights 호출자의 기존 identity-triplet 의미론은
  그대로 유지.
- **`scripts/validate-envelope-emit.js`** — `ALLOWED_KINDS`를 대칭 확장하여
  CI validator가 두 신규 envelope kind를 수락.

### Notes

- 이 릴리스는 신규 artifact kind에 대해 **producer-only**. deep-evolve는 다른
  플러그인의 `handoff.json` / `compaction-state.json`을 consume 하지 않으며 —
  dashboard가 한다. Cross-plugin contract는 `claude-deep-dashboard/lib/
  suite-collector.js unwrapStrict`가 enforce.
- Round-trip closure: `.deep-work/handoffs/*.json`에 현재 세션과 매칭되는
  forward handoff (`producer = "deep-work"`, `to.producer = "deep-evolve"`)
  가 있으면 reverse handoff의 `parent_run_id`가 이를 닫고 dashboard의
  `suite.handoff.roundtrip_success_rate`가 1.0으로 수렴.
- M5 acceptance criteria는 `claude-deep-suite/docs/superpowers/plans/
  2026-05-11-m5.7-plugin-adoption-handoff.md` §M5.7.B 참조.

## [3.2.0] — 2026-05-08 (M3 공통 아티팩트 envelope)

`evolve-receipt.json`과 `evolve-insights.json` 두 산출물을 모두 M3 cross-plugin
envelope 컨트랙트로 emit하도록 전환한 minor 릴리스. 새 emit은 suite 전역
envelope (`schema_version: "1.0"` + `envelope` + `payload`,
[`claude-deep-suite/docs/envelope-migration.md`](https://github.com/Sungmin-Cho/claude-deep-suite/blob/main/docs/envelope-migration.md)
참조)로 wrap된다. 3.2.0 이전 receipt는 legacy fall-through로 그대로 읽히며,
`session.yaml` 스키마 변경 없음 — 기존 세션은 변경 없이 resume된다. M3 Phase 2
#4번째 plugin 작업.

### 추가
- **`hooks/scripts/envelope.js`** — zero-dep helper 모듈.
  `generateUlid` (MSB-first Crockford Base32 26자), `detectGit`,
  `loadProducerVersion` (모듈 `__dirname` 기준 literal-cwd-resolve),
  `wrapEnvelope`, `isEnvelope` (loose), `isValidEnvelope` (strict W4 gate),
  `unwrapEnvelope` (3-way identity check: producer/artifact_kind/schema.name).
- **`hooks/scripts/wrap-evolve-envelope.js`** — `completion.md` /
  `transfer.md`에서 호출하는 CLI wrapper.
  `--artifact-kind {evolve-receipt|evolve-insights}`, `--payload-file`,
  `--output`, 옵션 `--source-recurring-findings <path>` (evolve-receipt의
  `parent_run_id` chain), 반복 가능한 `--source-artifact` (evolve-insights
  multi-source aggregator) 지원. **Atomic write**: temp+rename
  (`<output>.tmp.<pid>.<ts>`) 패턴으로 동시 finisher · mid-write 중단 시에도
  truncated JSON이 남지 않는다.
- **`scripts/validate-envelope-emit.js`** — suite spec mirror self-test
  validator (`additionalProperties: false` on root / envelope / git /
  schema / provenance / source_artifacts items; `^x-`는 root + envelope
  에만 허용). `schema.name === artifact_kind` identity check, ULID
  Crockford Base32 26자, SemVer 2.0.0 (prerelease + build metadata 포함),
  RFC 3339, git head 7-40 hex, kebab-case kind. 두 신규 테스트 스위트가
  사용.
- **`tests/envelope-emit.test.js`** + **`tests/envelope-chain.test.js`** —
  70개 테스트. ULID lex-monotonicity, identity guard, corrupt-payload
  defense, `payload: null/false/array` 거부, fixture 검증,
  `additionalProperties` strict-mirror failure, parent_run_id chain
  (envelope-wrapped recurring-findings에서 자동 추출; 명시적 override
  보존; legacy recurring-findings는 path만 contribute), atomic-write
  no-residue 확인.
- **`tests/fixtures/sample-evolve-receipt.json`** +
  **`tests/fixtures/sample-evolve-insights.json`** — Phase 3 suite-side
  payload-registry placeholder 교체 input.

### 변경
- **`skills/deep-evolve-workflow/protocols/completion.md` § Evolve Receipt
  Generation** — payload 구성은 동일, 최종 write를 `wrap-evolve-envelope.js`
  경유로 변경. atomic temp+rename + gated cleanup (`set -euo pipefail` +
  `if helper; then rm tmp; else exit 1; fi` — helper 실패 시 payload temp
  보존하여 retry 가능). 사용자 선택 후 outcome 갱신은
  `jq --arg o ... '.payload.outcome = $o'` + atomic rename으로 in-place
  갱신해 `envelope.run_id`를 보존 (재 wrap 금지).
- **`skills/deep-evolve-workflow/protocols/transfer.md` § E.1 step 5** —
  `evolve-insights.json`을 M3 envelope으로 wrap. Multi-source aggregator
  semantics: `parent_run_id` **omit**;
  `~/.claude/deep-evolve/meta-archive.jsonl`,
  `.deep-review/recurring-findings.json` (존재 시) 같은 consumed source는
  `envelope.provenance.source_artifacts[]`에 들어간다.
- **`skills/deep-evolve-workflow/protocols/init.md` § Stage 3.5** —
  `.deep-review/recurring-findings.json` envelope-aware 읽기. Bash-only
  fast path 감지 (두 grep anchor — `"schema_version": "1.0"` /
  `"envelope":`), 그 후 `jq -e` 3-way identity guard 통과 시
  `.payload.findings` unwrap. `envelope.run_id`를 `session.yaml`의
  `cross_plugin.recurring_findings_run_id`에 기록하여 completion 단계의
  wrap helper가 `parent_run_id` chain 가능. 1.4.0 이전 deep-review emit
  (top-level `findings` 배열)은 fall-through로 동작.
- **`hooks/scripts/session-helper.sh` —
  `cmd_append_meta_archive_local` + `cmd_render_inherited_context`** —
  공유 `_RECEIPT_QUERY_BASE` jq 식으로 envelope-aware receipt read.
  Identity-checked unwrap (producer/artifact_kind/schema.name 3-way).
  같은 경로의 foreign-producer envelope은 root로 fall-through하여 legacy
  shape jq query가 null을 반환 (다른 plugin payload 누출 방지).
- **`skills/deep-evolve-workflow/protocols/history.md` § Step 1 detail
  mode** — envelope-aware receipt query 패턴 명시 (동일
  `_RECEIPT_QUERY_BASE` jq 식).
- **`package.json` `files` 배열** — `hooks/scripts/*.js`, `scripts/`,
  `tests/`를 포함하도록 확장하여 envelope helper / validator / fixture가
  플러그인 패키지에 함께 배포된다.
- **버전 bump** — `plugin.json.version` / `package.json.version`
  3.1.1 → 3.2.0 (minor — envelope adoption = 새 contract). 기존 v3.1
  세션은 그대로 `session.yaml.deep_evolve_version: "3.1.0"`을 emit하고
  변경 없이 resume; receipt **payload**의 version literal은 플러그인
  버전이 아닌 세션 기록 버전을 그대로 유지한다.

### Cross-plugin chain
- **deep-review → deep-evolve**: `evolve-receipt.envelope.parent_run_id`가
  `recurring-findings.envelope.run_id`로 chain (consumed file이 envelope일
  때 자동; helper는 `isValidEnvelope` strict gate를 사용해 corrupt envelope
  의 trace data 오염을 차단 — handoff §4 W4).
- **deep-evolve → deep-work**: deep-work v6.5.0+가 이미
  `gather-signals.sh`의 identity-guarded `read_json_safe`를 통해
  `.deep-evolve/<sid>/evolve-insights.json` envelope을 감지 — 소비자 측
  추가 변경 불필요.

### 호환성
- 3.2.0 이전 legacy receipt는 그대로 읽힘 — `isEnvelope`이 false 반환,
  `unwrapEnvelope`이 pass-through, jq base는 root로 fall-through.
- 같은 경로의 foreign-producer envelope → identity guard가 silent reject
  (`unwrapEnvelope`은 stderr warn, jq는 root로 fall-through).
- worktree 마이그레이션 불필요; 3.1.x에서 시작된 세션은 3.2.0에서 정상
  완료된다.

## [3.1.1] — 2026-04-26 (런타임 가드 강화)

v3.1.0 런타임 가드를 강화하는 패치 릴리스. 프로토콜·세션 스키마 변경 없음;
`session.yaml.deep_evolve_version`은 `"3.1.0"` 그대로 유지하며 모든 v3.1.0
세션은 v3.1.1에서 그대로 resume 가능 (forward-compatible). 패키지·헬퍼
버전만 상승 (`HELPER_VERSION` 3.1.0 → 3.1.1; `package.json` /
`plugin.json` / `SKILL.md` 3.1.0 → 3.1.1).

### 수정
- **`protect-readonly.sh` — Bash 측 seal_prepare_read 커버리지**
  (hooks/scripts/protect-readonly.sh): `seal_prepare_read=1` 세션에서
  Read 도구로 `prepare.py` / `prepare-protocol.md` 접근은 차단됐으나
  Bash 우회(`cat prepare.py`, `less prepare.py` 등)는 허용되던 문제 해결.
  새 헬퍼 `command_references` / `is_direct_prepare_execution`로 Bash
  참조도 동일 가드 경유. `python prepare.py` 직접 실행만 예외 허용.
- **`protect-readonly.sh` — 보호 파일 매칭**
  (hooks/scripts/protect-readonly.sh): write 감지용 정규식 화이트리스트를
  deny-by-default 매칭으로 교체 — 보호 파일에 대한 Bash 참조는 직접 실행
  예외가 아니면 모두 차단. 기존 정규식이 잡지 못한 엣지 케이스
  (`tee -a`, `perl -i`, 보호 경로로의 셸 치환) 해결.
- **`protect-readonly.sh` — per-seed `program.md` 보호**
  (hooks/scripts/protect-readonly.sh): worktree 경로
  `$SESSION_ROOT/worktrees/seed_*/program.md`도 세션 루트의 `program.md`와
  동일한 `program_update` / `outer_loop` META_MODE 게이트 적용. Inner-loop
  서브에이전트가 meta-mode 밖에서 per-seed `program.md`를 쓸 수 있던
  virtual-parallel 구멍 차단.
- **`scheduler-signals.py` — legacy `status` 키 허용**
  (hooks/scripts/scheduler-signals.py): 이전 헬퍼가 발행한 journal 이벤트는
  `event` 대신 `status`를 사용했음. 새 `event_type()` canonicalizer로
  두 키 모두 인식 — resume 시 pre-3.1 이벤트가 조용히 누락되던 문제 해결.
- **`scheduler-signals.py` — score lookup fallback**
  (hooks/scripts/scheduler-signals.py): inline `q`/`score` 필드가 없는
  `kept` 이벤트는 `(seed_id, id)` 키로 `evaluated` 이벤트에서 lookup.
  새 `numeric_q()`가 `isinstance(x, (int, float)) and not isinstance(x, bool)`
  강제하여 boolean의 numeric 강제 변환 차단.
- **`scheduler-signals.py` — `experiments_used_this_epoch` 신호**
  (hooks/scripts/scheduler-signals.py): per-seed 신호 추가 — 누적 experiment
  카운트와 현재 epoch 카운트를 분리. Fairness reset 이후 kill/grow
  의사결정에 필요.
- **`baseline-select.py` — killed-shortcut-quarantine 인식**
  (hooks/scripts/baseline-select.py): § 8.2 5.b non-quarantine 필터가
  `status == "killed_shortcut_quarantine"`도 거부하도록 확장 (기존
  `killed_reason == "shortcut_quarantine"` 검사 유지). status만 기록된
  세션에서 격리된 seed가 baseline에 누출되던 구멍 차단.
- **`status-dashboard.py` — terminal experiment dedup**
  (hooks/scripts/status-dashboard.py): per-seed experiment 카운터가
  `kept`/`discarded` 이벤트만 집계 (`evaluated` 제외)하고
  `(seed_id, experiment_id)` 키로 dedup — journal에 동일 experiment의
  `evaluated`와 후속 `kept`/`discarded`가 모두 기록되어 발생하던
  중복 카운팅 차단.
- **`session-helper.sh` — kill 이벤트 필드 견고성**
  (hooks/scripts/session-helper.sh): `seed_killed` 파싱이 null 또는
  비-string `condition` 허용, `killed_reason`(raw condition,
  `killed_` 접두 제거)과 `killed_reasoning`(자유 텍스트 사유)을 분리,
  이벤트의 옵션 `final_q` / `experiments_used` 보존.
- **`templates/prepare-stdout-parse.py` — missing-metric scoring**
  (templates/prepare-stdout-parse.py): stdout에서 `METRICS` 선언보다 적은
  메트릭이 파싱되면 score를 `0.0`으로 collapse — 이전엔 `score <= 0`
  ceiling 분기에 들어가 `2.0`(무한 개선)으로 잘못 분류되던 partial-parse
  실패를 수정.

### 추가
- **`hooks/scripts/tests/test_v31_protect_readonly.py`** (119줄):
  강화된 가드의 광범위한 커버리지 — Bash 우회 시도, 직접 실행 허용,
  per-seed `program.md` 보호, META_MODE 상호작용.
- **`hooks/scripts/tests/test_v31_scheduler_fairness.py`** (57줄):
  scheduler-signals fairness 동작 (`experiments_used_this_epoch` 의미).
- **`hooks/scripts/tests/test_v31_scheduler_signals.py`** (43줄):
  legacy `status` 키 허용, `numeric_q` fallback, `evaluated` 이벤트
  대상 score lookup.
- **`hooks/scripts/tests/test_package_manifest.py`** (18줄):
  `package.json` / `plugin.json` / `SKILL.md` / `HELPER_VERSION` 동기화
  단언 — 이번 릴리스가 패치하는 종류의 버전 drift 방지.
- **`hooks/scripts/tests/test_prepare_stdout_parse_template.py`**
  (61줄): partial-parse → `score = 0.0` 불변식 + 기존 scoring 경로 검증.
- **`hooks/scripts/tests/test_v31_baseline_select.py`** (14줄):
  `killed_shortcut_quarantine` status 경로 커버리지.
- **`hooks/scripts/tests/test_v31_status_subcommand.py`** (+38줄):
  per-seed terminal-experiment dedup 검증.

### 변경
- `session-helper.sh` `HELPER_VERSION` 3.1.0 → 3.1.1.
- `package.json` / `.claude-plugin/plugin.json` /
  `skills/deep-evolve-workflow/SKILL.md` version 3.1.0 → 3.1.1.
- `session-helper.sh` C-2 / C-3-A / C-3-B "Known limitations" 주석이
  이제 "future release"를 가리킴 (v3.1.1 자기 자신을 지칭하지 않도록;
  해당 구조적 수정은 backlog 유지).

### 마이그레이션
없음. v3.1.0 세션은 v3.1.1에서 변경 없이 resume. 새 가드는 다음
protect-readonly hook 발화 시 in-flight 세션에 자동 적용.

## [3.1.0] — 2026-04-26 (Virtual Parallel N-seed)

v3.0 AAR 기반 Inner/Outer Loop에 parallel N-seed 탐색을 추가하는 major
릴리스. 각 세션이 N=1..9개 독립 seed worktree를 적응형 스케줄러로 조정,
공유 forum으로 seed 간 관찰, 세션 종료 시 synthesis로 per-seed 결과를
단일 best 브랜치로 병합. `session.yaml.deep_evolve_version: "3.1.0"`로
게이팅. v3.0.x 세션은 VERSION_TIER 라우팅 (`pre_v3` / `v3_0` / `v3_1_plus`
4-arm, 4개 protocol 파일에 통일)으로 완전 지원.

### 추가
- **Virtual parallel N-seed** (§ 4 Architecture, § 5 Seed Lifecycle):
  N=1..9 seed worktree (`.deep-evolve/<sid>/seeds/<seed_id>/worktree/`).
  Coordinator가 prose contract로 subagent 발화; per-seed inner loop는
  기존 코드 경로 그대로, journal 이벤트에 `seed_id` 주입.
- **β/γ seed 구분** (§ 5): β (init 시 의도적 모호 방향, A.3에서 1회
  생성), γ (세션 중 `grow_then_schedule` 결정 시 AI 재생성).
  `seed_origin ∈ {β, γ}` in seed schema.
- **적응형 스케줄러** (§ 6): `hooks/scripts/scheduler-decide.py`가
  `ALLOWED_DECISION = {schedule, kill_then_schedule, grow_then_schedule}`
  중 하나 반환. `REQUIRED_BY_DECISION` per-decision 필수 필드 스키마 강제
  (kill_then_schedule: kill_target; grow_then_schedule: new_seed_id).
  Drift-detector 테스트가 dict-key parity 검증 — 향후 contributor가
  decision type 추가 시 schema 동기화 누락을 catch. Per-seed signals —
  Q, in_flight_block, borrows_received MIN-wins, last_keep_age.
  Session-wide signals — P3 allocation floor (default 3), fairness
  deficit. Soft fairness floor (§ 6.6).
- **Forum + borrow 교환** (§ 7): `.deep-evolve/<sid>/forum.jsonl`
  append-only, flock 보호. 2단계 borrow lifecycle —
  `borrow_planned` (journal-side, Step 5.f intent marker) →
  `cross_seed_borrow` (forum-side, 다음 kept commit에서 차용 실행 시 발행),
  `borrow_abandoned` (journal-side janitor)는 `cross_seed_borrow`로 이어지지
  않은 채 2 블록 이상 stale 상태인 planned 이벤트를 정리. Forum 필드
  SOT — `to_seed`/`from_seed` (`_id` 접미사 없음), 코드베이스 8+
  사이트에 통일. `dedup_planned`는 journal-side `borrow_planned` 키 기반,
  `dedup_executed`는 forum-side `cross_seed_borrow` 키 기반 (data-source
  계약 spec § 7.1). `borrows_received` MIN-wins per § 7.4 P1.
- **Borrow guardrails** (§ 7.4 P2/P3): `hooks/scripts/borrow-preflight.py`가
  P2 flagged 필터 (shortcut/legibility-failed source 차단) + P3 allocation
  floor + per-(borrower, source_commit) dedup 강제.
- **Convergence classifier** (§ 7.5): `hooks/scripts/convergence-detect.py`
  3-class borrow-ancestry-closure 분류 — `evidence_based`,
  `borrow_chain_convergence`, `contagion_suspected`. Outer Loop이 각각
  2× / 1× / 0 stagnation credit 가중.
- **Kill 관리** (§ 5.5): `hooks/scripts/kill-conditions.py` 5-condition
  whitelist (§ 5.5a 4-clause `sustained_regression` pseudocode 충실 구현);
  `hooks/scripts/kill-request-writer.sh`로 `--kill-seed` CLI 처리;
  `session-helper.sh` `append_kill_queue_entry` / `drain_kill_queue`로
  W-9 in-flight 지연 + Phase 2/3 snapshot-then-process atomicity.
  `seed_killed` 이벤트가 `queued_at`/`applied_at`/`final_q`/`experiments_used`
  carry.
- **세션 종료 synthesis** (§ 8): `synthesis.md` 7-step orchestration +
  N=1 short-circuit (§ 8.5). `baseline-select.py` 4-step cascade
  (5.a preferred → 5.b non-quarantine → 5.c best-effort → 5.d no-baseline)
  + 4-level tiebreak (final_q → keeps → borrows → seed_id).
  `cross-seed-audit.py` Step 3 forum 집계 (borrow matrix + convergence
  tally + per-seed activity). `generate-fallback-note.py`로 § 8.2
  verbatim 한국어 AskUserQuestion 옵션 포함 구조화 fallback 설명 발행.
- **Synthesis worktree helper** (§ 4.1, § 8.2 Step 5):
  `session-helper.sh` `cmd_create_synthesis_worktree` /
  `cmd_cleanup_failed_synthesis_worktree` (실패 시 branch를
  `synthesis-failed-<ts>`로 rename, 감사 trail 보존).
- **Init 흐름** (§ 5, § 13): A.1.6에서 AI가
  (project_type, eval_parallelizability) 기반 `n_suggested` 분류 (1..9
  matrix). A.2.6 AskUserQuestion으로 N 확정 (`DEEP_EVOLVE_NO_PARALLEL` /
  `DEEP_EVOLVE_N_MIN` / `DEEP_EVOLVE_N_MAX` env var 존중).
  A.3.6 per-seed worktree 생성 + β 생성 + per-seed program.md +
  session.yaml seeds[] 채움. `init_vp_analysis` / `seed_initialized`
  journal 이벤트 신설 (coordinator 측 `(unset SEED_ID; ...)` subshell로
  per-seed SEED_ID 격리).
- **Resume 재구성** (§ 11): resume.md Step 3.5 v3.1 reconciliation —
  3.5.a yaml + journal seed-set read; 3.5.b W-3 drift detection +
  prefer-journal resolution + `resume_drift_detected` 이벤트 +
  `rebuild_seeds_from_journal` helper; 3.5.c per-seed
  `validate_seed_worktree` (rc=3 → AskUserQuestion W-11.1 복구,
  rc=4/5/6 → exit 1); 3.5.d git-log-is-truth replay (§ 11.3,
  `planned_commit_sha` / `pre_plan_head_sha` 매칭 → synthesized
  `committed`/`discarded`).
- **CLI 플래그** (§ 13): `--no-parallel`, `--n-min=<k>`, `--n-max=<k>`,
  `--kill-seed=<id>`, `--status` 서브커맨드. 교차 불변식 N_MIN ≤ N_MAX
  강제 (위반 시 rc=2). `--status`는 `hooks/scripts/status-dashboard.py`
  pure-function helper로 디스패치, § 13.1 per-seed 대시보드 출력.
- **Meta-archive schema_v4** (§ 10, § 9.4): `transfer.md` 4-arm version
  gate (`2` / `3` / `4` / `>=5`). v3 entry → `N_prior=1`,
  v4 entry → A.1.6 classifier에 prior signal로 들어가는 full
  `virtual_parallel` snapshot. Section F prune candidates에 v3-schema
  270-day 룰 추가 (v2-schema 180-day 룰과 평행).
- **VERSION_TIER 라우팅**: `$VERSION_TIER ∈ {pre_v3, v3_0, v3_1_plus}` +
  `IS_V31` boolean이 4개 protocol 파일 (inner-loop.md, outer-loop.md,
  synthesis.md, coordinator.md)에 canonical. 4-arm case 패턴 통일 —
  virtual_parallel-DEPENDENT sub-step은 `v3_1_plus`로 게이팅;
  virtual_parallel-INDEPENDENT (shortcut_detection, seal_prepare)은
  `!= pre_v3`로 게이팅.
- **Pytest 테스트 스위트** (§ 12.1 W-8 per-file enumeration): 40개
  `test_v31_*.py` 파일이 v3.1 표면 전부를 검증 — borrow lifecycle
  (`borrow_abandoned`, `borrow_guardrails`, `borrow_preflight`),
  scheduler (`scheduler_decide`, `scheduler_decision`,
  `scheduler_signals`, `scheduler_fairness`), kill 관리
  (`kill_conditions`, `kill_queue`, `kill_request`, `kill_seed_cli`),
  forum + cross-seed (`forum_io`, `forum_summary`, `cross_seed_audit`,
  `convergence_detect`, `step_5e_forum_emission`), synthesis
  (`baseline_select`, `synthesis_protocol`, `synthesis_worktree`,
  `synthesis_fallback`, `fallback_note`), seed lifecycle (`beta_init`,
  `beta_growth`, `budget_alloc`, `worktree_manager`, `worktree_helpers`,
  `write_seed_program`), init + resume (`init_protocol`, `resume_v31`,
  `session_yaml_schema`, `journal_events`, `transfer_schema_v4`),
  CLI + status (`cli_flags`, `status_subcommand`, `helper_locator`),
  protocol fixtures (`coordinator_protocol_exists`, `version_gate`,
  `inner_loop_updates`, `outer_loop_updates`, `subagent_prompt`).
  합계 517 passed, 1 xfailed (T22 polling gap intentional surface).
- **신규 fixtures**: `multi_seed_mock/`, `synthesis_regression/`,
  `forum_multi_seed/`, `forum_malformed/`, `v3_0_resume_sample/`,
  `transfer_schema_v3/`, `transfer_schema_v4/`, `kill_scenarios/`
  (4 sub-fixtures), `borrow_scenario/`.

### 변경
- `session.yaml` 스키마: `deep_evolve_version: "3.1.0"`; 신규
  `virtual_parallel` 블록. 최상위 필드: `n_current` (int, 활성 seed 수),
  `n_initial` (int, 세션 init 시 값), `n_range` (`{min: 1, max: 9}`,
  AI 허용 N 범위), `budget_total` (int, seed들이 공유하는 총 실험 예산).
  Per-seed `seeds[]` 항목: `id` (int, seed 식별자), `status ∈ {active,
  killed, completed}`, `direction` (str, β/γ 방향 요약), `hypothesis`
  (str, 초기 가설), `initial_rationale` (str), `worktree_path`, `branch`,
  `created_at` (ISO 8601), `created_by ∈ {init_batch, grow_then_schedule}`
  (init-time vs 세션 중 γ 대체 — runtime에서 spec의 β/γ 구분 역할),
  `experiments_used`, `keeps`, `borrows_given`, `borrows_received`
  (MIN-wins per § 7.4 P1), `current_q` (float, 최신 Q score),
  `allocated_budget` (int, 이 seed의 `budget_total` 분배몫), `killed_at`
  (null|ISO), `killed_reason` (null|str). 블록 크기 (`{1, 2, 3, 5, 8}`)는
  scheduler turn마다 AI Q3 판단으로 결정 — session.yaml 필드가 **아님**;
  `seed_scheduled` journal 이벤트에 기록.
- `journal.jsonl` v3.1 확장 이벤트 (journal-side): `seed_initialized`,
  `seed_block_completed`, `seed_block_failed`, `seed_killed`
  (`queued_at`/`applied_at`/`final_q`/`experiments_used` 포함),
  `init_vp_analysis`, `resume_drift_detected`, `synthesis_commit`,
  `synthesis_failed`, `borrow_planned`, `borrow_abandoned`,
  `seed_scheduled`. v3.1-specific 이벤트는 coordinator 발행 시
  `(unset SEED_ID; ...)` subshell로 작성 (per-seed inner-loop subagent는
  seed-scoped SEED_ID 그대로 사용). Forum-side 이벤트 (`cross_seed_borrow`,
  `convergence_event`)는 `forum.jsonl`에 별도 기록 (§ 7.1 data-source 계약).
- `forum.jsonl` (신규) — `.deep-evolve/<sid>/forum.jsonl`, append-only,
  flock 보호. 필드 SOT: `to_seed`/`from_seed` (`_id` 접미사 없음).
  malformed 라인은 tail-skip-and-warn (data-flow 방향:
  consumer-tolerance로 partial-event 견고성).
- `kill_requests.jsonl` (신규) — pending kill 큐. Coordinator가 다음
  scheduler turn에서 `drain_kill_queue` + AskUserQuestion 확정;
  W-9 in-flight 지연; W-1 HELPER_SOURCED 가드.
- `meta-archive.jsonl` schema_v4 — E.0 recording에
  `virtual_parallel` snapshot 추가. v3.0.x 세션은 schema_version=3 유지
  (snapshot 없음); v2/v3/v4 셋이 공존.
- `protocols/inner-loop.md` Step 0.5 (block params 입수 + seed_id 태깅
  계약 — Gap 4 close); v3.1 forum 협의 in Step 1; Step 5.f borrow
  평가 (borrow-preflight.py 호출).
- `protocols/outer-loop.md` Step 6.5.0 (epoch boundary sync:
  forum-summary.md 생성, convergence 감지, AI N 재평가) + 6.5.6 v3.1
  addendum (evidence_based −2 / borrow_chain_convergence −1 /
  contagion_suspected 0 + WARN + AskUserQuestion 에스컬레이션).
  Per-substep VERSION_TIER 게이트.
- `protocols/synthesis.md` (신규) — 7-step orchestration + N=1
  short-circuit + Step 6 3-branch fallback ladder (§ 8.2 verbatim
  AskUserQuestion 옵션).
- `protocols/coordinator.md` (신규) — coordinator dispatch protocol +
  scheduler-decide invocation 계약 + forward-compat VERSION_TIER 게이트.
- `commands/deep-evolve.md` Step 0.5 — 4 신규 플래그 (`--no-parallel`,
  `--n-min`, `--n-max`, `--kill-seed`) + `--status` 서브커맨드. Env-var
  플래그가 init.md A.2.6으로 전파.
- `transfer.md` schema_version=4 read path. W-1 forward-compat default
  `*)` skip + warn; v5+는 rc=2로 명시 거부.
- `session-helper.sh` HELPER_VERSION 3.0.0 → 3.1.0; 신규 서브커맨드
  `append_seed_to_session_yaml`, `set_virtual_parallel_field`,
  `cmd_create_synthesis_worktree`, `cmd_cleanup_failed_synthesis_worktree`,
  `append_kill_queue_entry`, `drain_kill_queue`,
  `rebuild_seeds_from_journal`.

### 마이그레이션
- v3.0.x 세션은 v3.1 코드 하에서 VERSION_TIER 라우팅으로 resume —
  `v3_0` arm이 single-seed 코드 경로 그대로 보존. 스키마 마이그레이션
  없음; v3.0 세션은 meta-archive에서 schema_version=3 유지.
- v3.1 세션은 schema_version=4 entry에 `virtual_parallel` snapshot 기록.
  v3.0 reader는 알 수 없는 블록 무시 (additive 스키마; § 9.4 R12 완화).
- N=1 경로: v3.1 세션이 `--no-parallel` 또는 AI 결정으로 N=1로 실행
  가능 — v3.0 single-seed와 동작 등가지만 v3.1 스키마와 이벤트 이름
  사용. Resume 시 `session.yaml.virtual_parallel.N == 1`로 short-circuit.
- Deprecation 로드맵 (변경 없음): 3.0.x v2 full support → 3.1.0 warning
  → 3.2.0 read-only completion → 4.0.0 v2 스키마 제거. v3.1은 v3.0의
  v2-warning 배너를 VERSION_TIER `pre_v3` arm으로 유지.

### 알려진 문제 (3.1.x로 연기)
G12 review iteration 2026-04-26 중 5개 non-blocking polish 항목 연기.
각 항목은 비-차단으로 경험적 검증 완료, v3.1.x patch backlog로 ticketing.

- **H1**: `--signals` JSON 파싱이 `scheduler-decide.py`의 business
  rejection 이후 실행 (G3 ordering 패턴을 signals 경로로 확장 필요).
  Cosmetic — signals는 AI 입력이라 decision JSON보다 malformed 가능성
  낮음. Patch에서 business rejection 이전으로 이동 예정.
- **H2**: `nsa < 3` 숫자 가드가 type+business를 단일 rc=1 경로에 통합.
  Type 에러(non-int)를 below-P3-floor business rejection으로 오분류.
  Coordinator가 적절히 거부하긴 하나 메시지가 오해 소지. Patch에서
  type-validation(rc=2)과 business rejection(rc=1) 분리 예정.
- **I1**: `coordinator.md:134-139` pseudocode가
  `append_kill_queue_entry(validated.kill_target, reasoning)` (2 args)
  표시하나 helper는 4 args 요구. Pseudocode-only (직접 실행되는 bash
  아님) — AI agent가 `session-helper.sh` 읽고 실제 시그니처 추론. Patch에서
  pseudocode를 helper 시그니처와 정렬 예정.
- **I2c**: Scheduler decision 필드 (`kill_target`, `new_seed_id`)를
  `--signals.seeds`와 cross-validation하려면 signals correlation 복잡도
  필요 — 예: 존재하지 않는 seed에 `kill_target=999`, 기존 seed와
  `new_seed_id=1` 충돌 감지. 구현 전 design discussion 필요. Patch에서
  `scheduler-decide.py` cross-field validator 확장 가능.
- **info-2**: `coordinator.md`의 pseudocode-only 배너 — 문서 명료성
  polish, 기능적 영향 없음. Patch에서 해당 블록 위에 명시적
  "PSEUDOCODE — see session-helper.sh for actual signatures" 헤더 추가
  예정.

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
