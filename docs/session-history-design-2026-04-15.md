# deep-evolve Session History & Lineage 설계 (2026-04-15)

**작성 시점**: 2026-04-15
**배경**: `docs/improvements-from-quant-phase-e-session-2026-04-15.md`의 후속. Quant 프로젝트에서 Phase E → Phase F로 넘어갈 때 "이전 세션의 전략 진화 과정과 meta-analysis를 이어받아 참조하고 싶다"는 요구가 실제로 발생했으나, 현재 deep-evolve는 `.deep-evolve/` 디렉터리 하나가 세션 단위로 덮어써지는 구조라 지원 불가. deep-work 플러그인의 session registry + receipt + resume/history 패턴을 참고하되, deep-evolve의 실행 특성에 맞춰 재설계.
**범위**: 이 문서는 설계만 담는다. 구현은 별도 PR에서 진행.

---

## 0. 요약

deep-evolve에 **5계층 히스토리 시스템**을 도입한다.

1. **세션 namespace** — `.deep-evolve/<session-id>/`로 per-session 디렉터리, `current.json` 포인터와 `sessions.json` registry 도입.
2. **Immutable session receipt 확장** — `evolve-receipt.json`에 experiments_table, generation_snapshots, notable_keeps를 embed해 디렉터리 휘발 후에도 완전 재현.
3. **`/deep-evolve resume`** — 중단된 세션 재진입. results.tsv 정합성 검증 후 inner-loop에 재합류.
4. **`/deep-evolve history`** — 이 프로젝트의 세션 목록/aggregate/trend 뷰. `meta-archive-local.jsonl`에서 집계.
5. **Session lineage** — 새 세션이 선행 세션의 최종 strategy/program/notable keeps를 seed로 이어받는 within-project transfer.

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
├── current.json                      # 활성 세션 포인터
├── sessions.json                     # 이 프로젝트의 세션 registry
├── meta-archive-local.jsonl          # 완료 세션 요약 누적 (append-only)
│
├── 2026-04-15_phase-e/               # per-session dir
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
│   ├── code-archive/
│   ├── strategy-archive/
│   ├── report.md                     # 완료 시
│   └── evolve-receipt.json           # 완료 시 freeze
│
└── 2026-04-22_phase-f/
    └── ...
```

#### 3.1.2 session_id 규칙

- 형식: `YYYY-MM-DD_<goal-slug>`
- `<goal-slug>`: 사용자가 init 시 입력한 goal의 kebab-case 슬러그. 비어 있으면 `session-<counter>` fallback.
- 같은 날 여러 세션이면 `YYYY-MM-DD_<slug>-2`, `-3` 증가.
- Human-readable + sortable 필수 (history 뷰에서 그대로 표시).

#### 3.1.3 `.deep-evolve/current.json`

```json
{
  "session_id": "2026-04-15_phase-e",
  "status": "active",
  "started_at": "2026-04-15T09:14:00Z",
  "last_activity": "2026-04-15T22:03:17Z"
}
```

- `status`: `active` / `paused` / `completed` / `aborted`
- init은 이 파일이 없거나 status가 terminal(`completed`/`aborted`)일 때만 새 세션 생성
- Layer 3 resume의 진입점

#### 3.1.4 `.deep-evolve/sessions.json`

```json
{
  "version": 1,
  "sessions": [
    {
      "session_id": "2026-04-15_phase-e",
      "goal": "quant strategy phase E — convergence fix",
      "started_at": "2026-04-15T09:14:00Z",
      "finished_at": "2026-04-16T08:11:00Z",
      "status": "completed",
      "outcome": "merged",
      "parent_session_id": "2026-04-08_phase-d",
      "experiments_total": 52,
      "experiments_kept": 4,
      "best_score": 0.612,
      "q_final": -0.87
    }
  ]
}
```

- completion.md에서 update
- history 커맨드의 1차 데이터 소스

#### 3.1.5 `hooks/scripts/protect-readonly.sh` 경로 영향

현재 hook은 `.deep-evolve/*` 고정 경로에 대해 보호를 건다. 새 구조에서는:

```bash
# BEFORE
readonly_glob=".deep-evolve/session.yaml .deep-evolve/program.md .deep-evolve/strategy.yaml"

# AFTER
session_id=$(jq -r .session_id .deep-evolve/current.json 2>/dev/null)
[ -n "$session_id" ] && readonly_glob=".deep-evolve/${session_id}/session.yaml .deep-evolve/${session_id}/program.md .deep-evolve/${session_id}/strategy.yaml"
```

`sessions.json`과 `current.json` 자체도 보호 대상 추가 (오직 completion/init 플로우만 write 가능).

---

### 3.2 Layer 2 — Immutable session receipt 확장

`completion.md`의 `evolve-receipt.json` 스키마를 다음처럼 확장한다 (기존 필드 유지 + 신규 필드 4개).

```json
{
  "version": "2.2.0",
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
    {
      "n": 33,
      "commit": "abc123def",
      "score": 0.4201,
      "status": "discard",
      "description": "reduce lookback window to 12",
      "generation": 1
    }
  ],

  "generation_snapshots": [
    {
      "generation": 1,
      "started_at_experiment": 33,
      "ended_at_experiment": 42,
      "q_value": -2.33,
      "strategy_yaml_content": "<full yaml at end of generation>",
      "program_md_content": "<full md at end of generation>",
      "meta_analysis_content": "<full meta-analysis.md for this generation>",
      "triggered_by": "consecutive_discard_limit"
    }
  ],

  "notable_keeps": [
    {
      "n": 45,
      "commit": "def456abc",
      "score_delta": 0.182,
      "description": "switch volatility metric to GARCH(1,1)",
      "generation": 2
    }
  ],

  "lineage": {
    "parent_session_id": "2026-04-08_phase-d",
    "inherited_strategy_version": 3,
    "inherited_program_version": 2,
    "inherited_notable_keeps": ["2026-04-08_phase-d/commit/xyz789"]
  }
}
```

**설계 의도**:
- `runs/run-NNN.log`는 용량상 embed 불가 → commit hash로만 참조. git이 남아 있는 한 재현 가능.
- `generation_snapshots[].meta_analysis_content`가 핵심. 현재 덮어쓰기되는 meta-analysis.md를 세대별로 동결.
- `notable_keeps`는 `code-archive/`가 gc되어도 top-N 교훈을 receipt만 보고 파악 가능.
- `lineage`는 Layer 5 세션 연쇄 추적용.

**평균 크기 추정**: 실험 100회 + 5세대 기준 ~150KB JSON. 허용 범위.

---

### 3.3 Layer 3 — `/deep-evolve resume`

#### 3.3.1 진입 경로

두 가지:
1. `/deep-evolve` 호출 시 init protocol이 `.deep-evolve/current.json`을 먼저 읽어, status가 `active` 또는 `paused`면 resume을 제안 (default 경로).
2. `/deep-evolve resume` 명시 호출 — 강제 resume, 활성 세션이 없으면 오류 메시지.

#### 3.3.2 프로토콜 (`skills/deep-evolve-workflow/protocols/resume.md` 신규)

```
Step 1 — Load current.json, resolve session_id
Step 2 — Read .deep-evolve/<session-id>/session.yaml, strategy.yaml, results.tsv tail, journal.jsonl tail
Step 3 — Integrity check:
         - session.yaml.outer_loop.inner_count vs results.tsv row count vs journal.jsonl event count 일치?
         - 마지막 journal 이벤트가 "experiment_started"인데 matching "experiment_finished"가 없으면
           → 부분 완료 실험(orphan). 해당 커밋의 git 상태 검사 후:
             · 커밋 존재 + score 미기록 → 사용자에게 "재평가 / discard로 기록 / 수동 수정" 선택
             · 커밋 부재 → 무시하고 다음 실험으로 진행
Step 4 — Display resume summary:
         작업: <goal>
         진행: <inner_count>/<outer_interval> (generation <N>)
         최근 실험: <n> <status> (score=<x>)
         Q(v) 추이: -2.33 → -0.87 (gen 1→2)
         다음: 실험 <n+1> 준비
Step 5 — Read inner-loop.md, execute from Step 1 with resumed inner_count
```

#### 3.3.3 `paused` 상태

outer-loop Tier 1/2 수행 중 hook bypass 용도로 `status=paused`를 임시 사용하는 기존 트릭은 유지. resume 시 `paused`면 "outer loop 진행 중이었음" 경고 + outer-loop.md Step 6.5부터 재진입하도록 별도 분기.

---

### 3.4 Layer 4 — `/deep-evolve history`

#### 3.4.1 데이터 소스

우선순위:
1. `.deep-evolve/meta-archive-local.jsonl` — completion 시 1줄씩 append
2. fallback: `.deep-evolve/sessions.json` — 진행중 세션도 포함한 전수
3. 개별 receipt 필요 시 `.deep-evolve/<session-id>/evolve-receipt.json`

#### 3.4.2 `meta-archive-local.jsonl` 스키마

```jsonl
{"session_id":"2026-04-15_phase-e","goal":"...","started_at":"...","finished_at":"...","status":"completed","outcome":"merged","parent_session_id":"2026-04-08_phase-d","experiments":{"total":52,"kept":4,"keep_rate":0.077},"score":{"baseline":0.51,"best":0.612,"improvement_pct":20.0},"q_trajectory":[-2.33,-0.87],"generations":2}
```

한 줄 ~500 bytes. 프로젝트당 수백 세션까지 무리 없음.

#### 3.4.3 표시 포맷

```
deep-evolve Session History (this project)

┌────┬────────────────────────┬────────────┬────────┬───────┬─────────┬──────────┬──────────┐
│ #  │ Session / Goal         │ Date       │ Exps   │ Keep  │ Q Δ     │ Score Δ% │ Outcome  │
├────┼────────────────────────┼────────────┼────────┼───────┼─────────┼──────────┼──────────┤
│ 1  │ phase-f (ongoing)      │ 2026-04-22 │ 18/?   │ 11%   │  —      │ +4.2%    │ active   │
│ 2  │ phase-e (convergence)  │ 2026-04-15 │ 52     │ 7.7%  │ +1.46   │ +20.0%   │ merged   │
│ 3  │ phase-d (...)          │ 2026-04-08 │ 38     │ 15.8% │ +0.89   │ +11.2%   │ pr       │
└────┴────────────────────────┴────────────┴────────┴───────┴─────────┴──────────┴──────────┘

Lineage:
  phase-f ← phase-e ← phase-d ← (root)

Aggregate (완료 세션 기준):
  세션: 2 · 누적 실험: 90 · 평균 keep rate: 11.8%
  누적 Q 개선: +2.35 · 누적 score 개선: +33.5% (대비 baseline of phase-d)

Trend (최근 2 vs 이전 N/A):
  (비교 대상 부족)
```

#### 3.4.4 Subcommand 변형

- `/deep-evolve history` — 목록
- `/deep-evolve history <session-id>` — 해당 receipt 상세
- `/deep-evolve history --lineage` — ASCII 트리로 parent 관계 시각화
- `/deep-evolve history --export=md` — PR description용 요약

---

### 3.5 Layer 5 — Session lineage

#### 3.5.1 `session.yaml` 스키마 추가

```yaml
# 신규 필드
lineage:
  parent_session_id: "2026-04-15_phase-e"      # null이면 root 세션
  seed_source:                                  # 부모에서 어떤 상태를 이어받았는지
    strategy_version: 3
    program_version: 2
    notable_keep_commits:                       # 이 커밋들은 새 세션의 code-archive/에 replay
      - "def456abc"
      - "aaa111bbb"
  inherited_at: "2026-04-22T10:00:00Z"
```

#### 3.5.2 Init flow 변경 (`init.md` Step 3 이후)

현재 flow:
```
Step 3: Ask user for goal + eval_mode
Step 4: Collect strategy parameters
Step 5: Create .deep-evolve/ layout
```

변경 flow:
```
Step 3: Ask user for goal + eval_mode
Step 3.5 — Lineage Decision:
  Read .deep-evolve/sessions.json. If at least one completed session exists:
    AskUserQuestion:
      - "fresh: 이 프로젝트 첫 세션처럼 빈 상태로 시작"
      - "continue from <last-completed>: 최신 세션의 strategy/program을 seed로 이어받기"
      - "continue from ...: 특정 세션 선택"
      - "transfer from other project: 기존 transfer.md 경로 (cross-project)"
    continue 경로 선택 시:
      - parent_session_id 기록
      - parent의 evolve-receipt.json에서 최종 strategy.yaml_content, program.md_content, notable_keeps 로드
      - 새 세션 디렉터리에 복제 (notable_keeps는 program.md 상단 "## Inherited Context" 단락으로 embed)
Step 4: ...
```

#### 3.5.3 "Inherited Context" 단락 템플릿

새 세션의 `program.md`가 자동 생성될 때 상단에 삽입:

```markdown
## Inherited Context (from <parent_session_id>)

이 세션은 선행 세션 `<parent_session_id>`의 결과를 이어받는다.

### 이어받은 전략 패턴 (strategy.yaml v<N>)
<핵심 파라미터 3~5개 bullet>

### 선행 세션에서 검증된 개선 (notable keeps)
- <n=45> score+0.182: switch volatility metric to GARCH(1,1)
- <n=38> score+0.091: add rolling z-score normalization

### 선행 세션의 최종 교훈 (마지막 meta-analysis 발췌)
<최근 generation의 meta-analysis 첫 단락>

---

(이하 본 세션의 실험 program)
```

**효과**: 새 세션의 Claude가 program.md를 읽는 것만으로 선행 세션의 결론을 인지. 프롬프트 엔지니어링 부담 없음.

---

## 4. 마이그레이션 경로

기존 `.deep-evolve/` 플랫 구조를 가진 프로젝트 대응:

1. init 또는 resume 첫 실행 시 `.deep-evolve/session.yaml`이 root에 있고 `current.json`이 없으면 legacy로 판정.
2. 사용자에게 AskUserQuestion:
   - "archive: 현재 `.deep-evolve/` 내용을 `.deep-evolve/legacy-<timestamp>/`로 이동하고 새 레이아웃 채택"
   - "abort: 마이그레이션 중단"
3. archive 선택 시:
   - `session_id = legacy-<ISO>_<goal-slug>`로 재명명
   - `sessions.json`에 entry 추가 (status="legacy", 필드는 가능한 만큼 추론)
   - legacy receipt는 생성 불가 (원본 데이터 불충분) → "legacy-recovery 불가" 플래그만 기록

2.2.0 릴리스 시 CHANGELOG에 migration 안내 필수.

---

## 5. 구현 파일 매핑

| 변경 내용 | 대상 파일 | 비고 |
|---|---|---|
| 디렉터리 레이아웃 + current.json + sessions.json 생성 | `skills/deep-evolve-workflow/protocols/init.md` Step 2~9 | `.deep-evolve/<id>/` 하위 mkdir, current.json write |
| 세대별 meta-analysis append | `skills/deep-evolve-workflow/protocols/outer-loop.md` Step 6.5.1 | `meta-analyses/gen-<N>.md`로 저장 |
| receipt 확장 + sessions.json update + meta-archive-local append | `skills/deep-evolve-workflow/protocols/completion.md` | experiments_table 등 4필드, 3 target 파일 동시 write |
| hook 경로 동적화 | `hooks/scripts/protect-readonly.sh` | `jq`로 current.json 읽어 glob 구성 |
| resume 프로토콜 | `skills/deep-evolve-workflow/protocols/resume.md` (신규) | Step 1~5 |
| resume 진입점 | `commands/deep-evolve.md` dispatch | `resume` subcommand + init 시 current.json 선확인 |
| history 프로토콜 | `skills/deep-evolve-workflow/protocols/history.md` (신규) | Step 1~4 |
| history 진입점 | `commands/deep-evolve.md` dispatch | `history [session_id] [--lineage] [--export=...]` |
| lineage 선택 | `skills/deep-evolve-workflow/protocols/init.md` Step 3.5 추가 | AskUserQuestion 분기 |
| Inherited Context 단락 주입 | `skills/deep-evolve-workflow/protocols/init.md` Step 6 (program.md 생성) | continue 선택 시만 |
| 마이그레이션 | `skills/deep-evolve-workflow/protocols/init.md` Step 1.5 신규 | legacy layout 감지 분기 |

---

## 6. 검증 계획

1. **Phase F 세션 pilot** — Quant 프로젝트에서 init 시 "continue from phase-e" 선택, Inherited Context 주입 확인, Phase F 완료 후 `meta-archive-local.jsonl` 2줄 확인.
2. **Resume 시나리오** — Phase F 실험 10회 진행 후 Ctrl+C, 새 세션 시작, resume 선택, 실험 11부터 정합성 있게 재개되는지.
3. **History 정확성** — `/deep-evolve history --lineage`가 phase-f → phase-e → phase-d tree를 정확히 그리는지.
4. **Receipt 재현성** — Phase E 완료 후 `.deep-evolve/2026-04-15_phase-e/`를 삭제 → evolve-receipt.json만으로 `experiments_table`과 `generation_snapshots`로부터 주요 narrative 복원 가능한지 수동 검증.

---

## 7. 관련 선행 이슈

- `docs/improvements-from-quant-phase-e-session-2026-04-15.md` §3.A/3.B/3.C — outer loop 자동 트리거 개선. 본 설계는 Layer 5(lineage) init flow와 Step 3.5에서 통합되므로 두 PR을 순차 진행 권장 (3.A/B/C 먼저 → 본 설계 반영).

## 8. 버전 & 릴리스

- **v2.1.2**: 3.A/3.B/3.C 패치 (기존 이슈)
- **v2.2.0**: 본 설계 전체 (layer 1~5 + migration). receipt schema version bump (2.1.0 → 2.2.0).
- **v2.3.0 후보**: history UI 시각화, lineage의 cross-project 확장.

## 9. 열린 질문

1. **session_id에 커밋 해시를 포함할지**: 같은 날 fresh+continue 두 세션이 동일 goal slug면 충돌. 현재 안은 suffix `-2`, `-3`. 해시 suffix(`2026-04-15_phase-e_a1b2`)로 바꿀 가치 있을지.
2. **meta-archive-local vs 글로벌 meta-archive 중복 제거**: 완료 세션은 두 곳에 쓰여야 하는가, 아니면 글로벌은 cross-project transfer 성공 시에만 기록하는 현행 유지?
3. **`notable_keeps` 선정 기준**: top-N score improvement 고정인지, 아니면 outer loop Tier 2가 "이건 다른 세션에도 쓸 만하다"고 판정한 항목인지. 후자면 outer-loop.md에 명시적 마킹 단계 추가 필요.
4. **Resume 중 worktree 처리**: deep-evolve는 worktree를 쓰지 않지만 Phase별로 브랜치는 나뉨. resume 시 branch 상태 검증 step이 필요한가.

위 질문은 구현 착수 전 합의 필요.
