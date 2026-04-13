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

Then ask via AskUserQuestion:
"결과를 어떻게 적용할까요?"
Options:
- "main에 merge"
- "PR 생성"
- "branch 유지 (나중에 결정)"
- "폐기 (변경사항 삭제)"

Execute the chosen option using `session.yaml.lineage.current_branch` for the branch name:
- **Merge**: `git checkout main && git merge <session.yaml.lineage.current_branch>`
- **PR**: `git push -u origin <session.yaml.lineage.current_branch> && gh pr create --title "deep-evolve: <goal>" --body "<report summary>"`
- **Keep**: No action, inform user of branch name (`session.yaml.lineage.current_branch`)
- **Discard**: `git checkout main && git branch -D <session.yaml.lineage.current_branch>`

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
