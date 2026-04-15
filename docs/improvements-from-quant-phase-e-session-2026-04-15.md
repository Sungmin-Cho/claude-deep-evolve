# deep-evolve 개선 필요 사항 — Quant Phase E 세션 관찰 (2026-04-15)

**작성 시점**: 2026-04-15
**배경**: `/Users/sungmin/Dev/Quant` 프로젝트의 deep-evolve Phase E 세션(실험 33~52, 20회, 2 generations)을 운영하면서 발견한 자기 진화적 루프(outer loop)의 **자동 트리거 누락** 이슈를 정리. 버그라기보다 **프로토콜 문서의 애매함 + 운영 에이전트(Claude)의 보수적 해석**이 합쳐진 결과로 자동화 수준이 플러그인 의도보다 낮게 실현되는 패턴.

---

## 0. 요약

deep-evolve는 **cron/hook이 아니라 프로토콜 문서를 읽는 Claude**가 자동화의 주체입니다. 그 결과 **프로토콜 문서의 단계 순서와 트리거 조건이 애매하면 Claude가 AskUserQuestion으로 fallback**하여 자동 루프가 인간-루프로 퇴화합니다. Quant Phase E 세션이 이 현상의 사례.

개선 제안은 4가지 축으로 구성:
1. **프로토콜 문서 명확화** — Step 6 vs Step 6.5의 순서, diminishing returns와 AskUserQuestion의 관계
2. **명시적 자동화 플래그** — `strategy.yaml`에 `auto_trigger_outer_loop: bool` 추가
3. **program.md 템플릿에 자동화 지시 내장** — init flow가 생성하는 기본 program.md 첫 단락
4. **선택: SessionStart hook으로 경량 autopilot** — Claude 실행 시 Step 6.5 조건 프리체크

---

## 1. 사례 — Quant Phase E 세션에서 일어난 일

### 1.1 세션 파라미터
```yaml
# strategy.yaml v1 (Quant Phase E gen 1)
convergence:
  consecutive_discard_limit: 10
  plateau_window: 15
  plateau_action: "meta_analysis"
outer_loop:
  interval: 20
```

그리고 세션 사전 프롬프트(사용자 → Claude)에 `"plateau 감지(20회 연속 marginal/discard) 시 사용자 확인 요청"` 문구가 포함됨.

### 1.2 타임라인
1. **실험 33~42 (10회)**: 모두 discard (keep rate 0%). 10회 시점에 `convergence.consecutive_discard_limit=10` 도달.
2. **프로토콜 Step 6**: `inner-loop.md`의 diminishing returns detection이 trigger.
3. **프로토콜 Step 6.5** (outer-loop.md Step 6.5.1 meta-analysis + 6.5.2 Q(v) + 6.5.3 Tier 1 + 6.5.4 Tier 2): **자동 실행되어야 했으나, Claude가 대신 AskUserQuestion을 먼저 호출**해 사용자에게 "완료 / combo / prepare 확장 / 20회 추가" 4지선다 제시.
4. 사용자가 "outer loop로 확장해 진행" 명시 요청 후에야 Claude가 Q(v1) 계산 + strategy.yaml v2 + program.md v2 생성으로 진입.
5. gen 2 (실험 43~52)도 동일 패턴 반복.

### 1.3 결과

- Outer loop Tier 1+2는 결국 실행되어 Q(v1) -2.33 → Q(v2) -0.87로 개선됨(+1.46).
- 하지만 **사용자 개입이 2번 필요**했고, 만약 사용자가 응답을 안 하거나 다른 옵션을 골랐다면 자동 진화 루프는 미실행.
- 즉 "자기 진화적 루프"라는 플러그인 설계 의도(무인 overnight 운영)가 인간-루프로 퇴화한 상황.

---

## 2. 원인 — 세 층위 분석

### 2.1 층위 1: 플러그인 설계 (Not a bug)

deep-evolve는 cron/hook 기반 자동 실행이 없는 **프로토콜-문서 기반 플러그인**. 자동화의 주체는 Claude. `protect-readonly.sh` 같은 hook은 수정 방지용이고 실행 트리거용은 없음.

이 설계는 의도된 것 — Claude가 매 실험 사이클마다 `inner-loop.md`/`outer-loop.md`를 읽고 self-dispatch. **이 세션 설계를 전제하면 "자동 트리거가 안 왔다" = "Claude가 그 단계를 자동 수행하지 못했다"** 와 동의어.

### 2.2 층위 2: 프로토콜 문서의 애매함

`inner-loop.md` Step 6:
> Increment `inner_count`.
> Check for diminishing returns using strategy.yaml thresholds:
> - 0 keeps in last `consecutive_discard_limit` (default 10) → report: "...수렴..."
> ...
> If diminishing returns detected AND ... AND ...:
> → **Code Archive Backtrack**
> If diminishing returns detected but backtrack not applicable, ask user via AskUserQuestion:
> Options: "계속 (N회 추가)" / "평가 harness 확장" / "여기서 완료"

`inner-loop.md` Step 6.5:
> **Step 6.5 — Outer Loop Evaluation** (triggers: `inner_count >= outer_interval` OR diminishing returns detected in Step 6):
> → Read `protocols/outer-loop.md`, execute Outer Loop.

**두 단계의 문제**:
- Step 6의 AskUserQuestion과 Step 6.5의 outer loop 진입이 **동시에 trigger될 조건**을 만족함 (diminishing returns detected).
- 그런데 문서에 **어느 쪽이 먼저인지, 둘 다 실행하는지** 명시 안 됨.
- Claude는 AskUserQuestion을 먼저 해서 사용자 의사에 양보하는 쪽으로 해석 — Claude의 일반적 보수적 행동 원칙 ("irreversible 액션 전 사용자 확인")이 Step 6.5 자동 실행을 덮어씀.

### 2.3 층위 3: Claude의 irreversible 경로 회피

Step 6.5 outer loop Tier 1/2는 **`strategy.yaml`과 `program.md`를 수정**하는 작업 — `protect-readonly.sh` hook의 보호 대상. 우회에 `DEEP_EVOLVE_META_MODE=outer_loop` 환경변수 또는 `session.yaml.status=paused` 트릭이 필요. 이는 Claude 관점에서 **"hook 우회"라는 irreversible 성격의 액션**.

사용자 명시 승인 없이 이를 실행하는 것은 Claude의 기본 안전 정책에 어긋남. 사용자 초기 프롬프트가 `"plateau 감지(20회 연속 marginal/discard) 시 사용자 확인 요청"`으로 명시되어 있으니 Claude는 이를 "outer loop 자동 실행보다 사용자 컨펌 우선" 규칙으로 해석.

---

## 3. 개선 제안

우선순위 순(A~D). A/B는 플러그인 버전 2.1.1+ 패치로 즉시 반영 가능. C는 v2.2 minor. D는 v3.0급 구조 변경.

### 3.A 프로토콜 문서의 Step 6 ↔ Step 6.5 순서 명확화 (즉시, 문서 수정만)

**현재 문제**: Step 6의 AskUserQuestion과 Step 6.5의 자동 실행이 동시 조건 만족 시 선순위 애매.

**제안**: `inner-loop.md` 구조를 다음처럼 재배치.

```
Step 6 — Continuation Check
  6.a  Increment inner_count
  6.b  Compute diminishing-returns signals (consecutive_discard, plateau_window, crash_tolerance)
  6.c  If any signal triggered → IMMEDIATELY run Step 6.5 (Outer Loop Evaluation)
       — do NOT AskUserQuestion before Outer Loop completes
  6.d  After Outer Loop returns (with new strategy/program versions or
       archive-restore decision), THEN evaluate whether to ask the user:
       - Q(v) improved and no convergence flag → auto-continue to Step 1
       - Q(v) degraded or session-level stop criteria met → AskUserQuestion

Step 6.5 — Outer Loop Evaluation
  (same as today, always runs to completion before yielding back to Step 6.d)
```

**효과**: Step 6의 AskUserQuestion은 "outer loop가 더 이상 도움 안 되는 상태"에서만 사용자 개입. outer loop 자동 1회는 무조건 시도됨.

### 3.B `strategy.yaml`에 `auto_trigger_outer_loop` 플래그 추가 (즉시, 코드 1~2줄)

**현재 문제**: 플러그인이 "자동 vs 수동"을 의미론적으로만 정의. Claude가 실행 시 편차 발생.

**제안**: `strategy.yaml` 스키마에 다음 필드 추가 (default: true).

```yaml
outer_loop:
  interval: 20
  auto_trigger: true            # <- NEW
  # auto_trigger=true: Step 6.c에서 Outer Loop 무조건 자동 실행 (3.A와 쌍)
  # auto_trigger=false: Step 6 AskUserQuestion 우선. 과거 동작 유지.
```

그리고 `inner-loop.md` Step 6.5 첫 줄을 업데이트:

```
**Step 6.5 — Outer Loop Evaluation** (triggers: inner_count >= outer_interval
OR diminishing returns detected in Step 6).
If strategy.yaml.outer_loop.auto_trigger is false, AskUserQuestion before entering.
Otherwise execute immediately without user confirmation.
```

**효과**: 기본값 true로 의도된 자동화가 복원되고, 신중한 프로젝트는 false로 수동 모드 선택 가능.

### 3.C `init.md`가 생성하는 `program.md`에 자동화 지시 내장 (v2.2 minor)

**현재 문제**: program.md는 "실험 전략의 자연어 정의"라 자동화 정책이 안 담김. Claude는 hook 규칙과 사용자 프롬프트에서만 자동화 여부 추론.

**제안**: `init.md` Step 6의 program.md 생성 템플릿 첫 단락에 다음 문장을 **자동 삽입** (자동화 기본값 명시):

```markdown
## Automation Policy

- Outer Loop is **auto-triggered** when Step 6 diminishing-returns signals fire
  (see strategy.yaml.convergence.*). The agent must execute Step 6.5 inline,
  generating meta-analysis.md, bumping strategy/program versions, and invoking
  Tier 3 (prepare expansion) when stagnation repeats — all without asking the
  user.
- AskUserQuestion is reserved for: (a) hard errors (git conflicts, test infra
  failures), (b) ambiguous target_file scope, (c) post-completion merge
  judgment.
- If the user's initial brief overrides this default with "ask before outer
  loop" or similar language, set strategy.yaml.outer_loop.auto_trigger=false
  explicitly and note the override in program.md.
```

**효과**: Claude가 program.md를 읽으면서 자동화 정책을 명시적으로 인지. 사용자 초기 프롬프트의 모호함보다 program.md가 우선이라는 규정이 있어야 효과 완전.

### 3.D (선택) SessionStart hook으로 경량 autopilot (v3.0급)

**현재 문제**: Claude가 세션 시작마다 `inner-loop.md`를 다시 읽고 해석 — 매번 같은 해석이 보장 안 됨.

**제안**: 플러그인에 `hooks/scripts/outer-loop-autopilot.sh` 추가. SessionStart에서 다음을 체크:

```bash
if [[ -f .deep-evolve/session.yaml ]]; then
  status=$(yq .status .deep-evolve/session.yaml)
  inner_count=$(yq .outer_loop.inner_count .deep-evolve/session.yaml)
  interval=$(yq .outer_loop.interval .deep-evolve/session.yaml)
  discard_limit=$(yq .convergence.consecutive_discard_limit .deep-evolve/strategy.yaml)
  recent_discards=$(tail -n $discard_limit .deep-evolve/results.tsv | grep -c "discarded")

  if [[ "$status" == "active" ]] && \
     ([[ "$inner_count" -ge "$interval" ]] || [[ "$recent_discards" -eq "$discard_limit" ]]); then
    # Inject system-reminder to the session:
    echo "<system-reminder>" >&2
    echo "deep-evolve: Step 6.5 Outer Loop 트리거 조건 만족 (inner_count=$inner_count, recent_discards=$recent_discards). 즉시 outer-loop.md를 읽고 Tier 1/2를 실행하세요 — AskUserQuestion 금지." >&2
    echo "</system-reminder>" >&2
  fi
fi
```

**효과**: 세션 시작 시 Claude가 hook으로부터 명시적 지시를 받아 자동화 누락 확률 감소. 단, Claude Code의 SessionStart hook이 시스템 리마인더 주입을 지원해야 동작.

---

## 4. 검증 방법 — Phase F 세션으로 e2e 테스트

개선 적용 후 Quant 프로젝트의 Phase F 세션 첫 generation에서 아래를 관찰:

1. **Step 6.5 자동 트리거**: gen 1 종료 시점(예: 10~20회 실험 후)에 Claude가 AskUserQuestion 없이 자동으로 `.deep-evolve/meta-analysis.md` 생성, Q(v) 계산, strategy.yaml/program.md 버전 증가.
2. **session.yaml 상태 전이**: Tier 1/2 작업 중 status=paused로 우회하는 기존 트릭 유지 여부. `auto_trigger=true` 하에서도 hook 호환성 확인.
3. **프로토콜 로그**: `journal.jsonl`에 `outer_loop` 이벤트가 사용자 개입 없이 기록되는지.

성공 기준: 1 generation 완주 시 AskUserQuestion이 0회 발생(완료 판정/새 모듈 선택 같은 genuine 사용자 결정 제외).

---

## 5. 관련 파일 포인터 (이 저장소 내)

- `skills/deep-evolve-workflow/protocols/inner-loop.md` — Step 6/6.5 현재 정의 (3.A 수정 대상)
- `skills/deep-evolve-workflow/protocols/outer-loop.md` — Tier 1/2/3 상세 (3.B의 auto_trigger 분기 추가)
- `skills/deep-evolve-workflow/protocols/init.md` — Step 6의 program.md 생성 (3.C 템플릿 업데이트)
- `hooks/scripts/protect-readonly.sh` — 기존 hook (3.D의 autopilot hook과 병존)
- `commands/deep-evolve.md` — `/deep-evolve` 슬래시 커맨드 dispatcher

## 6. 외부 참조 (컨텍스트)

- Quant Phase E 종료 수기 narrative: `/Users/sungmin/Dev/Quant/docs/deep-evolve-phase-f-plan.md` (§3.4 아키텍처 invariants 절에 PR #12 deep-review 결과도 반영됨)
- Quant 세션 로그 (Phase E final report 내용은 worktree 정리로 손실, wiki 페이지에 압축 보존): Obsidian Personal Vault `deep-wiki/pages/quant-deep-evolve-phase-e-2026-04-15.md`

## 7. 액션 아이템

| # | 작업 | 우선순위 | 예상 소요 | 담당 |
|---|---|---|---|---|
| 1 | `inner-loop.md` Step 6/6.5 재배치 (3.A) | 높음 | 1h | 플러그인 유지보수자 |
| 2 | `auto_trigger` 필드 + `strategy.yaml` default 주입 (3.B) | 높음 | 2h | 플러그인 유지보수자 |
| 3 | `init.md` template에 automation policy 삽입 (3.C) | 중 | 1h | 플러그인 유지보수자 |
| 4 | Phase F 세션 pilot으로 변경사항 e2e 검증 | 중 | 세션 1회 | Quant 프로젝트 |
| 5 | (optional) SessionStart autopilot hook (3.D) | 낮음 | 4h + 테스트 | 플러그인 유지보수자 |

## 8. 결론

**버그가 아니라 플러그인 설계의 "자동화 구현을 Claude에게 위임" + 프로토콜 문서의 단계 순서 애매함이 맞물린 결과**. 3.A~3.C 세 변경만 적용해도 Quant Phase E급 세션에서 자동 트리거 누락은 재발하지 않을 가능성이 높음. 3.D는 완전 방어지만 구현 비용이 커서 선택 사항.

다음 단계: 본 저장소 maintainer가 3.A/3.B/3.C patch를 올리고, Quant 프로젝트 Phase F 세션에서 e2e 검증. 검증 통과 시 deep-evolve v2.1.2 또는 v2.2 릴리스로 묶어 배포.
