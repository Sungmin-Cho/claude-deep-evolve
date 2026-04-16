# Implementation Spec: deep-evolve v2.1.2 + v2.2.0

**Date**: 2026-04-15
**Author**: Claude Opus 4.6 + Sungmin
**Status**: Pending user review
**Source docs** (reference only, 구현 완료 후 제거 예정):
- `docs/improvements-from-quant-phase-e-session-2026-04-15.md` (rev2)
- `docs/session-history-design-2026-04-15.md` (rev2, 3-way review applied)
- `.deep-review/reports/2026-04-15-spec-review.md` (3-way synthesis)

---

## 1. Scope

두 PR로 나뉜 순차 릴리스.

**PR#1 — v2.1.2 (docs-only, 코드 0줄)**:
- 3.A: `inner-loop.md` Step 6 재구조화 (outer loop 자동 우선)
- 3.B: `session.yaml.outer_loop.auto_trigger: true` 플래그
- 3.C: `init.md` program.md 템플릿에 Automation Policy 단락 + sentinel 주석
- v2.1.2 hook forward-compat shim (X16)

**PR#2 — v2.2.0 (Layer 1~5 + migration + helper)**:
- Layer 1: 세션 namespace (`$SESSION_ROOT` + `current.json` + `sessions.jsonl`)
- Layer 2: receipt v2.2.0 스키마 확장
- Layer 3: `/deep-evolve resume`
- Layer 4: `/deep-evolve history`
- Layer 5: Session lineage (informational only)
- Legacy migration (copy-verify-pointer-delete)
- Shell helper (`hooks/scripts/session-helper.sh`)
- Hook 동적화 (`protect-readonly.sh`)
- 전 프로토콜 `$SESSION_ROOT` 경로 치환

---

## 2. Resolved Design Decisions

| # | 결정 | 값 |
|---|---|---|
| Q0 | `lineage` 충돌 | `parent_session` 최상위 분리 |
| Q1 | session_id 충돌 | hybrid `-2`/`-3` suffix |
| Q2 | meta-archive 이중 기록 | 분리 (local=all, global=transfer) |
| Q3 | notable_keeps | top_n + marked hybrid, `source` 필드 |
| Q4 | resume branch | warn-only + `runtime_warnings[]` |
| Q5 | PR split | 순차 2 PR |
| X1 | resume state | journal 실제 이벤트 + inner_count persist |
| X2 | auto_trigger 위치 | `session.yaml.outer_loop.auto_trigger` |
| X3 | program.md 순서 | Automation Policy → Inherited Context → body |
| X4 | current.json | immutable pointer (no status, no last_activity) |
| X5 | sessions registry | `sessions.jsonl` append-only event log |
| X6 | dispatcher orphan | `resolve_current` dir 존재 검증 |
| X7 | migrate rollback | copy-verify-pointer-delete |
| X8 | namespace coverage | inner-loop, archive, transfer 포함 전수 |
| X9 | inherited keeps | informational only (no git replay) |
| X10 | history source | sessions.jsonl 먼저 (active 포함) |
| X11 | score_delta | 동일 gen 내 직전 keep 대비, n 오름차순 tie-break |
| X12 | snapshot cap | N=10, 초과 시 summary-only |
| X13 | branch warn trace | `runtime_warnings[]` in receipt |
| X14 | receipt version | `receipt_schema_version: 2` + parser guard |
| X15 | shell portability | jq>=1.6, BSD date compat, flock fallback, --dry-run |
| X16 | downgrade | v2.1.2 shim warns + blocks on v2.2.0 layout |

---

## 3. PR#1 — v2.1.2 Changes

### 3.1 Files to modify

#### `skills/deep-evolve-workflow/protocols/inner-loop.md`

**Before** (Step 6):
```
Step 6: Increment inner_count. Check diminishing returns. If detected → AskUserQuestion.
Step 6.5: Outer Loop Evaluation (triggers: inner_count >= interval OR diminishing returns)
```

**After** (Step 6 restructured):
```
Step 6 — Continuation Check
  6.a  Increment inner_count. Persist to session.yaml.outer_loop.inner_count.
  6.b  Compute diminishing-returns signals (consecutive_discard, plateau_window, crash_tolerance).
  6.c  If any signal triggered → IMMEDIATELY run Step 6.5 (Outer Loop Evaluation)
       — do NOT AskUserQuestion before Outer Loop completes.
       (Respects session.yaml.outer_loop.auto_trigger: if false, AskUserQuestion first.)
  6.d  After Outer Loop returns:
       - Q(v) improved and no convergence flag → auto-continue to Step 1
       - Q(v) degraded or session-level stop criteria met → AskUserQuestion:
         "계속 (N회 추가)" / "평가 harness 확장" / "여기서 완료"

Step 6.5 — Outer Loop Evaluation
  If session.yaml.outer_loop.auto_trigger is false, AskUserQuestion before entering.
  Otherwise execute immediately without user confirmation.
  (rest of existing Step 6.5 unchanged)
```

**Also**: 6.a에 `inner_count` persist 추가 (PR#2 Layer 3 resume의 사전 조건이지만, PR#1에 미리 반영해 PR#2 diff 최소화).

#### `skills/deep-evolve-workflow/protocols/outer-loop.md`

Step 6.5 trigger 설명 첫 줄에 `session.yaml.outer_loop.auto_trigger` 분기 추가.

```
**Step 6.5 — Outer Loop Evaluation** (triggers: inner_count >= outer_interval
OR diminishing returns detected in Step 6).
If session.yaml.outer_loop.auto_trigger is false, AskUserQuestion before entering.
Otherwise execute immediately without user confirmation.
```

#### `skills/deep-evolve-workflow/protocols/init.md`

**Step 6** (program.md 생성): sentinel 주석 + Automation Policy 삽입 지시 추가.

```
program.md 상단에 다음 섹션을 항상 삽입:

<!-- automation-policy-v1 -->
## Automation Policy

- Outer Loop는 diminishing-returns 감지 시 session.yaml.outer_loop.auto_trigger가
  true면 자동 실행. AskUserQuestion은 outer 완료 후 Q(v) 악화 또는 세션 종료 기준
  충족 시에만.
- 사용자 초기 브리프에 "ask before outer loop" 류 지시가 있으면 auto_trigger=false로
  명시 설정하고 program.md에 override 기록.

<!-- /automation-policy-v1 -->
```

**Step 9** (session.yaml 기본값): `outer_loop` 블록에 `auto_trigger: true` 추가.

```yaml
outer_loop:
  generation: 0
  interval: 20
  inner_count: 0        # X1 선반영
  auto_trigger: true    # 3.B
  q_history: []
```

#### `hooks/scripts/protect-readonly.sh`

v2.1.2 forward-compat shim (X16): 스크립트 시작 부근에 추가.

```bash
# v2.2.0+ layout forward-compat (X16)
if [[ -f "$PROJECT_ROOT/.deep-evolve/current.json" ]]; then
  echo "deep-evolve: v2.2.0+ 레이아웃이 감지되었습니다. 플러그인을 v2.2.0으로 업그레이드하세요." >&2
  cat <<JSON
{"decision":"block","reason":"Deep Evolve Guard: v2.2.0+ 레이아웃 감지. 플러그인 업그레이드 필요."}
JSON
  exit 2
fi
```

#### `CHANGELOG.md` (없으면 생성)

```markdown
## v2.1.2

### Improvements
- **3.A** inner-loop Step 6 재구조화: outer loop 자동 트리거 우선, AskUserQuestion은 outer 완료 후 조건부
- **3.B** `session.yaml.outer_loop.auto_trigger` 플래그 (default true)
- **3.C** program.md 템플릿에 Automation Policy 단락 자동 삽입

### Fixes
- v2.2.0 forward-compat shim: v2.2.0 layout 감지 시 업그레이드 안내
```

---

## 4. PR#2 — v2.2.0 Changes

### 4.1 New files

#### `hooks/scripts/session-helper.sh`

Shell helper with subcommands. Full preamble:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
trap 'cleanup $?' EXIT

HELPER_VERSION="2.2.0"
export DEEP_EVOLVE_HELPER=1

command -v jq >/dev/null 2>&1 || { echo "session-helper: jq >= 1.6 required" >&2; exit 127; }
```

**Subcommands**:

| Subcommand | Args | Effect | --dry-run |
|---|---|---|---|
| `compute_session_id` | `<goal>` | stdout에 id 출력. slug normalization + sessions.jsonl 충돌 체크 | N/A (read-only) |
| `resolve_current` | — | current.json → session_id + session_root 출력. dir 존재 검증 (X6). 부재/orphan 시 exit 1 | N/A |
| `list_sessions` | `[--status=X]` | sessions.jsonl 리플레이 → JSON array stdout | N/A |
| `start_new_session` | `<goal> [--parent=<id>]` | atomic: compute_id → mkdir → append sessions.jsonl → write current.json | Yes |
| `mark_session_status` | `<id> <status>` | append sessions.jsonl status_change + update session.yaml.status | Yes |
| `append_sessions_jsonl` | `<event> <id> <json_fields>` | 한 줄 append (O_APPEND atomic) | Yes |
| `migrate_legacy` | — | copy-verify-pointer-delete (§4 in design doc) | Yes |
| `check_branch_alignment` | `<session-dir>` | 0=ok, 1=mismatch (stderr 설명) | N/A |
| `detect_orphan_experiment` | `<session-dir>` | orphan 있으면 커밋 해시 출력, 없으면 빈 출력 | N/A |
| `append_meta_archive_local` | `<id>` | receipt에서 요약 추출 → append | Yes |
| `render_inherited_context` | `<parent-id>` | stdout에 Inherited Context markdown 출력 | N/A |
| `lineage_tree` | — | sessions.jsonl + parent_session 체인으로 ASCII tree | N/A |

**공통 유틸 함수**: `iso_now()`, `compute_slug()`, `cleanup()`.

**`DEEP_EVOLVE_HELPER=1`**: hook이 이 env var을 인식하면 current.json / sessions.jsonl 쓰기를 허용.

#### `skills/deep-evolve-workflow/protocols/resume.md`

Design doc §3.3.2 그대로. Step 1~5 (load → state → integrity check → summary → dispatch).

#### `skills/deep-evolve-workflow/protocols/history.md`

Design doc §3.4 그대로. MODE=list|detail|lineage|export.

### 4.2 Modified files

#### `skills/deep-evolve-workflow/protocols/init.md`

**Step 1.5** (신규): Legacy migration. `session-helper.sh migrate_legacy` 호출 조건부.

**Step 2~4**: 기존 `.deep-evolve/` 생성 → `.deep-evolve/<session-id>/` 생성으로 변경. `session-helper.sh start_new_session` 호출.

**Step 3.5** (신규): Lineage Decision. `session-helper.sh list_sessions --status=completed` → AskUserQuestion 분기.

**Step 6** (program.md 생성): continue 선택 시 Inherited Context 단락 삽입 (`session-helper.sh render_inherited_context`). Canonical 레이아웃 준수.

**Step 9** (session.yaml 생성): `session_id`, `parent_session` 필드 추가. `outer_loop.inner_count: 0`, `outer_loop.auto_trigger: true` 포함.

#### `skills/deep-evolve-workflow/protocols/inner-loop.md`

**경로 치환 (X8)**: 모든 `.deep-evolve/...` → `$SESSION_ROOT/...`
- `.deep-evolve/strategy.yaml` → `$SESSION_ROOT/strategy.yaml`
- `.deep-evolve/program.md` → `$SESSION_ROOT/program.md`
- `.deep-evolve/results.tsv` → `$SESSION_ROOT/results.tsv`
- `.deep-evolve/journal.jsonl` → `$SESSION_ROOT/journal.jsonl`
- `.deep-evolve/runs/run-NNN.log` → `$SESSION_ROOT/runs/run-NNN.log`
- `.deep-evolve/prepare.py` → `$SESSION_ROOT/prepare.py`
- `.deep-evolve/prepare-protocol.md` → `$SESSION_ROOT/prepare-protocol.md`
- `.deep-evolve/code-archive/` → `$SESSION_ROOT/code-archive/`

**Step 1 앞에 $SESSION_ROOT resolution 추가**:
```
Read session.yaml for configuration. $SESSION_ROOT is resolved by the caller
(dispatcher or resume.md) via session-helper.sh resolve_current.
All file paths in this protocol are relative to $SESSION_ROOT.
```

#### `skills/deep-evolve-workflow/protocols/outer-loop.md`

**경로 치환**: 동일 패턴.
- `.deep-evolve/meta-analysis.md` → `$SESSION_ROOT/meta-analyses/gen-<N>.md` (덮어쓰기 대신 세대별 append)
- `.deep-evolve/strategy.yaml` → `$SESSION_ROOT/strategy.yaml`
- `.deep-evolve/program.md` → `$SESSION_ROOT/program.md`

**Tier 2에 optional notable marking 단계 추가**:
```
(Optional, v2.3에서 의무화 예정) 이 keep이 다른 세션에 전이할 가치가 있다면
journal.jsonl에 {"event":"outer_loop", "notable":true, "n":<N>} 형태로 기록.
```

#### `skills/deep-evolve-workflow/protocols/archive.md`

**경로 치환**: `code-archive/`, `strategy-archive/` → `$SESSION_ROOT/...`

**Backtrack 로직 (X9)**: 변경 없음 — inherited keeps는 child의 code-archive에 존재하지 않으므로 backtrack 대상에 자동 배제.

#### `skills/deep-evolve-workflow/protocols/completion.md`

**Receipt 생성**: v2.2.0 스키마로 확장 (§3.2 전체).
- `receipt_schema_version: 2`
- `experiments_table`: results.tsv full dump + generation 번호 매핑
- `generation_snapshots`: `$SESSION_ROOT/meta-analyses/gen-<N>.md` 로드. Cap 10 (X12).
- `notable_keeps`: §3.2.4 로직 (journal scan → marked 우선 → top_n 보강)
- `runtime_warnings`: journal.jsonl에서 `branch_mismatch_accepted` 등 수집
- `parent_session`: session.yaml.parent_session 복사

**sessions.jsonl `finished` event**: `session-helper.sh append_sessions_jsonl finished <id> <fields>`

**meta-archive-local.jsonl**: `session-helper.sh append_meta_archive_local <id>`

**글로벌 meta-archive**: 기존 transfer.md E.0 로직 유지 (변경 없음).

#### `skills/deep-evolve-workflow/protocols/transfer.md`

**경로 치환**: `session.yaml.transfer.*` 접근 시 `$SESSION_ROOT/session.yaml` 경로 사용. 글로벌 meta-archive (`~/.claude/deep-evolve/meta-archive.jsonl`)는 기존 그대로.

#### `commands/deep-evolve.md`

**Step 0**: `resume` / `history` subcommand 파싱 추가.

**Step 1**: 완전 재작성.

```
Step 1 — Route
  if HISTORY: → Read protocols/history.md, dispatch with HISTORY_ARGS

  if RESUME: → Read protocols/resume.md (강제 resume)

  else:
    session-helper.sh resolve_current
    
    if exit 1 (no active session):
      → Read protocols/init.md → Init Flow

    if session.yaml.status == "active":
      AskUserQuestion: [resume / finish (completion) / abort and start new]

    if session.yaml.status == "paused":
      AskUserQuestion: [resume / abort and start new]

    if session.yaml.status in {completed, aborted}:
      AskUserQuestion: [start new session / view history / view last report]

  "abort and start new":
    session-helper.sh mark_session_status <current_id> aborted
    → protocols/init.md → Init Flow (새 namespace, 기존 보존)

  "view history": → protocols/history.md
  "view last report": → Read $SESSION_ROOT/report.md
```

**"Delete .deep-evolve/" 분기 완전 제거**.

#### `hooks/scripts/protect-readonly.sh`

Design doc §3.1.5 그대로 재작성:
- `current.json` → `session_id` → `$SESSION_ROOT/session.yaml.status` 체인
- Legacy fallback (flat layout) 유지
- `DEEP_EVOLVE_HELPER=1` 인식 시 current.json / sessions.jsonl 쓰기 허용
- v2.1.2 shim 제거 (v2.2.0 hook이 동적 해석하므로 불필요)

#### `skills/deep-evolve-workflow/SKILL.md`

프로토콜 라우팅 테이블에 `resume.md`, `history.md` 추가. 워크플로우 설명에 세션 히스토리 언급.

#### `CHANGELOG.md`

```markdown
## v2.2.0

### Features
- **Session namespace**: `.deep-evolve/<session-id>/` per-session 격리, 세션 간 데이터 보존
- **`/deep-evolve resume`**: 중단된 세션 재개, integrity check, orphan experiment 감지
- **`/deep-evolve history`**: 프로젝트 내 세션 목록, lineage tree, aggregate 통계
- **Session lineage**: 선행 세션의 strategy/program/notable keeps를 새 세션에 상속 (informational only)
- **Inherited Context**: program.md에 선행 세션 결론 자동 삽입
- **Immutable receipt v2.2.0**: experiments_table, generation_snapshots(cap 10), notable_keeps, runtime_warnings, parent_session
- **Shell helper**: `hooks/scripts/session-helper.sh` with 12 subcommands, --dry-run support

### Breaking Changes
- `.deep-evolve/` 디렉터리 구조 변경: flat → per-session namespace
- 기존 flat layout 프로젝트는 첫 실행 시 자동 migration 프롬프트
- `Delete .deep-evolve/` 동작 제거 — 세션은 보존됨 (cleanup은 v2.3+)
- `sessions.json` → `sessions.jsonl` (event-sourced)
- receipt schema: `receipt_schema_version: 2` 필드 추가

### Migration
- **자동**: `/deep-evolve` 실행 시 legacy layout 감지 → archive 이관 프롬프트
- **수동 rollback 불가**: v2.2.0 layout은 v2.1.x hook과 호환 불가 (v2.1.2 shim이 경고)
```

---

## 5. Data Schemas

### 5.1 `current.json` (immutable pointer)

```json
{
  "session_id": "2026-04-15_phase-e",
  "started_at": "2026-04-15T09:14:00Z"
}
```

없거나 `session_id: null` == "활성 세션 없음".

### 5.2 `sessions.jsonl` (append-only event log)

```jsonl
{"event":"created","ts":"...","session_id":"...","goal":"...","parent_session_id":"..."}
{"event":"status_change","ts":"...","session_id":"...","status":"paused"}
{"event":"status_change","ts":"...","session_id":"...","status":"active"}
{"event":"finished","ts":"...","session_id":"...","status":"completed","outcome":"merged","experiments_total":52,"experiments_kept":4,"best_score":0.612,"q_final":-0.87}
{"event":"migrated","ts":"...","session_id":"legacy-...","from":"flat_layout","status":"legacy","legacy_recovery":"unavailable"}
```

### 5.3 `session.yaml` additions

```yaml
session_id: "2026-04-15_phase-e"
outer_loop:
  inner_count: 0          # X1: persisted each Step 6.a
  auto_trigger: true      # X2/3.B
parent_session:            # Q0-A: null for root sessions
  id: "2026-04-08_phase-d"
  parent_receipt_schema_version: 2
  seed_source:
    strategy_version: 3
    program_version: 2
    notable_keep_commit_refs: ["def456", "aaa111"]
  inherited_at: "2026-04-22T10:00:00Z"
```

### 5.4 `evolve-receipt.json` v2.2.0

Design doc §3.2.1 그대로. Key additions:
- `receipt_schema_version: 2`
- `experiments_table[]`
- `generation_snapshots[]` (cap 10, summary-only overflow)
- `notable_keeps[]` (source: "top_n" | "marked")
- `runtime_warnings[]`
- `parent_session{}`

### 5.5 `meta-archive-local.jsonl`

Design doc §3.4.2 그대로. Completion 시 append-only.

---

## 6. Testing Plan

| # | 검증 | 대상 PR | 방법 |
|---|---|---|---|
| T1 | 3.A/B/C outer loop 자동 트리거 | PR#1 | Quant Phase F pilot gen 1: AskUserQuestion 0회 |
| T2 | v2.1.2 forward-compat shim | PR#1 | v2.2.0 layout mock → hook이 block + 경고 |
| T3 | Namespace 격리 | PR#2 | Phase F init 시 Phase E dir 보존 |
| T4 | $SESSION_ROOT 전수 치환 | PR#2 | 전 프로토콜 grep `.deep-evolve/` — 0 match |
| T5 | Lineage 상속 | PR#2 | continue from → parent_session 기록 + Inherited Context 존재 |
| T6 | Inherited keeps NOT in code-archive | PR#2 | Phase F code-archive/ 에 parent commit 부재 |
| T7 | Resume integrity check | PR#2 | 실험 10회 후 Ctrl+C → resume → inner_count 정합 |
| T8 | Resume orphan detection | PR#2 | committed 이벤트 후 evaluated 없이 중단 → AskUserQuestion |
| T9 | Branch mismatch → runtime_warnings | PR#2 | 다른 branch에서 resume → warn → receipt.runtime_warnings |
| T10 | History active session visible | PR#2 | ongoing 세션이 history 출력에 표시 |
| T11 | Generation snapshots cap 10 | PR#2 | 12-generation 가상 세션 → receipt에 10+2 summary-only |
| T12 | Legacy migration idempotent | PR#2 | flat layout → migrate → 중간 인터럽트 → 재실행 → 정상 |
| T13 | sessions.jsonl append race | PR#2 | 두 프로세스 동시 append → 모든 라인 정확 |
| T14 | Hook protect-readonly dynamic | PR#2 | $SESSION_ROOT/program.md Edit → block. DEEP_EVOLVE_HELPER=1 → allow |
| T15 | Receipt parser guard | PR#2 | schema_version=99 receipt → warning + best-effort |
| T16 | --dry-run for helper | PR#2 | start_new_session --dry-run → stderr 출력만, 파일 변경 0 |

---

## 7. Rollout Sequence

1. **PR#1 작성 → merge** (main branch)
2. **Quant Phase F pilot**: PR#1 효과 검증 (T1, T2)
3. Phase F pilot 완료 후 회고
4. **PR#2 작성 → merge** (main branch)
5. **검증 T3~T16** 수행
6. **v2.2.0 태그** 릴리스
7. Quant Phase G에서 "continue from Phase F" → lineage 전체 흐름 end-to-end 검증

---

## 8. Out of Scope (v2.3+)

- `/deep-evolve cleanup` (오래된 namespace dir 정리)
- `/deep-evolve doctor` (standalone integrity check)
- `/deep-evolve status` (mid-session 비침습적 상태 조회)
- `/deep-evolve fork` (세션 분기, deep-fork analog)
- Tier 2 notable 마킹 의무화
- Receipts-as-CI-bundle
- meta-archive-local.jsonl rotation / size cap
- Lineage DAG (fork-merge) 지원
- Cross-project lineage 확장
