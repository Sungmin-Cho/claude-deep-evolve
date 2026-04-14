# Completion Report (Section E)

## Pre-completion: Meta Archive Update

Before generating the report, record this session's strategy evolution:
→ Read `protocols/transfer.md`, execute **Meta Archive Update (E.0)** section.

## Completion Report

Generate `.deep-evolve/report.md`:

Read `results.tsv` and `session.yaml` to compile:

```markdown
# Deep Evolve Report

**프로젝트**: <project_path>
**목표**: <goal>
**기간**: <created_at> ~ <now>

## 실험 통계
- 총 실험: <total>회 (keep <kept>, discard <discarded>, crash <crashed>)
- Outer Loop: <generations>세대, 최종 Q(v)=<value>
- 전략 진화: strategy.yaml v<version>, program.md v<version>
- 평가 harness: v<version> (<history summary>), epoch <N>
- Score: <baseline> → <best> (<improvement_pct>%)

## Score 변화
<list top 10 most impactful kept experiments from results.tsv>

## 교훈 (Discard 분석)
<analyze discard patterns — what approaches didn't work and why>

## 적용 방법
git diff deep-evolve/<tag>...main
```

Display the report to the user.

## Evolve Receipt Generation

Generate `.deep-evolve/evolve-receipt.json` from `session.yaml` and `results.tsv`:

```json
{
  "session_id": "<session.yaml.session_id>",
  "project_path": "<session.yaml.project_path>",
  "goal": "<session.yaml.goal>",
  "created_at": "<session.yaml.created_at>",
  "completed_at": "<now (ISO 8601)>",
  "lineage": {
    "base_branch": "<session.yaml.lineage.base_branch>",
    "current_branch": "<session.yaml.lineage.current_branch>",
    "tag": "<session.yaml.lineage.tag>"
  },
  "experiments": {
    "total": "<session.yaml.experiments.total>",
    "kept": "<session.yaml.experiments.kept>",
    "discarded": "<session.yaml.experiments.discarded>",
    "crashed": "<session.yaml.experiments.crashed>"
  },
  "scores": {
    "baseline": "<session.yaml.scores.baseline (normalized higher-is-better)>",
    "current": "<session.yaml.scores.current (normalized higher-is-better)>",
    "best": "<session.yaml.scores.best (normalized higher-is-better)>"
  },
  "improvement_pct": "<(best - baseline) / baseline * 100, rounded to 2 decimal places>",
  "quality_score": "<if experiments.total == 0 then 0, else kept / total * 100, rounded to 2 decimal places>",
  "outer_loop": {
    "generations": "<session.yaml.outer_loop.generations>",
    "q_value": "<session.yaml.outer_loop.q_value>"
  },
  "outcome": null
}
```

Notes:
- `improvement_pct` is always positive when `best > baseline`; use 0 if baseline == 0
- `quality_score` guard: if `experiments.total == 0`, set `quality_score = 0` (avoid division by zero)
- `outcome` is set to the user's chosen action after the menu selection below (e.g., `"deep-review-merge"`, `"deep-review-pr"`, `"merge"`, `"pr"`, `"keep"`, `"discard"`)
- Write the file before presenting the menu; update `outcome` after the user selects

Then ask via AskUserQuestion:
"결과를 어떻게 적용할까요?"
Options:
- "deep-review 실행 후 merge"
- "deep-review 실행 후 PR 생성"
- "main에 merge"
- "PR 생성"
- "branch 유지 (나중에 결정)"
- "폐기 (변경사항 삭제)"

Execute the chosen option using `session.yaml.lineage.current_branch` for the branch name:

- **deep-review 실행 후 merge**: Set `outcome = "deep-review-merge"` in receipt. → See **Deep-Review Integration** section below; on APPROVE auto-merge.
- **deep-review 실행 후 PR 생성**: Set `outcome = "deep-review-pr"` in receipt. → See **Deep-Review Integration** section below; on APPROVE auto-create PR.
- **main에 merge**: Set `outcome = "merge"` in receipt. `git checkout main && git merge <session.yaml.lineage.current_branch>`
- **PR 생성**: Set `outcome = "pr"` in receipt. `git push -u origin <session.yaml.lineage.current_branch> && gh pr create --title "deep-evolve: <goal>" --body "<report summary>"`
- **branch 유지 (나중에 결정)**: Set `outcome = "keep"` in receipt. No action; inform user of branch name (`session.yaml.lineage.current_branch`).
- **폐기 (변경사항 삭제)**: Set `outcome = "discard"` in receipt. `git checkout main && git branch -D <session.yaml.lineage.current_branch>`

After executing, write the updated `outcome` value back to `.deep-evolve/evolve-receipt.json`.

## Deep-Review Integration

This section applies only when the user chose **"deep-review 실행 후 merge"** or **"deep-review 실행 후 PR 생성"**.

**Target**: diff of `session.yaml.lineage.current_branch` against its base branch.

**Steps**:
1. Run the deep-review skill on the branch diff:
   - Invoke the deep-review evaluator targeting `lineage.current_branch`
2. Handle the deep-review result:

**APPROVE**:
- If path is `deep-review-merge`: `git checkout main && git merge <session.yaml.lineage.current_branch>`
- If path is `deep-review-pr`: `git push -u origin <session.yaml.lineage.current_branch> && gh pr create --title "deep-evolve: <goal>" --body "<report summary>"`

**REQUEST_CHANGES**:
- Display the deep-review findings to the user.
- Ask via AskUserQuestion: "deep-review가 변경을 요청했습니다. 어떻게 하시겠습니까?"
  Options:
  - "수정 후 재시도"
  - "그래도 진행 (review 무시)"
  - "branch 유지 (나중에 결정)"
  - "폐기 (변경사항 삭제)"
- Execute accordingly (on "그래도 진행" follow the original path's action).

**FAILURE** (deep-review tool itself fails or errors):
- Inform the user that deep-review encountered an error.
- If original path is `deep-review-merge`, ask via AskUserQuestion:
  "deep-review 실행에 실패했습니다. 어떻게 하시겠습니까?"
  Options:
  - "그래도 merge 진행"
  - "branch 유지 (나중에 결정)"
  - "중단"
- If original path is `deep-review-pr`, ask via AskUserQuestion:
  "deep-review 실행에 실패했습니다. 어떻게 하시겠습니까?"
  Options:
  - "그래도 PR 생성"
  - "branch 유지 (나중에 결정)"
  - "중단"
- Execute accordingly.

### Code Archive Cleanup

Before finalizing, clean up fork branches:
1. Keep the final branch (the one merged or kept)
2. Delete other fork branches that were merged or abandoned:
   ```bash
   git branch -d evolve/<session-id>/fork-* 2>/dev/null || true
   ```
   Only use `-d` (safe delete, merged branches only). Do NOT use `-D` (force delete).
3. Preserve `.deep-evolve/code-archive/` metadata files (useful for analysis).
4. Preserve `.deep-evolve/strategy-archive/` (useful for cross-project transfer).

Update `session.yaml.status` to `completed`.
