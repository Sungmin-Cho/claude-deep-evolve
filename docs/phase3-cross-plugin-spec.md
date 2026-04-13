# Phase 3: 크로스 플러그인 피드백 — 구현 스펙

이 문서는 deep-evolve v2.0.0 (Phase 0-2) 구현 완료를 전제로, Phase 3 크로스 플러그인 피드백의 구현 사양을 정리한다.

**선행 조건**: 이 문서를 읽기 전에 다음을 확인한다:
- `docs/deep-evolve-modification-spec.md` — 전체 아키텍처 맥락
- `docs/deep-evolve-research-context.md` — HyperAgents/autoresearch 배경

---

## v2.0에서 변경된 전제 (Phase 0-2 반영)

Phase 3의 기존 스펙은 v1.x 구조를 전제로 작성되었다. v2.0에서 다음이 변경되었으므로 Phase 3 스펙을 그에 맞게 조정한다:

| 변경 사항 | Phase 3 영향 |
|-----------|-------------|
| `commands/deep-evolve.md` → 116줄 진입점 + 6개 protocols/ | 수정 대상 파일이 `protocols/completion.md`, `protocols/init.md` 등으로 변경 |
| `strategy.yaml` 추가 | evolve-receipt.json에 strategy 진화 데이터 포함 필요 |
| Q(v) 메타 메트릭 | dashboard의 evolve 차원에서 Q(v) 궤적 활용 가능 |
| Evaluation Epoch | receipt에 epoch 정보 포함, dashboard에서 epoch 간 비교 경고 |
| Outer Loop 세대 | receipt에 outer_loop 세대 수, 전략 아카이브 크기 포함 |
| meta-archive.jsonl | evolve-insights.json 생성 시 meta-archive에서 추출 |
| Scoring Contract 통일 | deep-review 연동 시 "score는 항상 higher-is-better" 전제 |
| 프로토콜 분리 구조 | deep-evolve 쪽 수정은 protocols/ 파일 단위로 수행 |

---

## 수정 범위 요약

| 플러그인 | 수정 파일 | 변경 유형 |
|----------|-----------|-----------|
| **deep-evolve** | `protocols/completion.md` | evolve-receipt.json 생성 + deep-review 트리거 |
| **deep-evolve** | `protocols/init.md` | recurring-findings.json 소비 |
| **deep-evolve** | `protocols/transfer.md` | evolve-insights.json 내보내기 |
| **deep-dashboard** | `lib/dashboard/collector.js` | evolve 데이터 수집 함수 추가 |
| **deep-dashboard** | `lib/dashboard/effectiveness.js` | evolve 차원 추가 |
| **deep-dashboard** | `lib/dashboard/action-router.js` | evolve 관련 액션 매핑 추가 |
| **deep-review** | `commands/deep-review.md` | recurring findings 내보내기 추가 |
| **deep-work** | `commands/deep-research.md` | harnessability + evolve insights 소비 (선택적) |

---

## 3.1 deep-evolve → deep-dashboard (데이터 내보내기)

### 3.1.1 evolve-receipt.json 생성

**수정 파일**: `skills/deep-evolve-workflow/protocols/completion.md` (Section E)

Section E의 report.md 생성 직후, `.deep-evolve/evolve-receipt.json`을 생성한다.

**v2.0 반영 스키마**:

```json
{
  "plugin": "deep-evolve",
  "version": "2.0.0",
  "timestamp": "2026-04-13T10:00:00Z",
  "goal": "val_bpb minimize",
  "eval_mode": "cli",
  "experiments": {
    "total": 80,
    "kept": 20,
    "discarded": 55,
    "crashed": 5,
    "keep_rate": 0.25
  },
  "score": {
    "baseline": 0.998,
    "current": 0.955,
    "best": 0.952,
    "improvement_pct": 4.6
  },
  "strategy_evolution": {
    "outer_loop_generations": 4,
    "q_trajectory": [0.35, 0.42, 0.48, 0.51],
    "strategy_versions": 3,
    "best_generation": 3
  },
  "program": {
    "versions": 3,
    "meta_analyses": 2
  },
  "evaluation_epochs": 2,
  "archives": {
    "strategy_archive_size": 4,
    "code_archive_size": 8,
    "code_forks_used": 2
  },
  "meta_archive_updated": true,
  "transfer": {
    "received_from": "archive_001",
    "adopted_patterns_kept": 0.7
  },
  "duration_minutes": 480,
  "quality_score": 78
}
```

**quality_score (0-100) 계산 공식 (v2.0 업데이트)**:
```
quality_score = (
  keep_rate * 20 +                                    # 실험 효율 (0-20)
  min(improvement_pct / 10, 1.0) * 30 +               # 개선 폭 (0-30)
  (1 - crashed / total) * 15 +                        # 안정성 (0-15)
  min(program.meta_analyses / 3, 1.0) * 10 +          # 메타 학습 활용 (0-10)
  min(strategy_evolution.outer_loop_generations / 5, 1.0) * 15 +  # 전략 진화 깊이 (0-15)
  (1 if code_forks_used > 0 else 0) * 5 +             # 코드 아카이브 활용 (0-5)
  (1 if transfer.received_from else 0) * 5             # 전이 학습 활용 (0-5)
)
```

v1.x 대비 변경점:
- `strategy_evolution` 블록 신규 (Q(v) 궤적, 세대 수)
- `evaluation_epochs` 신규
- `archives` 블록 신규 (전략/코드 아카이브 사용량)
- `transfer` 블록 신규 (전이 출처, 채택률)
- quality_score 공식에 전략 진화 깊이(15%), 아카이브 활용(5%), 전이 활용(5%) 추가

### 3.1.2 deep-dashboard collector.js 수정

**수정 파일**: `claude-deep-dashboard/lib/dashboard/collector.js`

`collectDeepEvolve()` 함수 추가:

```javascript
/**
 * Collect deep-evolve data.
 *
 * Paths:
 *   <root>/.deep-evolve/evolve-receipt.json
 *   <root>/.deep-evolve/session.yaml (status 확인용)
 */
function collectDeepEvolve(root) {
  const receiptPath = path.join(root, '.deep-evolve', 'evolve-receipt.json');
  const sessionPath = path.join(root, '.deep-evolve', 'session.yaml');

  const receipt = readJson(receiptPath);
  const hasSession = pathExists(sessionPath);

  return {
    status: receipt !== null ? 'available' : (hasSession ? 'active_session' : 'no_data'),
    receipt,
  };
}
```

`collectData()` 반환 객체에 추가:
```javascript
export function collectData(projectRoot) {
  const root = path.resolve(projectRoot);
  return {
    deepWork: collectDeepWork(root),
    deepReview: collectDeepReview(root),
    deepDocs: collectDeepDocs(root),
    deepEvolve: collectDeepEvolve(root),     // 추가
    harnessability: collectHarnessability(root),
  };
}
```

### 3.1.3 deep-dashboard effectiveness.js 수정

**수정 파일**: `claude-deep-dashboard/lib/dashboard/effectiveness.js`

WEIGHTS에 `evolve` 차원 추가. 기존 가중치를 재분배:

```javascript
const WEIGHTS = {
  health:         0.25,  // 0.30 → 0.25
  fitness:        0.20,  // 0.25 → 0.20
  session:        0.20,  // 0.25 → 0.20
  harnessability: 0.15,  // 0.20 → 0.15
  evolve:         0.20,  // 신규
};
```

`extractEvolveScore()` 함수:

```javascript
function extractEvolveScore(data) {
  const receipt = data.deepEvolve?.receipt;
  if (receipt === null || receipt === undefined) return null;

  const qs = receipt.quality_score ?? null;
  if (qs !== null && typeof qs === 'number') {
    return Math.min(10, Math.max(0, Math.round(qs) / 10));
  }
  return null;
}
```

not_applicable 재분배 패턴은 기존과 동일 (evolve 데이터 없으면 다른 차원에 가중치 분배).

### 3.1.4 deep-dashboard action-router.js 수정

**수정 파일**: `claude-deep-dashboard/lib/dashboard/action-router.js`

ACTION_MAP에 evolve 관련 항목 추가:

```javascript
const ACTION_MAP = {
  // ... 기존 항목 유지 ...
  'evolve-low-keep':       { action: 'Run /deep-evolve with meta analysis for strategy refinement',  category: 'evolve' },
  'evolve-high-crash':     { action: 'Check eval harness stability before next /deep-evolve',        category: 'evolve' },
  'evolve-stale':          { action: 'Run /deep-evolve to continue improvement',                     category: 'evolve' },
  'evolve-low-q':          { action: 'Review strategy.yaml — Q(v) trajectory is declining',          category: 'evolve' },
  'evolve-no-transfer':    { action: 'Run /deep-evolve on more projects to build meta-archive',      category: 'evolve' },
};
```

`extractEvolveFindings()` 함수:

```javascript
function extractEvolveFindings(data) {
  const receipt = data.deepEvolve?.receipt;
  if (!receipt) return [];

  const findings = [];
  const experiments = receipt.experiments;
  if (!experiments) return findings;

  // Low keep rate
  if (experiments.keep_rate !== undefined && experiments.keep_rate < 0.15) {
    findings.push({
      finding: 'evolve-low-keep',
      severity: 'warning',
      detail: `keep rate ${(experiments.keep_rate * 100).toFixed(0)}% — meta analysis로 전략 개선 권장`,
    });
  }

  // High crash rate
  if (experiments.total > 0 && experiments.crashed / experiments.total > 0.2) {
    findings.push({
      finding: 'evolve-high-crash',
      severity: 'error',
      detail: `crash rate ${((experiments.crashed / experiments.total) * 100).toFixed(0)}% — eval harness 안정성 점검 필요`,
    });
  }

  // Declining Q(v) trajectory
  const qt = receipt.strategy_evolution?.q_trajectory;
  if (qt && qt.length >= 3) {
    const last3 = qt.slice(-3);
    if (last3[2] < last3[0]) {
      findings.push({
        finding: 'evolve-low-q',
        severity: 'warning',
        detail: `Q(v) trajectory declining: ${last3.map(q => q.toFixed(2)).join(' → ')}`,
      });
    }
  }

  return findings;
}
```

### 3.1.5 deep-dashboard formatter.js 수정

**수정 파일**: `claude-deep-dashboard/lib/dashboard/formatter.js`

evolve 섹션 포맷팅 추가. receipt이 있을 때 표시:

```
## Evolve
| Metric | Value |
|--------|-------|
| Experiments | 80 (keep: 25%, crash: 6%) |
| Improvement | +4.6% from baseline |
| Strategy Evolution | 4 generations, Q: 0.35 → 0.51 |
| Archives | 4 strategies, 8 code snapshots, 2 forks |
| Transfer | From archive_001 (adoption: 70%) |
| Quality Score | 78/100 |
```

### 3.1.6 deep-dashboard collector.js 주석 업데이트

Supported plugins 주석에 deep-evolve 추가.

---

## 3.2 deep-evolve → deep-review (자동 트리거 제안)

**수정 파일**: `skills/deep-evolve-workflow/protocols/completion.md` (Section E)

Section E에서 사용자가 "main에 merge" 또는 "PR 생성"을 선택했을 때:

```
merge/PR 실행 전에 AskUserQuestion:
"deep-review로 최종 변경사항을 독립 검증할 수 있습니다."
Options:
- "deep-review 실행 후 merge" → /deep-review 실행, 완료 후 merge/PR 진행
- "바로 merge" → 즉시 진행
- "branch 유지 (나중에 review)" → branch만 유지

"deep-review 실행 후 merge" 선택 시:
1. deep-review가 lineage.current_branch의 전체 diff를 리뷰
   (※ v2.0: 항상 session.yaml.lineage.current_branch에서 최종 브랜치를 resolve)
2. APPROVE → 자동 merge/PR 진행
3. REQUEST_CHANGES → 리뷰 결과 표시, 사용자에게 판단 위임
4. deep-review가 생성한 .deep-review/receipts/*.json은 deep-dashboard에서 수집 가능
```

---

## 3.3 deep-review → deep-evolve (역방향 피드백: recurring findings)

### 3.3.1 deep-review에 recurring findings 내보내기 추가

**수정 파일**: `claude-deep-review/commands/deep-review.md`

리뷰 완료 시(Stage 6: Report 생성 후), recurring findings를 구조화 파일로 내보내는 단계 추가:

```
Stage 6.5: Recurring Findings Export

.deep-review/reports/ 내 모든 리포트를 읽어 반복 발견되는 패턴 추출:

1. 모든 리포트의 Critical + Warning 항목을 수집
2. 같은 유형의 finding이 3회 이상 나타나면 "recurring"으로 분류
3. .deep-review/recurring-findings.json에 기록:

{
  "updated_at": "2026-04-13T10:00:00Z",
  "findings": [
    {
      "type": "missing-error-handling",
      "severity": "critical",
      "occurrences": 5,
      "example_files": ["src/api/handler.ts:45", "src/worker/processor.ts:120"],
      "description": "async 함수에서 try-catch 없이 외부 API 호출"
    }
  ]
}

이 파일은 deep-evolve가 소비할 수 있는 표준 인터페이스.
```

### 3.3.2 deep-evolve에서 recurring findings 소비

**수정 파일**: `skills/deep-evolve-workflow/protocols/init.md` (Section A.1 Stage 3)

```
Stage 3 추가 — Review Findings Integration:

.deep-review/recurring-findings.json이 존재하면:
1. 파일 읽기
2. recurring findings를 prepare.py의 시나리오 생성에 반영:
   - "missing-error-handling" → 에러 핸들링 관련 시나리오 가중치 높임
   - "inconsistent-naming" → 네이밍 일관성 검사 시나리오 추가
3. program.md 생성 시 "알려진 반복 결함" 섹션에 findings 포함
4. strategy.yaml 초기값에 findings 관련 idea_selection.weights 반영:
   - recurring finding이 error_handling이면 → structural_change 가중치 증가
```

v2.0 추가: strategy.yaml의 초기 가중치에도 findings가 반영됨.

---

## 3.4 deep-dashboard → deep-work (harnessability 기반 guide 강화)

> 이 항목은 deep-evolve 자체와는 직접 관련이 없지만, Phase 3 (크로스 플러그인 피드백)의 완결성을 위해 포함.

**수정 파일**: `claude-deep-work/commands/deep-research.md` (Phase 1 Research)

```
Phase 1 추가 — Harnessability Context:

.deep-dashboard/harnessability-report.json이 존재하면:
1. 파일 읽기
2. 점수가 낮은 차원(< 5.0)을 research context에 포함
3. topology 감지 시 harnessability 낮은 차원을 topology template에 보강 제안으로 추가
```

최소 침습적 변경: deep-work의 Phase 1 research guide에 1개 조건 블록만 추가.

---

## 3.5 deep-evolve → deep-work (메타 아카이브 기반 insights 내보내기)

**수정 파일**: `skills/deep-evolve-workflow/protocols/transfer.md` (Section E.0 직후)

```
Section E.1: Cross-Plugin Feedback Export (선택적)

meta-archive에서 현재 프로젝트와 유사한 항목들의 strategy_evolution을 분석하여,
deep-work/deep-review에 유용한 인사이트를 내보낸다:

.deep-evolve/evolve-insights.json:

{
  "updated_at": "2026-04-13T10:00:00Z",
  "insights_for_deep_work": [
    {
      "pattern": "guard_clause",
      "evidence": "keep_rate 0.35 across 3 projects, Q(v) +0.08 improvement",
      "suggestion": "Phase 3 implement 시 guard clause 패턴 우선 적용"
    }
  ],
  "insights_for_deep_review": [
    {
      "pattern": "error_handling",
      "evidence": "experiments targeting error handling had 60% keep rate",
      "suggestion": "review criteria에 error handling coverage 강화"
    }
  ]
}

v2.0: evidence에 Q(v) 데이터 포함. meta-archive의 strategy_evolution에서 추출.

deep-work의 Phase 1에서 이 파일이 있으면 research context로 소비.
deep-review의 init에서 이 파일이 있으면 rules.yaml 제안에 반영.
```

이 파일은 "제안" 수준이며, 각 플러그인이 소비 여부를 자체 판단한다.

---

## 크로스 플러그인 데이터 흐름 (v2.0 기준)

```
                    deep-evolve
                   ┌────────────┐
                   │  Inner Loop │
                   │  Outer Loop │
                   │  Q(v)       │
                   └──────┬─────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
         ▼                ▼                ▼
  evolve-receipt.json  recurring-findings  evolve-insights.json
         │             (소비 ←)            │
         │                │                │
         ▼                │                ▼
  ┌──────────────┐  ┌─────┴──────┐  ┌───────────┐
  │deep-dashboard│  │deep-review │  │ deep-work  │
  │              │  │            │  │            │
  │ collector    │  │ Stage 6.5  │  │ Phase 1    │
  │ effectiveness│  │ recurring  │──│ research   │
  │ action-router│  │ findings   │  │ context    │
  │ formatter    │  │ export     │  │            │
  └──────────────┘  └────────────┘  └───────────┘
         │                                │
         └──── harnessability-report ─────┘
```

**양방향 흐름**:
- deep-evolve → deep-dashboard: evolve-receipt.json (실험 결과 + Q(v) + 전략 진화)
- deep-evolve → deep-review: merge 전 리뷰 트리거 제안
- deep-review → deep-evolve: recurring-findings.json (반복 결함 → 실험 방향 조향)
- deep-evolve → deep-work: evolve-insights.json (메타 아카이브 기반 인사이트)
- deep-dashboard → deep-work: harnessability-report.json (약점 → research context)

---

## 구현 순서 및 체크리스트

### Phase 3A: deep-evolve 내부 변경 (~2시간)

- [ ] `protocols/completion.md` — evolve-receipt.json 생성 로직 (v2.0 스키마, quality_score 공식)
- [ ] `protocols/completion.md` — merge/PR 전 deep-review 트리거 제안 (lineage.current_branch 사용)
- [ ] `protocols/init.md` — recurring-findings.json 소비 로직 (Stage 3 + strategy.yaml 초기값)
- [ ] `protocols/transfer.md` — evolve-insights.json 내보내기 로직 (Section E.1)

### Phase 3B: deep-dashboard 변경 (~2시간)

- [ ] `lib/dashboard/collector.js` — `collectDeepEvolve()` 함수 추가
- [ ] `lib/dashboard/collector.js` — `collectData()` 반환값에 deepEvolve 추가
- [ ] `lib/dashboard/collector.test.js` — collectDeepEvolve 테스트 추가
- [ ] `lib/dashboard/effectiveness.js` — WEIGHTS에 evolve 차원 추가 (0.20), 기존 재분배
- [ ] `lib/dashboard/effectiveness.js` — `extractEvolveScore()` 함수 추가
- [ ] `lib/dashboard/effectiveness.test.js` — evolve 차원 테스트 추가
- [ ] `lib/dashboard/action-router.js` — ACTION_MAP에 evolve 항목 5건 추가
- [ ] `lib/dashboard/action-router.js` — `extractEvolveFindings()` 함수 추가 (Q(v) 궤적 감지 포함)
- [ ] `lib/dashboard/formatter.js` — evolve 섹션 포맷팅
- [ ] `lib/dashboard/collector.js` 주석 — Supported plugins에 deep-evolve 추가

### Phase 3C: deep-review 변경 (~1시간)

- [ ] `commands/deep-review.md` — Stage 6.5 Recurring Findings Export 추가
- [ ] recurring-findings.json 스키마 정의

### Phase 3D: deep-work 변경 (선택적, ~30분)

- [ ] `commands/deep-research.md` — Phase 1 Harnessability Context 추가
- [ ] `commands/deep-research.md` — evolve-insights.json 소비 로직 추가

### 문서 업데이트

- [ ] deep-suite README — Plugin Data Flow 다이어그램에 deep-evolve 양방향 연결선 추가
- [ ] deep-suite README — Framework Coverage 표에 크로스 플러그인 전이 추가
- [ ] 각 플러그인 CHANGELOG 업데이트
- [ ] docs/deep-evolve-modification-spec.md — Phase 3 체크리스트 체크 완료 표시

---

## 성공 기준

Phase 3 완료 시:
- `/deep-harness-dashboard` 실행 시 evolve 차원이 effectiveness 점수에 포함됨
- evolve 차원에 Q(v) 궤적 하락이 감지되면 action-router가 경고 표시
- deep-evolve 완료 후 merge 시 deep-review 트리거 제안이 표시됨
- deep-review에서 3회 이상 발견된 패턴이 recurring-findings.json에 기록됨
- 다음 `/deep-evolve` 세션에서 recurring findings가 program.md + strategy.yaml에 자동 반영됨
- evolve-insights.json이 deep-work Phase 1에서 research context로 표시됨
- deep-suite README의 Plugin Data Flow 다이어그램에 deep-evolve가 양방향으로 연결됨

---

## 변경하지 않는 것

- **deep-evolve의 Core Protocol / Strategy Layer / Outer Loop**: Phase 2에서 완성된 구조를 수정하지 않음
- **Q(v) 계산 공식**: Core Protocol에 고정된 상태 유지
- **meta-archive.jsonl 스키마**: Phase 2에서 정의된 스키마 유지. Phase 3에서는 읽기만 함
- **deep-wiki, deep-docs**: 이번 변경에서 직접 수정하지 않음
- **deep-dashboard의 harnessability scorer**: 기존 6차원 점수 체계 유지. evolve는 effectiveness에만 추가

---

## 구현 시 참고: 각 플러그인 레포 위치

| 플러그인 | 레포 |
|----------|------|
| deep-evolve | `claude-deep-evolve` (현재 레포) |
| deep-dashboard | `claude-deep-dashboard` |
| deep-review | `claude-deep-review` |
| deep-work | `claude-deep-work` |
| deep-suite (통합 README) | `claude-deep-suite` |

Phase 3는 4개 레포에 걸친 변경이므로, 각 레포별로 브랜치를 생성하고 PR을 만드는 것이 좋다. deep-evolve 내부 변경(Phase 3A)을 먼저 완료하고, 다른 플러그인 변경(Phase 3B-D)을 순차 진행한다.
