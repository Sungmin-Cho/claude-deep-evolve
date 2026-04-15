# deep-evolve Session History & Lineage 설계 (2026-04-15, rev2 after 3-way review)

**작성 시점**: 2026-04-15 (rev2: 3-way deep-review 피드백 반영)
**배경**: `docs/improvements-from-quant-phase-e-session-2026-04-15.md`의 후속. Quant 프로젝트에서 Phase E → Phase F로 넘어갈 때 "이전 세션의 전략 진화 과정과 meta-analysis를 이어받아 참조하고 싶다"는 요구가 실제로 발생했으나, 현재 deep-evolve는 `.deep-evolve/` 디렉터리 하나가 세션 단위로 덮어써지는 구조라 지원 불가. deep-work 플러그인의 session registry + receipt + resume/history 패턴을 참고하되, deep-evolve의 실행 특성에 맞춰 재설계.
**범위**: 이 문서는 설계만 담는다. 구현은 별도 PR에서 진행.

**rev2 반영 사항 (3-way 리뷰 대응)**:
- X1 resume 상태 persistence (journal 이벤트 실제 스키마 + inner_count 승격)
- X3 program.md canonical 레이아웃 + sentinel 주석
- X4 current.json을 immutable pointer로 축소, status 권위 = session.yaml
- X5 sessions.jsonl (append-only, event-sourced) + derived state
- X6 dispatcher orphan 검증
- X7 migrate_legacy copy-verify-pointer-delete 시퀀스
- X8 namespace 실행 맵에 inner-loop.md / archive.md / transfer.md 추가 + `$SESSION_ROOT` 추상화
- X9 상속된 keeps를 informational only로 격하 (code-archive replay 제거)
- X10 history source 우선순위 반전 (sessions.jsonl 먼저, receipt는 상세 모드만)
- X11 score_delta 정의 + tie-break 규칙 + source 필드 유지
- X12 generation_snapshots 캡 N=10 (초과 시 summary-only)
- X13 runtime_warnings[] 추가
- X14 parent receipt 스키마 버전 체크 + graceful degradation
- X15 shell helper 이식성 가이드
- X16 downgrade 경로

---

## 0. 요약

deep-evolve에 **5계층 히스토리 시스템**을 도입한다.

1. **세션 namespace** — `.deep-evolve/<session-id>/`로 per-session 디렉터리, `current.json` immutable pointer와 `sessions.jsonl` event-sourced registry.
2. **Immutable session receipt 확장** — `evolve-receipt.json`에 experiments_table, generation_snapshots(캡 10), notable_keeps, runtime_warnings, parent_session을 embed해 디렉터리 휘발 후에도 완전 재현.
3. **`/deep-evolve resume`** — 중단된 세션 재진입. journal의 실제 이벤트(`planned`/`committed`/`evaluated`/`kept`/`discarded`)로 orphan 감지 후 inner-loop에 재합류.
4. **`/deep-evolve history`** — 이 프로젝트의 세션 목록/aggregate/trend 뷰. `sessions.jsonl` 먼저, `meta-archive-local.jsonl`은 집계 보강.
5. **Session lineage** — 새 세션이 선행 세션의 최종 strategy/program을 seed로, notable keeps를 **informational hint**로 이어받음 (git-level replay 없음).

기존 `~/.claude/deep-evolve/meta-archive.jsonl`은 **cross-project transfer** 용으로 유지하고, 본 설계는 **within-project continuity**를 새로 채운다. 두 계층은 직교.

---

## 1. 왜 deep-work 구조를 그대로 쓸 수 없나

| 축 | deep-work | deep-evolve | 설계 함의 |
|---|---|---|---|
| 단위 | phase (brainstorm/research/plan/implement/test) | experiment N회 루프 | resume은 phase 복원이 아니라 "experiment 번호 재진입" |
| 산출물 크기 | slice당 receipt ~수십 KB | 세션당 수백 MB (`runs/run-NNN.log`) | log는 per-session dir에 그대로 두고, receipt에는 embed 금지 |
| 동시 세션 | 다수 (registry 필수) | 통상 단일. 하지만 Phase A→B→... 연쇄 흔함 | registry는 lightweight로, lineage(부모 세션 포인터)가 핵심 |
| 글로벌 기록 | `session-receipt.json` shard | `meta-archive.jsonl` (cross-project 전용) | within-project는 새 파일 필요 |

deep-work의 "session registry + per-session state + receipt + resume/history 커맨드" 틀은 그대로 차용. 하지만:
- **phase_context 복원** 대신 **experiment_number 복원**
- **slice receipt** 대신 **generation snapshot** (outer loop 세대가 deep-evolve의 의미 있는 단위)
- **multi-session 선택 UI**는 lineage 선택(부모 세션)으로 재해석

---

## 2. 현재 상태의 결핍 (이 설계가 해결할 문제)

1. **세션 덮어쓰기**: init flow가 `.deep-evolve/`를 재생성할 때 Phase E의 `results.tsv`, `journal.jsonl`, `code-archive/`가 모두 사라짐. Quant에서 실제 발생함 (Phase E final report 손실).
2. **중단 불가역성**: 실험 N회째에 세션이 끊기면 복구 프로토콜이 없다. 사용자는 처음부터 다시 시작하거나 수동으로 session.yaml을 편집해야 함.
3. **Meta-analysis 휘발**: `.deep-evolve/meta-analysis.md`는 outer loop Tier 1 실행마다 덮어쓰기. Phase E gen 1의 meta-analysis가 gen 2로 넘어가면 읽을 수 없음.
4. **Cross-session narrative 부재**: "이 프로젝트에서 지금까지 총 몇 번의 세션, 누적 실험 수, keep rate 추이는?"에 답할 데이터 없음.
5. **Phase 간 seed 부재**: Phase F는 Phase E의 결론을 수기로 program.md에 복붙해야 함. 재현성 없음.

---

## 3. 5계층 설계

### 3.1 Layer 1 — 세션 namespace

#### 3.1.1 디렉터리 레이아웃

```
.deep-evolve/
├── current.json                      # 활성 세션 immutable pointer
├── sessions.jsonl                    # 세션 registry (append-only event log)
├── meta-archive-local.jsonl          # 완료 세션 요약 누적 (append-only, summary)
│
├── 2026-04-15_phase-e/               # per-session dir (= $SESSION_ROOT)
│   ├── session.yaml
│   ├── strategy.yaml
│   ├── program.md
│   ├── prepare.py                    # eval_mode=cli 시
│   ├── prepare-protocol.md           # eval_mode=protocol 시
│   ├── results.tsv
│   ├── journal.jsonl
│   ├── meta-analyses/                # 세대별 append (!덮어쓰기)
│   │   ├── gen-1.md
│   │   └── gen-2.md
│   ├── runs/
│   ├── code-archive/                 # 이 세션에서 만든 keep 커밋만
│   ├── strategy-archive/
│   ├── report.md                     # 완료 시
│   └── evolve-receipt.json           # 완료 시 freeze
│
└── 2026-04-22_phase-f/
    └── ...
```

**`$SESSION_ROOT` 추상화 (X8 반영)**: 기존 프로토콜들이 `.deep-evolve/strategy.yaml` 처럼 하드코딩한 경로는 전부 `$SESSION_ROOT/strategy.yaml`로 치환된다. `$SESSION_ROOT`는 `session-helper.sh resolve_current`가 계산. 영향받는 파일은 §5 구현 매핑 표 참조.

#### 3.1.2 session_id 규칙

- 형식: `YYYY-MM-DD_<goal-slug>`
- `<goal-slug>` 정규화 (X15 반영):
  - 소문자화 → `[^a-z0-9]+` → `-` → 연속 `-` collapse → 앞/뒤 `-` trim → 40자 truncate
  - Unicode(한국어 등) → 결과가 빈 문자열이면 `session-<sha1(goal)[:6]>` fallback
  - goal 자체가 비면 `session-<sha1(timestamp)[:6]>`
- 충돌 체크: `sessions.jsonl` 리플레이로 동일 id 있으면 `-2`/`-3` 증가
- Human-readable + sortable 필수 (history 뷰에서 그대로 표시)

#### 3.1.3 `.deep-evolve/current.json` (immutable pointer, X4 반영)

```json
{
  "session_id": "2026-04-15_phase-e",
  "started_at": "2026-04-15T09:14:00Z"
}
```

**의도적으로 최소화**:
- `status` 필드 없음 — 권위는 `$SESSION_ROOT/session.yaml.status` 단일 소스
- `last_activity` 없음 — 고빈도 갱신을 회피. 마지막 활동 시각이 필요하면 `journal.jsonl` 마지막 라인 timestamp 또는 `session.yaml.updated_at`에서 읽음
- 세션 교체 시에만 `session-helper.sh start_new_session`이 `.tmp → mv` 원자 치환으로 재작성

**파일 부재 == "활성 세션 없음"**. `session_id: null`도 동일 의미로 허용.

#### 3.1.4 `.deep-evolve/sessions.jsonl` (event-sourced registry, X5 반영)

각 줄은 하나의 세션 이벤트. derived state는 리플레이로 계산.

```jsonl
{"event":"created","ts":"2026-04-15T09:14:00Z","session_id":"2026-04-15_phase-e","goal":"...","parent_session_id":"2026-04-08_phase-d"}
{"event":"status_change","ts":"2026-04-15T12:30:00Z","session_id":"2026-04-15_phase-e","status":"paused"}
{"event":"status_change","ts":"2026-04-15T12:35:00Z","session_id":"2026-04-15_phase-e","status":"active"}
{"event":"finished","ts":"2026-04-16T08:11:00Z","session_id":"2026-04-15_phase-e","status":"completed","outcome":"merged","experiments_total":52,"experiments_kept":4,"best_score":0.612,"q_final":-0.87}
```

**이벤트 타입**:
- `created`: 세션 초기화 완료 직후
- `status_change`: active ↔ paused 전이
- `finished`: 완료/중단 (status + outcome 기록)
- `migrated`: 자동 마이그레이션에 의해 생성된 세션

**race 안전성**: POSIX `O_APPEND`는 `PIPE_BUF`(일반적으로 4KB) 미만 쓰기에 대해 원자적. 각 라인은 1KB 미만으로 유지. macOS/Linux 모두 커버.

**derived current state**: `session-helper.sh list_sessions`가 sessions.jsonl을 리플레이해 `{session_id → {goal, status, outcome, ...}}` 맵 생성.

#### 3.1.5 hook 경로 동적화 (X4 + X8 반영)

`hooks/scripts/protect-readonly.sh`:

```bash
# find_evolve_root → .deep-evolve/ 있는 조상 디렉터리
PROJECT_ROOT="$(find_evolve_root)"

# 1) pointer 읽기
CURRENT_JSON="$PROJECT_ROOT/.deep-evolve/current.json"
if [[ -f "$CURRENT_JSON" ]]; then
  SESSION_ID="$(jq -r '.session_id // empty' "$CURRENT_JSON" 2>/dev/null)"
fi

# 2) session_id가 null/empty이거나 dir 부재면 → v2.2.0 의미로는 "활성 세션 없음" → 허용
if [[ -z "$SESSION_ID" || ! -d "$PROJECT_ROOT/.deep-evolve/$SESSION_ID" ]]; then
  # legacy fallback: .deep-evolve/session.yaml이 root에 있으면 v2.1.x 레이아웃
  if [[ -f "$PROJECT_ROOT/.deep-evolve/session.yaml" ]]; then
    SESSION_ROOT="$PROJECT_ROOT/.deep-evolve"  # legacy
  else
    exit 0  # 활성 세션 없음, 모든 쓰기 허용
  fi
else
  SESSION_ROOT="$PROJECT_ROOT/.deep-evolve/$SESSION_ID"
fi

# 3) status 권위 단일 = session.yaml
STATUS="$(grep '^status:' "$SESSION_ROOT/session.yaml" 2>/dev/null | head -1 | sed 's/^status:[[:space:]]*//')"
if [[ "$STATUS" != "active" ]]; then
  exit 0
fi

# 4) 보호 대상
PROTECTED_PREPARE="$SESSION_ROOT/prepare.py"
PROTECTED_PROTOCOL="$SESSION_ROOT/prepare-protocol.md"
PROTECTED_PROGRAM="$SESSION_ROOT/program.md"
PROTECTED_STRATEGY="$SESSION_ROOT/strategy.yaml"
# ... 기존 META_MODE 분기 유지
```

**추가 보호 대상**: `.deep-evolve/current.json` 자체와 `.deep-evolve/sessions.jsonl`은 helper script만 write. helper는 `DEEP_EVOLVE_HELPER=1` env var를 설정하고 hook이 이 플래그를 존중하도록 (기존 `DEEP_EVOLVE_META_MODE` 패턴과 동일).

#### 3.1.6 program.md canonical 레이아웃 (X3 반영)

`program.md`의 최상단 섹션 순서를 고정한다. PR#1 (3.C)과 PR#2 (Layer 5)가 모두 이 순서를 존중.

```markdown
# <session title (goal에서 자동 생성)>

<!-- automation-policy-v1 -->
## Automation Policy

- Outer Loop는 diminishing-returns 감지 시 `session.yaml.outer_loop.auto_trigger`가 true면 자동 실행…
- AskUserQuestion은 outer 완료 후…

<!-- /automation-policy-v1 -->

<!-- inherited-context-v1 -->
## Inherited Context (from <parent_session_id>)   <-- continue 선택 시에만; else 섹션 전체 생략

### 이어받은 전략 패턴 (strategy.yaml v<N>)
<bullets>

### 선행 세션에서 참조할 만한 개선 (informational only)
<notable_keeps 설명만; 커밋 해시는 참조용. git replay 없음>

### 선행 세션의 최종 교훈
<meta-analysis 발췌>

<!-- /inherited-context-v1 -->

## <project-specific body>
...
```

**주의**:
- Automation Policy는 **항상 존재** (3.C에서 init.md가 삽입)
- Inherited Context는 **조건부** (continue 선택 시에만 삽입)
- 두 섹션 모두 `<!-- xxx-v1 -->` sentinel 주석으로 교체 지점 명시 — 향후 프로토콜 버전 업그레이드 시 helper가 이 앵커로 섹션을 찾아 교체

---

### 3.2 Layer 2 — Immutable session receipt 확장

#### 3.2.1 스키마 (v2.2.0)

```json
{
  "version": "2.2.0",
  "receipt_schema_version": 2,              // 파서 가드용 (X14: 소비자는 이 값 체크)
  "session_id": "2026-04-15_phase-e",
  "timestamp": "...",
  "goal": "...",

  "experiments": { "...기존..." },
  "score": { "...기존..." },
  "strategy_evolution": { "...기존..." },
  "program": { "...기존..." },
  "evaluation_epochs": "...",
  "archives": { "...기존..." },
  "transfer": { "...기존..." },
  "duration_minutes": "...",
  "quality_score": "...",
  "outcome": "...",

  "experiments_table": [
    {"n": 33, "commit": "abc123def", "score": 0.4201, "status": "discard",
     "description": "...", "generation": 1}
  ],

  "generation_snapshots": [                 // 최대 10개 (X12)
    {"generation": 1, "started_at_experiment": 33, "ended_at_experiment": 42,
     "q_value": -2.33,
     "strategy_yaml_content": "<full>",
     "program_md_content": "<full>",
     "meta_analysis_content": "<full>",
     "triggered_by": "consecutive_discard_limit",
     "summary_only": false}
    // 10개 초과 시 오래된 entry부터 summary-only로 대체:
    // {"generation": 1, ..., "meta_analysis_summary": "<첫 단락>",
    //  "strategy_yaml_content": null, "program_md_content": null, "summary_only": true}
  ],

  "notable_keeps": [
    {"n": 45, "commit": "def456abc", "score_delta": 0.182,
     "description": "switch to GARCH(1,1)", "generation": 2,
     "source": "top_n"}                     // "top_n" | "marked" (X11)
  ],

  "runtime_warnings": [                     // X13: 세션 중 dismiss된 경고 기록
    {"type": "branch_mismatch", "at_experiment": 45,
     "expected": "feature/phase-e", "actual": "main",
     "user_action": "proceed_on_current", "ts": "..."}
  ],

  "parent_session": {                       // Q0-A: 최상위 분리
    "id": "2026-04-08_phase-d",
    "parent_receipt_schema_version": 2,     // X14: 상속 시 조회한 parent의 버전
    "seed_source": {
      "strategy_version": 3,
      "program_version": 2,
      "notable_keep_commit_refs": ["xyz789"]  // informational only (X9)
    },
    "inherited_at": "2026-04-15T09:14:00Z"
  }
}
```

#### 3.2.2 `score_delta` 정의 (X11)

`notable_keeps[].score_delta` = 해당 keep 커밋의 score − **동일 generation 내 직전 kept 커밋의 score**. 해당 generation의 첫 keep이면 generation 시작 시점 score(직전 generation의 `q_value` 계산 baseline) 대비.

**Tie-break**: `score_delta` 동률 시 `n` 오름차순 (더 이른 실험 우선).

**결정적 재계산**: receipt 생성 시 위 알고리즘 고정 → 재생성해도 동일 결과.

#### 3.2.3 `generation_snapshots` 크기 제한 (X12)

- 기본 cap: `N=10`
- 10개 초과 시 **오래된 것부터** summary-only 형태로 치환:
  - `meta_analysis_content` → `meta_analysis_summary` (첫 단락만)
  - `strategy_yaml_content`, `program_md_content` → null
  - `summary_only: true` 플래그
- 대안: `$SESSION_ROOT/generation-snapshots/gen-<N>.json`로 개별 파일 저장하고 receipt에는 참조만. 디스크 여유 있으면 추천. v2.2.0 기본은 inline cap 방식.

#### 3.2.4 notable_keeps 선정 로직 (X11 정제)

1. `journal.jsonl`에서 `outer_loop` 이벤트 중 `notable: true` 플래그 항목 수집 → `source: "marked"`
2. 나머지 `status=kept` 실험을 §3.2.2 `score_delta` 내림차순 정렬, `source: "top_n"`로 부족분 채움 (기본 N=5)
3. 중복은 `"marked"` 우선
4. Tier 2 마킹은 v2.2.0에서 **선택적**. v2.3에서 의무화 검토.

**설계 대안 (폐기됨)**: v2.2.0에 Tier 2 마킹 단계를 강제 도입하는 안은 복잡도 대비 이득 적어 기각. 대신 `source` 필드는 schema에 포함해 v2.3 마킹 도입 시 breaking change 없이 활용.

#### 3.2.5 receipt 파서 가드 (X14)

모든 receipt 소비자(history, resume, transfer, lineage init)는:
```
if receipt.receipt_schema_version > KNOWN_MAX_VERSION:
  warn "unknown schema version — fields may be missing"
  proceed with best-effort
if receipt.receipt_schema_version < CURRENT_MIN_VERSION:
  if missing_critical_fields: error and abort
  else: graceful degradation with explicit logging
```

---

### 3.3 Layer 3 — `/deep-evolve resume`

#### 3.3.1 진입 경로

두 가지:
1. `/deep-evolve` 호출 시 dispatcher가 `current.json`을 먼저 읽어, session_id가 있고 `session.yaml.status`가 `active` 또는 `paused`면 resume을 제안 (default 경로).
2. `/deep-evolve resume` 명시 호출 — 강제 resume, 활성 세션이 없으면 오류 메시지.

#### 3.3.2 프로토콜 (`skills/deep-evolve-workflow/protocols/resume.md` 신규)

**사전 조건 (X1)**: 본 프로토콜이 동작하려면 다음 스키마 변경이 PR#2에 함께 들어가야 한다.

1. `session.yaml.outer_loop.inner_count` 필드 추가 — 기존에 in-memory 변수였던 값을 persist.
   - `inner-loop.md` Step 6.a에서 `inner_count++` 후 session.yaml 업데이트.
   - 초기값 0 (init.md Step 9에서 생성).
2. journal.jsonl 기존 이벤트 스키마는 유지. 본 설계는 이 기존 이벤트만으로 orphan을 정의 (재정의):
   - **완결된 실험**: `planned` → `committed` → `evaluated` → (`kept` | `discarded` | `rollback_completed`) 이벤트 chain 완성
   - **orphan 실험**: `committed` 이벤트는 있으나 매칭 `evaluated`가 없음 (또는 `planned`만 있고 `committed` 없음)

**Step 개요**:

```
Step 1 — Load current session
  session-helper.sh resolve_current → session_id, session_root
  session.yaml.status가 terminal(completed/aborted)이면 "재개할 세션 없음" + abort

Step 2 — Load session state
  Read $SESSION_ROOT/session.yaml, strategy.yaml
  Read $SESSION_ROOT/results.tsv (last 20 rows)
  Read $SESSION_ROOT/journal.jsonl (last 50 events)

Step 3 — Integrity check (X1 반영: 실제 journal 이벤트 기준)
  3.a  Branch alignment (Q4-B):
       actual_branch=$(git branch --show-current)
       expected=$(yq .lineage.current_branch session.yaml)
       if actual != expected:
         AskUserQuestion:
           - "checkout and continue": git checkout <expected>
           - "proceed on current": journal에 branch_mismatch_accepted 이벤트 append,
                                   receipt.runtime_warnings에 기록 (X13)
           - "abort resume"
  3.b  Dirty tree:
       git status --porcelain → non-empty면 경고 + [stash 후 계속 / abort]
  3.c  HEAD vs last experiment:
       last_commit=$(tail -n1 results.tsv | cut -f1)
       head_commit=$(git rev-parse HEAD)
       if different:
         "HEAD가 마지막 실험 커밋과 다릅니다 — rebase/amend 여부 확인 필요" 경고
         [계속 / abort]
  3.d  Orphan experiment detection (실제 journal schema 기준):
       last_events = tail -n 20 journal.jsonl
       # 마지막 commit된 실험의 후속 이벤트 검사
       for each commit_event in reverse(last_events):
         matching_eval = last_events where event=evaluated and n=commit_event.n
         if no matching_eval:
           # orphan 확정
           AskUserQuestion:
             - "재평가": prepare/harness 재실행 후 이어서
             - "discard로 기록": journal에 discarded 이벤트 append, 다음 실험으로
             - "무시하고 다음 실험부터": 아무 것도 안 하고 진행
           break
  3.e  Counter consistency:
       sess_inner=$(yq .outer_loop.inner_count session.yaml)
       tsv_rows=$(wc -l results.tsv)
       if sess_inner != tsv_rows-1:  # 헤더 제외
         # results.tsv를 truth로 채택
         yq -i ".outer_loop.inner_count = $((tsv_rows-1))" session.yaml
         journal.jsonl에 "counter_reconciled" 이벤트 append

Step 4 — Display resume summary
  작업: <goal>
  세션: <session-id>
  진행: <inner_count>/<outer_interval> (generation <N>)
  최근 실험: <n> <status> (score=<x>)
  Q(v) 추이: <q_history>
  경고: <orphan 처리 내역, branch mismatch 등>
  다음: 실험 <n+1> 준비

Step 5 — 재진입 분기 (X1: session.yaml.status 단일 권위)
  status=active  → Read inner-loop.md from Step 1 (inner_count 유지)
  status=paused → Read outer-loop.md from Step 6.5 (outer loop 재진입)
```

---

### 3.4 Layer 4 — `/deep-evolve history`

#### 3.4.1 데이터 소스 우선순위 (X10 반영)

1. **`sessions.jsonl` (1차, 항상)** — 리플레이로 진행중 포함 전수 state 생성
2. `meta-archive-local.jsonl` (보강, 완료 세션 요약 통계용)
3. `$SESSION_ROOT/evolve-receipt.json` (상세 모드 `history <id>`에서만)

**X10 핵심**: 진행중 세션은 `sessions.jsonl`에 `created` 이벤트만 있고 `finished`가 없으므로 derived state에 "status=active" 상태로 노출. meta-archive-local보다 먼저 읽어 ongoing 세션 누락 방지.

#### 3.4.2 `meta-archive-local.jsonl` 스키마

```jsonl
{"session_id":"2026-04-15_phase-e","goal":"...","started_at":"...","finished_at":"...","status":"completed","outcome":"merged","parent_session_id":"2026-04-08_phase-d","experiments":{"total":52,"kept":4,"keep_rate":0.077},"score":{"baseline":0.51,"best":0.612,"improvement_pct":20.0},"q_trajectory":[-2.33,-0.87],"generations":2}
```

한 줄 ~500 bytes. completion 시점에만 append (status=completed/aborted). 진행중 세션은 sessions.jsonl에서 확인.

#### 3.4.3 표시 포맷

```
deep-evolve Session History (this project)

┌────┬────────────────────────┬────────────┬────────┬───────┬─────────┬──────────┬──────────┐
│ #  │ Session / Goal         │ Date       │ Exps   │ Keep  │ Q Δ     │ Score Δ% │ Outcome  │
├────┼────────────────────────┼────────────┼────────┼───────┼─────────┼──────────┼──────────┤
│ 1  │ phase-f (ongoing) ⚠    │ 2026-04-22 │ 18/?   │ 11%   │  —      │ +4.2%    │ active   │
│ 2  │ phase-e (convergence)  │ 2026-04-15 │ 52     │ 7.7%  │ +1.46   │ +20.0%   │ merged   │
│ 3  │ phase-d (...)          │ 2026-04-08 │ 38     │ 15.8% │ +0.89   │ +11.2%   │ pr       │
└────┴────────────────────────┴────────────┴────────┴───────┴─────────┴──────────┴──────────┘

⚠ phase-f: branch_mismatch warning 기록됨 (runtime_warnings 참조)

Lineage:
  phase-f ← phase-e ← phase-d ← (root)

Aggregate (완료 세션 기준):
  세션: 2 · 누적 실험: 90 · 평균 keep rate: 11.8%
  누적 Q 개선: +2.35 · 누적 score 개선: +33.5% (대비 baseline of phase-d)
```

#### 3.4.4 Subcommand

- `/deep-evolve history` — 목록 (ongoing 포함)
- `/deep-evolve history <session-id>` — receipt 상세 (schema version 체크 포함)
- `/deep-evolve history --lineage` — ASCII tree
- `/deep-evolve history --export=md|json` — 파일로 저장

상세 모드 기본 출력 범위: experiments_table은 top-10 + bottom-5, `--full`로 전수.

---

### 3.5 Layer 5 — Session lineage (X9 반영: informational only)

#### 3.5.1 `session.yaml` 스키마 추가

```yaml
# 신규 최상위 필드
parent_session:
  id: "2026-04-15_phase-e"
  parent_receipt_schema_version: 2
  seed_source:
    strategy_version: 3                         # 복제한 parent의 버전
    program_version: 2
    notable_keep_commit_refs:                    # 참조용. code-archive에 replay하지 않음
      - "def456abc"
      - "aaa111bbb"
  inherited_at: "2026-04-22T10:00:00Z"
```

**X9 변경**: 이전 설계에서 "이 커밋들은 새 세션의 code-archive/에 replay" 라고 했던 부분을 제거. 이유:

1. archive.md의 backtrack 로직은 `code-archive/`의 모든 엔트리를 실행 가능한 rollback target으로 취급
2. parent의 커밋을 child의 code-archive에 집어넣으면 child가 "parent의 오래된 커밋"으로 rollback 가능 → child baseline 이전 상태로 contamination
3. 게다가 parent 커밋이 child의 schema/브랜치에 cleanly apply된다는 보장 없음

**대신**: 상속된 keeps는 **informational hint**로만 사용. Inherited Context 섹션(§3.5.3)에 설명·score_delta·commit hash를 listing해 Claude가 **참고하여 재구현**하도록 유도. git-level replay 없음.

#### 3.5.2 Init flow 변경 (`init.md` Step 3.5 신규)

```
Step 3.5 — Lineage Decision
  completed_sessions=$(session-helper.sh list_sessions --status=completed)

  if count(completed_sessions) == 0:
    SKIP (root 세션으로 진행, parent_session=null)

  else:
    AskUserQuestion: "이 프로젝트에는 완료된 세션 N개가 있습니다. 어떻게 시작할까요?"
    options:
      - "fresh"                              # parent_session = null
      - "continue_from_last: <last-id>"      # parent_session.id = last
      - "continue_from_select"               # 목록 제시, 사용자가 고름
      - "transfer_cross_project"             # 기존 transfer.md 경로 (meta-archive 글로벌 조회)

  if continue_*:
    parent_id = <선택된 id>
    parent_root = .deep-evolve/$parent_id
    receipt = read $parent_root/evolve-receipt.json

    # X14: schema version 체크
    if receipt.receipt_schema_version > 2:
      warn "parent receipt schema가 최신 — 일부 필드 스킵"
    if receipt missing 또는 corrupt:
      AskUserQuestion: [strategy.yaml 직접 복제 / fresh로 fallback / abort]

    # seed copy
    cp $parent_root/strategy.yaml $SESSION_ROOT/strategy.yaml
    # program.md는 Step 6에서 Inherited Context 포함해 생성

    # parent_session 기록
    session.yaml.parent_session = {
      id: parent_id,
      parent_receipt_schema_version: receipt.receipt_schema_version,
      seed_source: {
        strategy_version: receipt.strategy_evolution.outer_loop_generations,
        program_version: receipt.program.versions,
        notable_keep_commit_refs: [k.commit for k in receipt.notable_keeps]
      },
      inherited_at: now()
    }
```

#### 3.5.3 "Inherited Context" 단락 템플릿 (X3 + X9 반영)

continue_* 선택 시에만 program.md에 삽입. §3.1.6 canonical 레이아웃 order 존중 (Automation Policy 아래).

```markdown
<!-- inherited-context-v1 -->
## Inherited Context (from <parent_session_id>)

이 세션은 선행 세션 `<parent_session_id>`의 결과를 이어받는다.

### 이어받은 전략 패턴 (strategy.yaml v<N>)
<receipt.generation_snapshots[-1].strategy_yaml_content에서 핵심 파라미터 3~5개 추출한 bullet>

### 선행 세션에서 참조할 만한 개선 (informational only, NOT replayed)
다음 커밋들은 부모 세션에서 score를 크게 올린 keep들이다. 본 세션 baseline에 자동 적용되지 않으며,
관련 아이디어를 참고하여 새 실험으로 재구현할지 Claude가 판단한다.

- commit def456abc (Δ+0.182, source=marked): switch volatility metric to GARCH(1,1)
- commit aaa111bbb (Δ+0.091, source=top_n): add rolling z-score normalization
...

### 선행 세션의 최종 교훈 (마지막 meta-analysis 발췌)
<receipt.generation_snapshots[-1].meta_analysis_content의 첫 단락>

---

(이하 본 세션의 실험 program)

<!-- /inherited-context-v1 -->
```

**효과**: 새 세션의 Claude가 program.md를 읽으면서 (a) parent의 strategy 파라미터 방향, (b) 참고할 개선 아이디어, (c) meta-analysis 결론을 프롬프트 내에서 자연스럽게 인지. git을 건드리지 않아 오염 위험 없음.

---

### 3.6 Downgrade 경로 (X16)

**v2.2.0 → v2.1.2 downgrade 방지**:

- v2.1.2 hook은 기존 경로 하드코딩 상태. v2.2.0 레이아웃에서는 `.deep-evolve/session.yaml`이 존재하지 않으므로 status 체크에서 "활성 세션 없음"으로 판단하고 **모든 쓰기를 허용** → 보호 상실
- 대응:
  - v2.2.0 CHANGELOG에 "one-way migration" 명시. downgrade 미지원.
  - v2.1.2 hook에 forward-compat shim 추가: `.deep-evolve/current.json`이 존재하면 stderr로 "v2.2.0+ 레이아웃 감지 — 플러그인 업그레이드 필요" 경고 후 exit 2 (block all). 사용자가 downgrade 상황에 빠졌음을 즉시 인지.

**플러그인 업데이트 중단 내성**:

- init.md Step 1.5 migration 중 Ctrl+C → copy-verify-pointer-delete 시퀀스 덕에 repo 상태 변화 없음 (§4 참조)
- 중단 후 `/deep-evolve` 재실행 → legacy 감지 재발동 → idempotent retry

---

### 3.7 Shell helper 이식성 가이드 (X15)

`hooks/scripts/session-helper.sh`는 다음 전제를 준수.

**Preamble**:
```bash
#!/usr/bin/env bash
set -Eeuo pipefail
trap 'cleanup $?' EXIT

# 의존성 체크
command -v jq >/dev/null 2>&1 || { echo "jq required (>= 1.6)" >&2; exit 127; }
command -v flock >/dev/null 2>&1 || FLOCK_AVAILABLE=0  # macOS default fallback
```

**Date portability**:
```bash
# BSD date (macOS default)와 GNU date 모두 지원
iso_now() {
  if date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null; then :
  else gdate -u +"%Y-%m-%dT%H:%M:%SZ"; fi
}
```

**Locking**:
- `sessions.jsonl`은 append-only라 flock 불필요 (O_APPEND 원자성)
- `current.json`은 `.tmp → mv`로 atomic 치환 (POSIX rename)
- 글로벌 `meta-archive.jsonl` 쓰기는 기존 transfer.md의 flock 패턴 유지 (macOS용 fallback: mkdir 기반 lock dir 사용 또는 Homebrew flock 안내)

**Slug normalization** (§3.1.2 재언급):
```bash
compute_slug() {
  local input="$1"
  echo "$input" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-*//; s/-*$//' \
    | cut -c1-40
}
```
빈 결과 fallback: `session-$(printf '%s' "$input$(iso_now)" | sha1 | cut -c1-6)`.

**Signal handling**: `trap cleanup EXIT` — stray `.tmp` 파일 제거.

**플랫폼 매트릭스**: macOS (zsh 5.x, bash 3.2), Linux (bash 5.x). Windows는 WSL Ubuntu로만 테스트.

**`--dry-run` 플래그**: 모든 state-mutating 서브커맨드(`start_new_session`, `mark_session_status`, `migrate_legacy`, `append_meta_archive_local`)는 `--dry-run` 지원 — 의도한 쓰기를 stderr로 출력만 하고 실제 파일 수정 안 함.

---

## 4. 마이그레이션 경로 (X7 반영: copy-verify-pointer-delete)

기존 `.deep-evolve/` 플랫 구조를 가진 프로젝트 대응:

1. init.md Step 1.5에서 legacy 감지: `.deep-evolve/session.yaml`이 root에 있고 `current.json` 없으면
2. AskUserQuestion:
   - "archive: legacy 세션을 namespace로 이관 후 새 레이아웃으로 계속"
   - "abort: 마이그레이션 중단"
3. archive 선택 → `session-helper.sh migrate_legacy` 실행

**migrate_legacy 알고리즘 (원자적, rollback-safe)**:

```bash
migrate_legacy() {
  local ts=$(iso_now | tr ':' '-')
  local goal=$(yq .goal .deep-evolve/session.yaml 2>/dev/null || echo unknown)
  local slug=$(compute_slug "$goal")
  local legacy_id="legacy-${ts}_${slug}"
  local legacy_dir=".deep-evolve/${legacy_id}"

  # 1) 빈 namespace dir 생성
  mkdir -p "$legacy_dir" || return 1

  # 2) COPY (mv 아님) — 원본 유지
  cp -R .deep-evolve/session.yaml "$legacy_dir/" 2>/dev/null
  cp -R .deep-evolve/strategy.yaml "$legacy_dir/" 2>/dev/null
  cp -R .deep-evolve/program.md "$legacy_dir/" 2>/dev/null
  cp -R .deep-evolve/prepare.py "$legacy_dir/" 2>/dev/null
  cp -R .deep-evolve/prepare-protocol.md "$legacy_dir/" 2>/dev/null
  cp -R .deep-evolve/results.tsv "$legacy_dir/" 2>/dev/null
  cp -R .deep-evolve/journal.jsonl "$legacy_dir/" 2>/dev/null
  cp -R .deep-evolve/runs "$legacy_dir/" 2>/dev/null
  cp -R .deep-evolve/code-archive "$legacy_dir/" 2>/dev/null
  cp -R .deep-evolve/strategy-archive "$legacy_dir/" 2>/dev/null
  cp -R .deep-evolve/meta-analysis.md "$legacy_dir/meta-analyses/gen-legacy.md" 2>/dev/null

  # 3) 무결성 검증 (파일 수, sha)
  verify_copy ".deep-evolve" "$legacy_dir" || {
    rm -rf "$legacy_dir"
    echo "migrate_legacy: copy verification failed, rolled back" >&2
    return 1
  }

  # 4) pointer/registry 기록 — 여기까지 성공하면 이관 완료로 간주
  # sessions.jsonl에 event=migrated append
  append_sessions_jsonl "migrated" "$legacy_id" "{\"from\":\"flat_layout\",\"status\":\"legacy\",\"legacy_recovery\":\"unavailable\"}"

  # current.json은 생성하지 않음 (legacy는 완료 간주 → 새 세션 init으로 진입)

  # 5) 원본 삭제
  rm -f .deep-evolve/session.yaml .deep-evolve/strategy.yaml \
        .deep-evolve/program.md .deep-evolve/prepare.py \
        .deep-evolve/prepare-protocol.md .deep-evolve/results.tsv \
        .deep-evolve/journal.jsonl .deep-evolve/meta-analysis.md
  rm -rf .deep-evolve/runs .deep-evolve/code-archive .deep-evolve/strategy-archive

  echo "migrate_legacy: archived to $legacy_dir"
}
```

**Idempotency**: 중단 후 재실행 시 — legacy_dir이 이미 존재하고 verification 통과하면 4~5단계만 수행. 실패하면 legacy_dir 삭제 후 처음부터.

**Rollback 보장**: 4단계(pointer write) 전에 실패하면 원본 그대로 유지. 4단계 성공 후 5단계 중 실패하면 "부분 삭제" 상태 — 그래도 legacy_dir에 완전한 copy가 있고 원본도 일부 남아 있음. 다음 실행 시 legacy_dir을 신뢰해 5단계만 재수행.

2.2.0 릴리스 시 CHANGELOG에 migration 안내 필수.

---

## 5. 구현 파일 매핑 (X8 반영: 누락 파일 추가)

모든 수정은 `.deep-evolve/...` 하드코딩 경로를 `$SESSION_ROOT/...` 참조로 치환하는 공통 변환 포함.

| 변경 내용 | 대상 파일 | 비고 |
|---|---|---|
| 디렉터리 레이아웃 + current.json + sessions.jsonl 생성 | `skills/deep-evolve-workflow/protocols/init.md` Step 1.5~9 | 신규: Step 1.5 (legacy migration 분기), Step 3.5 (lineage decision) |
| 세대별 meta-analysis append | `skills/deep-evolve-workflow/protocols/outer-loop.md` Step 6.5.1 | `$SESSION_ROOT/meta-analyses/gen-<N>.md`로 저장 (덮어쓰기 X) |
| inner_count persist (X1) | `skills/deep-evolve-workflow/protocols/inner-loop.md` Step 6.a | `session.yaml.outer_loop.inner_count++` 후 파일에 반영 |
| **경로 치환 (X8)** | `skills/deep-evolve-workflow/protocols/inner-loop.md` 전반 | `.deep-evolve/strategy.yaml` → `$SESSION_ROOT/strategy.yaml`, `.deep-evolve/program.md`, `.deep-evolve/results.tsv`, `.deep-evolve/journal.jsonl`, `.deep-evolve/runs/` 모두 |
| **경로 치환 (X8)** | `skills/deep-evolve-workflow/protocols/outer-loop.md` 전반 | 동일 변환 + `.deep-evolve/meta-analysis.md` → `$SESSION_ROOT/meta-analyses/gen-<N>.md` |
| **경로 치환 (X8)** | `skills/deep-evolve-workflow/protocols/archive.md` 전반 | `code-archive/`, `strategy-archive/`가 이제 `$SESSION_ROOT/` 하위 |
| **경로 치환 (X8)** | `skills/deep-evolve-workflow/protocols/transfer.md` | `session.yaml.transfer` 경로도 `$SESSION_ROOT/session.yaml`로. 글로벌 meta-archive는 기존 그대로 (cross-project) |
| receipt 확장 (X11~X14) + sessions.jsonl finished 이벤트 + meta-archive-local append | `skills/deep-evolve-workflow/protocols/completion.md` | experiments_table, generation_snapshots(cap 10), notable_keeps, runtime_warnings, parent_session, receipt_schema_version |
| hook 경로 동적화 (X4 + X8) | `hooks/scripts/protect-readonly.sh` | current.json → session_id → session.yaml.status 체인. legacy fallback 유지 |
| resume 프로토콜 (X1) | `skills/deep-evolve-workflow/protocols/resume.md` (신규) | Step 1~5, §3.3.2 참조 |
| resume 진입점 | `commands/deep-evolve.md` dispatch | `resume` subcommand + init 시 current.json 선확인 |
| history 프로토콜 (X10) | `skills/deep-evolve-workflow/protocols/history.md` (신규) | sessions.jsonl 우선 파싱 |
| history 진입점 | `commands/deep-evolve.md` dispatch | `history [session_id] [--lineage] [--export=...]` |
| lineage 선택 (X9) | `skills/deep-evolve-workflow/protocols/init.md` Step 3.5 추가 | AskUserQuestion 분기 + parent receipt schema 체크 (X14) |
| Inherited Context 단락 주입 (X3 + X9) | `skills/deep-evolve-workflow/protocols/init.md` Step 6 (program.md 생성) | continue 선택 시만. canonical 레이아웃 준수 |
| Automation Policy 단락 삽입 (X3, PR#1에서 이미 추가) | `skills/deep-evolve-workflow/protocols/init.md` Step 6 | 항상. sentinel 주석으로 감쌈 |
| Helper 스크립트 (X15) | `hooks/scripts/session-helper.sh` (신규) | subcommands: compute_session_id, resolve_current, list_sessions, start_new_session, mark_session_status, append_sessions_jsonl, migrate_legacy, check_branch_alignment, detect_orphan_experiment, append_meta_archive_local, render_inherited_context, lineage_tree. `--dry-run` 지원 |
| Downgrade warning (X16) | (v2.1.2 별도 후속 패치) | v2.1.2 hook이 current.json 감지 시 경고 + exit 2 |

---

## 6. 검증 계획

1. **Phase F 세션 pilot** — Quant 프로젝트에서 init 시 "continue from phase-e" 선택, Inherited Context 주입 확인, Phase F 완료 후 `meta-archive-local.jsonl` 2줄 확인.
2. **Namespace 격리** — Phase F init 시 Phase E 디렉터리 보존 여부. 모든 수정된 프로토콜이 `$SESSION_ROOT`을 올바르게 해석하는지 (X8 회귀 테스트).
3. **Lineage 상속 + informational only (X9)** — Phase F에 continue 선택 → `session.yaml.parent_session.id`, Inherited Context 단락 존재. **parent의 notable_keep_commits가 Phase F의 code-archive/에 있지 않음을 확인** (replay 없음을 검증).
4. **Resume 시나리오 (X1)** — Phase F 실험 10회 후 실제 중단 (Ctrl+C) → `/deep-evolve resume` → journal 이벤트 기반 orphan 감지, inner_count 정합 재개. branch mismatch 시나리오로 경고 + runtime_warnings 기록 확인 (X13).
5. **History 정확성 (X10)** — 진행중 세션이 `/deep-evolve history` 출력에 나타남 (meta-archive-local에 없어도).
6. **Receipt 재현성** — Phase E 완료 후 runs/ 삭제 → receipt만으로 experiments_table, generation_snapshots 복원. 20세대 가상 세션에서 cap 10 동작 확인 (X12).
7. **Legacy migration** — flat 레이아웃 샘플에서 copy-verify-pointer-delete 순서 검증. 중간 인터럽트 후 재실행 시 idempotent 동작 (X7).
8. **Hook 차단** — 새 레이아웃에서 `$SESSION_ROOT/program.md` Edit → block. helper 경유(`DEEP_EVOLVE_HELPER=1`) current.json 쓰기 → 허용.
9. **Downgrade 감지** — v2.2.0 레이아웃에 v2.1.2 hook 적용 → 경고 + block (X16).
10. **sessions.jsonl race** — 두 프로세스에서 동시 append → 모든 라인이 정확히 기록되는지 (X5).

---

## 7. 관련 선행 이슈

- `docs/improvements-from-quant-phase-e-session-2026-04-15.md` §3.A/3.B/3.C — outer loop 자동 트리거 개선. 본 설계는 Layer 5(lineage) init flow와 Step 3.5에서 통합되므로 두 PR을 순차 진행 권장 (3.A/B/C 먼저 → 본 설계 반영). §3.1.6 canonical 레이아웃은 PR#1의 3.C 템플릿에 이미 반영됨.

## 8. 버전 & 릴리스

- **v2.1.2**: 3.A/3.B/3.C 패치 (기존 이슈). + v2.1.2 hook에 v2.2.0 감지 경고 shim (X16).
- **v2.2.0**: 본 설계 전체 (layer 1~5 + migration + helper + shell portability). receipt schema version bump (2.1.0 → 2.2.0), `receipt_schema_version` field 도입.
- **v2.3.0 후보**: `/deep-evolve cleanup`, Tier 2 notable 마킹 의무화, `/deep-evolve status`, `/deep-evolve doctor`, history UI 시각화, deep-fork 분기, lineage cross-project 확장, receipts-as-CI-bundle.

## 9. 해결된 열린 질문 (rev2)

| # | 질문 | 해결 |
|---|---|---|
| 1 | session_id 충돌 정책 | hybrid suffix (§3.1.2) |
| 2 | meta-archive 이중 기록 | local + 기존 글로벌, 의미 분리 (§3.4) |
| 3 | notable_keeps 선정 기준 | top_n + marked 하이브리드, source 필드 (§3.2.4), Tier 2 마킹은 v2.3 의무화 |
| 4 | Resume 중 worktree 처리 | worktree 미사용, branch alignment 체크 (§3.3.2 Step 3.a) |
| 5 | program.md 섹션 순서 | §3.1.6 canonical 레이아웃 + sentinel 주석 |
| 6 | current.json race | §3.1.3 immutable pointer로 축소, status 권위 = session.yaml |
| 7 | sessions.json race | §3.1.4 append-only jsonl로 전환 |
| 8 | resume 상태 persistence | §3.3.2 + inner_count session.yaml 승격 (X1) |
| 9 | inherited keeps 안전성 | §3.5.1 informational only, replay 제거 (X9) |
| 10 | shell helper 이식성 | §3.7 preamble + platform matrix |
