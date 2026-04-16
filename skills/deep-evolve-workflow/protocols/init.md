# Init Flow (Section A)

## A.1: Project Deep Analysis

Perform a 5-stage analysis of the current project. Every judgment must be grounded in actual file reads — no guessing.

**Stage 1 — Structure Scan:**
- Use Glob `**/*` to map the full file tree (NOT `**/*.*` — must include extensionless files like Makefile, Dockerfile, Procfile, etc.)
- Also use `ls` on the project root to catch marker directories (ProjectSettings/, Assets/, .uproject, etc.)
- Identify project type, language(s), and framework from ALL available signals:
  - Package manager configs (package.json, pyproject.toml, Cargo.toml, go.mod, etc.)
  - Build system files (Makefile, CMakeLists.txt, *.csproj, *.sln, build.gradle, etc.)
  - Engine/IDE project markers (ProjectSettings/, *.uproject, project.godot, *.xcodeproj, etc.)
  - Source file extensions and directory conventions
  - Any other configuration or manifest files present
- Identify entry point files and key source directories
- Read .gitignore to distinguish source from generated files
- NOTE: Do NOT refuse analysis for unfamiliar project types. Use all available signals to understand the project. If the project type is unclear, proceed with what you can determine and confirm with the user in Stage 5.

**Stage 2 — Dependency & Tooling:**
- Read build system and package manager configs for dependencies
- Detect available testing infrastructure:
  - Standard test frameworks (jest, pytest, vitest, cargo test, go test, etc.)
  - Engine/platform test runners (Unity Test Runner, Unreal Automation, Xcode XCTest, etc.)
  - Custom test scripts, Makefiles, or CI test commands
- Detect linter/formatter config (.eslintrc, ruff.toml, clippy, prettier, etc.)
- Check for CI/CD pipelines (GitHub Actions, Makefile, etc.)
- Check for available MCP servers (.mcp.json or Claude Code MCP config) that could assist evaluation
- Determine evaluation mode — classify into one of:
  - **cli**: Tests/metrics obtainable via a single shell command (most projects)
  - **protocol**: Evaluation requires MCP tools, a running editor/application, or multi-step tool orchestration (e.g., game engines, GUI applications, hardware-dependent systems)
- List available run/build/test commands

**Stage 3 — Code Deep Analysis:**
- Read ALL files that are candidates for modification (fully, not just headers)
- Read readonly/reference files' key interfaces and APIs
- Read existing test files to understand what is already tested
- Identify architecture patterns, module boundaries, data flow
- Assess current code quality level

**Stage 3.5 — Review Findings Integration:**

Check if `.deep-review/recurring-findings.json` exists. If not, skip this stage.

If it exists:
1. Read the file and parse the `findings` array
2. For each recurring finding, bias the evaluation harness generation:
   - `error-handling` category → strengthen error handling test scenarios in prepare.py
   - `test-coverage` category → add boundary value test scenarios
   - `security` category → add input validation scenarios
   - `performance` category → add performance benchmark scenarios
   - `naming-convention` category → add naming consistency checks (if applicable)
   - `type-safety` category → strengthen type validation scenarios
   - `architecture` category → add module boundary/dependency checks
3. Include findings in program.md generation under a dedicated section:
   ```markdown
   ## 알려진 반복 결함 (deep-review 기반)
   이 프로젝트에서 deep-review가 반복 발견한 패턴:
   - <category>: <description> (<occurrences>회)
   이 영역의 개선을 우선적으로 시도하라.
   ```
4. Adjust initial `strategy.yaml` `idea_selection.weights` based on findings:
   - `error-handling`, `security`, `architecture` findings → increase `structural_change` weight
   - `performance` findings → increase `algorithm_swap` weight
   - `naming-convention`, `type-safety` findings → increase `simplification` weight
   - Normalize weights to sum to 1.0 after adjustment

   Note: 이 가중치 조정은 A.2.5 Meta Archive Lookup에서 전이된 strategy의 weights 위에 적용된다.
   전이된 strategy가 있으면 전이된 weights를 base로 사용하고, findings 기반 조정을 그 위에 overlay한다.

**Stage 4 — Metric Validation:**
- **If eval_mode is `cli`:**
  - If user provided or you identified an eval command, execute it (dry run)
  - Parse the output format
  - Collect baseline metrics
  - Measure execution time (for timeout configuration)
  - Note any failure patterns
- **If eval_mode is `protocol`:**
  - Verify that required tools (MCP servers, etc.) are accessible
  - Perform a dry-run of the evaluation steps (e.g., call a simple read/status tool)
  - Confirm that tool responses contain the expected data fields
  - Estimate evaluation time per cycle
  - Note any connectivity or compatibility issues

**Stage 5 — Analysis Confirmation:**
Present a summary to the user:
```
프로젝트 분석 결과:
- 언어/프레임워크: <detected>
- 테스트: <detected test infrastructure>
- 수정 대상: <target files>
- 평가 모드: cli | protocol
- 평가 방법: <eval command or tool names>
- 메트릭: <metric name> (현재 <value>)
- 실행 시간: ~<seconds>초
```
Example (cli mode):
```
- 언어/프레임워크: Python (PyTorch)
- 평가 모드: cli
- 평가 명령: uv run train.py
- 메트릭: val_bpb (현재 0.998)
```
Example (protocol mode):
```
- 언어/프레임워크: C# (Unity 2022.3)
- 평가 모드: protocol (Unity MCP)
- 평가 도구: unity-mcp → PlayMode 테스트 실행
- 메트릭: replay_accuracy (현재 0.65)
```
Wait for user confirmation before proceeding.

## A.2: Goal & Configuration

If `NEW_GOAL` was set from arguments, use it. Otherwise, ask via AskUserQuestion:

**Q1**: "개선 목표는 무엇인가요?" (자유 텍스트)

**Q2**: "평가 방법은?" — Options based on analysis:
- If CLI eval command detected: "감지된 명령 사용: `<command>`" (cli 모드)
- If MCP/tool-based evaluation recommended: "프로토콜 평가: `<tool names>`" (protocol 모드)
- "직접 입력 (CLI 명령)"
- "직접 입력 (프로토콜 — 사용할 MCP/도구 지정)"
- "AI가 테스트 시나리오 생성"

**Q3** (if target_files not obvious): "수정 가능 파일은?"
- AI-suggested list from analysis
- "직접 지정"

If `REQUESTED_COUNT` was set, use it. Otherwise:
**Q4**: "실험 횟수는?" — Options: "30회", "50회", "100회", "감소 수익까지 자동"

## A.2.5: Meta Archive Lookup

→ Read `protocols/transfer.md`, execute **Meta Archive Lookup** section.

## A.3: Scaffolding

1. Create git branch:
```bash
git checkout -b deep-evolve/$(date +%b%d | tr '[:upper:]' '[:lower:]')
```

1.5. **Legacy layout migration** (v2.2.0):
If `.deep-evolve/session.yaml` exists at root and `.deep-evolve/current.json` does not exist:
→ This is a pre-v2.2.0 flat layout. The dispatcher should have already offered migration.
   If reached here, run `session-helper.sh migrate_legacy`.

2. Create session via helper:
```bash
session-helper.sh start_new_session "<goal>" [--parent=<parent_id>]
```
This creates `.deep-evolve/<session-id>/` with subdirs: `runs/`, `code-archive/`, `strategy-archive/`, `meta-analyses/`.
Sets `$SESSION_ROOT` to the created directory. Writes `current.json` and `sessions.jsonl`.

3. Add `.deep-evolve/` to `.gitignore` (if not already present):
```bash
echo ".deep-evolve/" >> .gitignore
git add .gitignore
git commit -m "chore: add .deep-evolve/ to gitignore"
```

3.5. **Lineage Decision** (v2.2.0):
Run `session-helper.sh list_sessions --status=completed`.
If at least one completed session exists:
  AskUserQuestion: "이 프로젝트에는 완료된 세션 N개가 있습니다. 어떻게 시작할까요?"
    - "fresh: 빈 상태로 시작" → parent_session = null
    - "continue from <last-completed>" → parent_session.id = last
    - "continue from ...: 특정 세션 선택" → list + pick
    - "transfer from other project" → 기존 transfer.md 경로
  If continue selected:
    - Copy parent's final strategy.yaml to $SESSION_ROOT/strategy.yaml
    - Record parent_session in session.yaml (Step 4에서)
    - Read parent receipt for Step 6 Inherited Context generation

4. Generate `session.yaml` with all collected configuration.
   Must include `eval_mode` field (`cli` or `protocol`).
   If `protocol`, also include `protocol_tools` (list of required MCP/tool names).
   Include `program` version tracking, `outer_loop` state, and `evaluation_epoch`:
   ```yaml
   session_id: "<computed>"
   deep_evolve_version: "2.2.0"
   parent_session:    # null for root sessions; populated if continue selected
     id: "<parent_id or null>"
     parent_receipt_schema_version: <N>
     seed_source:
       strategy_version: <N>
       program_version: <N>
       notable_keep_commit_refs: [...]
     inherited_at: "<now>"
   program:
     version: 1
     history:
       - version: 1
         experiments: "0-"
         keep_rate: null
         reason: "initial"
   outer_loop:
     generation: 0
     interval: 20
     inner_count: 0
     auto_trigger: true
     q_history: []
   evaluation_epoch:
     current: 1
     history:
       - epoch: 1
         prepare_version: 1
         generations: []
         best_Q: null
   lineage:
     current_branch: "deep-evolve/<tag>"
     forked_from: null
     previous_branches: []
   ```

5. Generate evaluation harness based on eval_mode:

   **If eval_mode is `cli`:**
   Generate `prepare.py` from appropriate template:
   - If project has stdout-parseable metrics → use `prepare-stdout-parse.py` template
   - If project has test framework → use `prepare-test-runner.py` template
   - If code quality / pattern goal → use `prepare-scenario.py` template
   Customize the template with project-specific metric names, weights, parse patterns.

   **If eval_mode is `protocol`:**
   Generate `prepare-protocol.md` from the `prepare-protocol.md` template.
   This defines a fixed evaluation protocol that Claude executes using available tools
   (MCP servers, browser automation, external APIs, etc.) instead of a shell command.
   Customize with:
   - Required tool names and exact call sequences
   - Parameters for each tool call
   - How to extract metrics from tool results
   - Score computation formula with weights
   - Expected output format (same `score: X.XXXXXX` standard)
   The protocol file is protected by the same readonly hook as prepare.py.

6. Generate `program.md` with experiment instructions tailored to the project.

   **program.md must start with the following sentinel-wrapped section (always present):**

   ```markdown
   <!-- automation-policy-v1 -->
   ## Automation Policy

   - Outer Loop는 diminishing-returns 감지 시 session.yaml.outer_loop.auto_trigger가
     true면 자동 실행. AskUserQuestion은 outer 완료 후 Q(v) 악화 또는 세션 종료 기준
     충족 시에만.
   - 사용자 초기 브리프에 "ask before outer loop" 류 지시가 있으면 auto_trigger=false로
     명시 설정하고 program.md에 override 기록.

   <!-- /automation-policy-v1 -->
   ```

   **If continue was selected in Step 3.5**, also insert Inherited Context:
   Run: `session-helper.sh render_inherited_context <parent_id>`
   Insert the output between the automation policy and the project-specific body.

   Then generate the project-specific experiment instructions below the sentinel block.

7. Initialize `results.tsv` with header: `commit\tscore\tstatus\tdescription`

8. Initialize empty `journal.jsonl`.

9. Generate `$SESSION_ROOT/strategy.yaml` with default parameters:
   ```yaml
   # strategy.yaml — Evolving strategy parameters (modified by Outer Loop)
   version: 1

   idea_selection:
     method: "weighted"              # random | sequential | weighted
     weights:
       parameter_tuning: 0.25
       structural_change: 0.25
       algorithm_swap: 0.25
       simplification: 0.25
     candidates_per_step: 3          # idea ensemble: generate N candidates, select best 1
     min_novelty_distance: 2         # skip ideas similar to last N attempts

   judgment:
     min_delta: 0.001                # minimum improvement threshold
     crash_tolerance: 3              # N consecutive crashes → strategy review
     marginal_policy: "discard"      # keep | discard | accumulate

   convergence:
     consecutive_discard_limit: 10   # N consecutive discards → strategy review
     plateau_window: 15              # no improvement in last N → convergence
     plateau_action: "branch"        # branch | meta_analysis | stop

   exploration:
     radical_threshold: 20           # N consecutive marginal → attempt radical change
     backtrack_enabled: true         # allow forking from previous keep commits
     backtrack_strategy: "least_explored"  # least_explored | highest_score | random
   ```
   If meta-archive lookup (A.2.5) found a similar project, use its `final_strategy` as initial values.

10. Show the user a summary of the generated evaluation harness:

    **If eval_mode is `cli`:**
    ```
    prepare.py 생성 완료:
    - 도메인: stdout 파싱 (ML 훈련)
    - 메트릭: val_bpb (minimize)
    - raw_command: uv run train.py
    - 가중치: val_bpb 100%
    확인하시겠습니까?
    ```

    **If eval_mode is `protocol`:**
    ```
    prepare-protocol.md 생성 완료:
    - 도메인: 프로토콜 기반 (<description>)
    - 평가 도구: <tool names>
    - 메트릭: <metric> (<direction>)
    - 평가 단계: <N>단계
    - 예상 평가 시간: ~<seconds>초
    확인하시겠습니까?
    ```
    Wait for confirmation.

11. Run baseline measurement:

    **If eval_mode is `cli`:**
    ```bash
    python3 $SESSION_ROOT/prepare.py > $SESSION_ROOT/runs/run-000.log 2>&1
    ```

    **If eval_mode is `protocol`:**
    Execute the evaluation protocol defined in `$SESSION_ROOT/prepare-protocol.md`:
    - Follow each step exactly using the specified tools
    - Record all tool call results to `$SESSION_ROOT/runs/run-000.log`
    - Compute score using the protocol's formula
    - Output in standard format: `score: X.XXXXXX`

    Parse baseline score and record in session.yaml and results.tsv.

→ Proceed to Inner Loop: Read `protocols/inner-loop.md`
