---
name: deep-evolve
description: |
  Autonomous experimentation protocol. Analyzes your project, generates an evaluation
  harness, and runs experiment loops to systematically improve code toward your goal.
  Supports init, resume, and completion workflows via state-based auto-routing.
allowed_tools: all
# Note: Bash tool is allowed but protect-readonly.sh hook intercepts shell writes
# to .deep-evolve/prepare.py and program.md during active experiment runs.
---

You are running the **deep-evolve** autonomous experimentation protocol.

## Step 0: Parse Arguments

Arguments: `$ARGUMENTS`

- If arguments contain a number (e.g., `50`): set `REQUESTED_COUNT` to that number
- If arguments contain a quoted string (e.g., `"new goal"`): set `NEW_GOAL` to that string
- Otherwise: `REQUESTED_COUNT = null`, `NEW_GOAL = null`

## Step 1: State Detection

Check if `.deep-evolve/session.yaml` exists in the current project root.

**If NO session.yaml exists** (or `NEW_GOAL` is set):
→ Go to **Section A: Init Flow**

**If session.yaml exists**, read the `status` field:
- `status: active` → Go to **Section B: Resume Flow**
- `status: paused` → Ask the user via AskUserQuestion:
  "이전 세션이 중단되었습니다. 이어서 진행할까요?"
  Options: "이어서 진행" / "새로 시작"
  - "이어서 진행" → Go to **Section B: Resume Flow**
  - "새로 시작" → Delete `.deep-evolve/`, Go to **Section A: Init Flow**
- `status: completed` → Ask the user:
  "이전 세션이 완료되었습니다. 새 세션을 시작할까요?"
  Options: "새로 시작" / "결과 다시 보기"
  - "새로 시작" → Delete `.deep-evolve/`, Go to **Section A: Init Flow**
  - "결과 다시 보기" → Read and display `.deep-evolve/report.md`

## Section A: Init Flow

### A.1: Project Deep Analysis

Perform a 5-stage analysis of the current project. Every judgment must be grounded in actual file reads — no guessing.

**Stage 1 — Structure Scan:**
- Use Glob `**/*.*` to map the full file tree
- Detect language/framework from config files (package.json, pyproject.toml, Cargo.toml, go.mod, requirements.txt, Gemfile, etc.)
- Identify entry point files (main, index, app, train, etc.)
- Read .gitignore to distinguish source from generated files

**Stage 2 — Dependency & Tooling:**
- Read package manager config for installed dependencies
- Detect test frameworks (jest, pytest, vitest, cargo test, go test, etc.)
- Detect linter/formatter config (.eslintrc, ruff.toml, clippy, prettier, etc.)
- Check for CI/CD (GitHub Actions, Makefile, etc.)
- List available run scripts

**Stage 3 — Code Deep Analysis:**
- Read ALL files that are candidates for modification (fully, not just headers)
- Read readonly/reference files' key interfaces and APIs
- Read existing test files to understand what is already tested
- Identify architecture patterns, module boundaries, data flow
- Assess current code quality level

**Stage 4 — Metric Validation:**
- If user provided or you identified an eval command, execute it (dry run)
- Parse the output format
- Collect baseline metrics
- Measure execution time (for timeout configuration)
- Note any failure patterns

**Stage 5 — Analysis Confirmation:**
Present a summary to the user:
```
프로젝트 분석 결과:
- 언어/프레임워크: Python (PyTorch)
- 테스트: pytest 42개
- 수정 대상: train.py (380줄)
- 평가 명령: uv run train.py
- 메트릭: val_bpb (현재 0.998)
- 실행 시간: ~310초
```
Wait for user confirmation before proceeding.

### A.2: Goal & Configuration

If `NEW_GOAL` was set from arguments, use it. Otherwise, ask via AskUserQuestion:

**Q1**: "개선 목표는 무엇인가요?" (자유 텍스트)

**Q2**: "평가 방법은?" — Options based on analysis:
- If eval command detected: "감지된 명령 사용: `<command>`"
- "직접 입력"
- "AI가 테스트 시나리오 생성"

**Q3** (if target_files not obvious): "수정 가능 파일은?"
- AI-suggested list from analysis
- "직접 지정"

If `REQUESTED_COUNT` was set, use it. Otherwise:
**Q4**: "실험 횟수는?" — Options: "30회", "50회", "100회", "감소 수익까지 자동"

### A.3: Scaffolding

1. Create git branch:
```bash
git checkout -b deep-evolve/$(date +%b%d | tr '[:upper:]' '[:lower:]')
```

2. Create `.deep-evolve/` directory structure:
```bash
mkdir -p .deep-evolve/runs
```

3. Add `.deep-evolve/` to `.gitignore` (if not already present):
```bash
echo ".deep-evolve/" >> .gitignore
git add .gitignore
git commit -m "chore: add .deep-evolve/ to gitignore"
```

4. Generate `session.yaml` with all collected configuration.

5. Generate `prepare.py` based on domain detection:
   - If project has stdout-parseable metrics → use `prepare-stdout-parse.py` template
   - If project has test framework → use `prepare-test-runner.py` template
   - If code quality / pattern goal → use `prepare-scenario.py` template
   Customize the template with project-specific metric names, weights, parse patterns.

6. Generate `program.md` with experiment instructions tailored to the project.

7. Initialize `results.tsv` with header: `commit\tscore\tstatus\tdescription`

8. Initialize empty `journal.jsonl`.

9. Show the user a summary of generated `prepare.py`:
```
prepare.py 생성 완료:
- 도메인: stdout 파싱 (ML 훈련)
- 메트릭: val_bpb (minimize)
- raw_command: uv run train.py
- 가중치: val_bpb 100%
확인하시겠습니까?
```
Wait for confirmation.

10. Run baseline measurement:
```bash
python3 .deep-evolve/prepare.py > .deep-evolve/runs/run-000.log 2>&1
```
Parse baseline score and record in session.yaml and results.tsv.

→ Proceed to **Section C: Experiment Loop**

## Section B: Resume Flow

Read `session.yaml` and `results.tsv`.

Display progress summary:
```
Deep Evolve 세션 재개
━━━━━━━━━━━━━━━━━━━━
목표: <goal>
실험: <total>회 완료 (keep <kept>, discard <discarded>, crash <crashed>)
Score: <baseline> → <current> (best: <best>)
prepare.py: v<version> (<scenarios>개 시나리오)
```

If `REQUESTED_COUNT` is set:
- Update `session.yaml.experiments.requested` to current total + REQUESTED_COUNT
- → Go to **Section C: Experiment Loop**

Otherwise, ask via AskUserQuestion:
Options:
- "이어서 실험 (30회 추가)"
- "이어서 실험 (50회 추가)"
- "prepare.py 확장" → Go to **Section D: Prepare Expansion**
- "완료 처리" → Go to **Section E: Completion Report**

## Section C: Experiment Loop

Read `session.yaml` for configuration. Read `results.tsv` and `journal.jsonl` for history.

Set `experiment_count` to 0. Set `max_count` to `session.yaml.experiments.requested` (or infinity if null).

### Branch & Clean-Tree Guard (Codex review fix)

Before ANY experiment work, verify safety preconditions. This check runs:
- Once at loop start
- Before EVERY `git reset --hard HEAD~1`

```
SAFETY CHECK:
1. Verify current branch matches session.yaml.git_branch:
   CURRENT=$(git branch --show-current)
   if CURRENT != session.yaml.git_branch → ABORT with error:
   "⛔ Branch mismatch: expected <session_branch>, on <current>. /deep-evolve에서 세션을 확인하세요."

2. Verify worktree is clean (excluding .deep-evolve/):
   DIRTY=$(git status --porcelain | grep -v '^\?\? .deep-evolve/')
   if DIRTY is not empty → ABORT with error:
   "⛔ Dirty worktree detected. 실험을 시작하기 전에 uncommitted 변경을 커밋하거나 stash하세요."
```

### Resume Reconciliation (Codex review fix)

Before starting, check last entry in `journal.jsonl`:
- If last status is `planned` → discard that plan, start fresh
- If last status is `committed` → run harness_command, continue from evaluation
- If last status is `evaluated` → apply judgment (compare score), continue
- If last status is `kept` → fully resolved, start fresh experiment
- If last status is `discarded` → check if rollback was completed:
  - Look for subsequent `{"id": <same_id>, "status": "rollback_completed"}` entry
  - If NO rollback_completed entry exists:
    → Run Branch & Clean-Tree Guard
    → Verify HEAD commit matches the journal's `commit` field
    → If match: execute `git reset --hard HEAD~1`, then append `{"id": <id>, "status": "rollback_completed"}`
    → If no match: HEAD was already reset (manual intervention), append `rollback_completed`
  - If rollback_completed exists → fully resolved, start fresh experiment

### Loop

Repeat until `experiment_count >= max_count` or diminishing returns detected:

**Step 1 — Idea Selection:**
- Read `results.tsv` to learn from previous keep/discard history
- Read current state of all target_files
- Read `program.md` for experiment strategy guidelines
- Avoid approaches that were previously discarded (check description column in results.tsv)
- Select ONE improvement idea
- Append to `journal.jsonl`: `{"id": <next_id>, "status": "planned", "idea": "<description>", "timestamp": "<now>"}`

**Step 2 — Code Modification:**
- Modify ONLY files listed in `session.yaml.target_files`
- Apply one idea per modification

**Step 3 — Git Commit:**
```bash
git add <target_files>
git commit -m "experiment: <idea description>"
```
- Get commit hash: `COMMIT=$(git rev-parse --short HEAD)`
- Append to `journal.jsonl`: `{"id": <id>, "status": "committed", "commit": "<COMMIT>", "timestamp": "<now>"}`

**Step 4 — Evaluation:**
- Run: `<harness_command> > .deep-evolve/runs/run-<NNN>.log 2>&1`
- Parse score from output (grep for `^score:` line)
- Append to `journal.jsonl`: `{"id": <id>, "status": "evaluated", "score": <score>, "timestamp": "<now>"}`

**Step 5 — Judgment:**

Compare `score` with `session.yaml.metric.current`:

**If score improved** (higher for maximize, lower for minimize):
- Append to `journal.jsonl`: `{"id": <id>, "status": "kept", "timestamp": "<now>"}`
- Append to `results.tsv`: `<COMMIT>\t<score>\tkept\t<idea description>`
- Update `session.yaml`: `metric.current = score`, `metric.best = min/max(best, score)`, increment `experiments.total` and `experiments.kept`

**If score same or worse:**
- Append to `journal.jsonl`: `{"id": <id>, "status": "discarded", "timestamp": "<now>"}`
- Append to `results.tsv`: `<COMMIT>\t<score>\tdiscarded\t<idea description>`
- Update `session.yaml`: increment `experiments.total` and `experiments.discarded`
- Run **Branch & Clean-Tree Guard** (verify branch + clean worktree)
- Run: `git reset --hard HEAD~1`
- Append to `journal.jsonl`: `{"id": <id>, "status": "rollback_completed", "timestamp": "<now>"}`

**If evaluation crashed:**
- Attempt a simple fix (1 attempt only)
- If fix works, re-evaluate
- If fix fails:
  - Append to `journal.jsonl`: `{"id": <id>, "status": "discarded", "reason": "crash", "timestamp": "<now>"}`
  - Append to `results.tsv`: `<COMMIT>\t0\tcrash\t<idea description>`
  - Update `session.yaml`: increment `experiments.total` and `experiments.crashed`
  - Run **Branch & Clean-Tree Guard** (verify branch + clean worktree)
  - Run: `git reset --hard HEAD~1`
  - Append to `journal.jsonl`: `{"id": <id>, "status": "rollback_completed", "timestamp": "<now>"}`

Increment `experiment_count`.

**Step 6 — Continuation Check:**

Check for diminishing returns (from last 10 experiments in results.tsv):
- 0 keeps in last 10 → report: "10회 연속 discard. Score가 수렴한 것 같습니다."
- keeps exist but max score delta < 0.001 in last 10 → report: "개선폭이 미미합니다."
- 3+ crashes in last 10 → report: "안정성 문제가 감지되었습니다."

If diminishing returns detected, ask user via AskUserQuestion:
Options:
- "계속 (N회 추가)"
- "prepare.py 확장 (더 어려운 시나리오 추가)" → Go to **Section D: Prepare Expansion**
- "여기서 완료" → Go to **Section E: Completion Report**

If `experiment_count >= max_count`:
→ Go to **Section E: Completion Report**

Otherwise: → Back to Step 1

## Section D: Prepare Expansion

1. Read current `.deep-evolve/prepare.py`
2. Re-analyze the project (Stage 3 only — code has changed since last analysis)
3. Identify new scenarios or harder test cases based on:
   - Areas where score plateaued
   - Patterns in discarded experiments
   - Code regions not covered by current scenarios
4. Generate updated `prepare.py` with new scenarios
5. Increment `session.yaml.prepare.version`
6. Append to `session.yaml.prepare.history`: `{version, scenarios, reason}`
7. Insert separator in `results.tsv`: `--- prepare v<old> -> v<new> (<old_count>-><new_count> scenarios) ---`
8. Run new baseline with expanded prepare.py
9. → Go to **Section C: Experiment Loop**

## Section E: Completion Report

Generate `.deep-evolve/report.md`:

Read `results.tsv` and `session.yaml` to compile:

```markdown
# Deep Evolve Report

**프로젝트**: <project_path>
**목표**: <goal>
**기간**: <created_at> ~ <now>

## 실험 통계
- 총 실험: <total>회 (keep <kept>, discard <discarded>, crash <crashed>)
- prepare.py 버전: <version> (<history summary>)
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

Execute the chosen option:
- **Merge**: `git checkout main && git merge deep-evolve/<tag>`
- **PR**: `git push -u origin deep-evolve/<tag> && gh pr create --title "deep-evolve: <goal>" --body "<report summary>"`
- **Keep**: No action, inform user branch name
- **Discard**: `git checkout main && git branch -D deep-evolve/<tag>`

Update `session.yaml.status` to `completed`.
