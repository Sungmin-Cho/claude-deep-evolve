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

## A.1.6 — Virtual Parallel Analysis (v3.1+)

> **Version gate**: This stage runs ONLY when `$VERSION == "3.1.0"` (i.e., the
> dispatcher set `deep_evolve_version: "3.1.0"`). For v2.x / v3.0.x sessions,
> `VP_ANALYSIS=null` (no virtual_parallel block in session.yaml) and you proceed
> directly to A.2 without performing the AI call below. Skipping is silent —
> v3.0 sessions never had this stage and resume.md handles the absent block.

When `$VERSION == "3.1.0"`, classify the project on two axes that drive the N-seed
strategy: `project_type` (how well-defined the solution space is) and
`eval_parallelizability` (whether evaluation can run concurrently across seeds).
The AI returns a structured JSON object that A.2 (N confirmation) and A.3 (worktree
creation loop) both consume.

**Stage 6.1 — AI classification call**

Coordinator dispatches a single subagent (Task tool) with the following prompt
**verbatim** (W-7 lock — do not paraphrase, expand synonyms, or reorder cases;
test `test_a16_w7_prompt_verbatim_matrix` enforces character-for-character match):

> *"Given this project's goal (`{goal_string}`), target files (`{target_files}`),
> and existing program.md contents (`{program_md_content}`), classify along two axes:*
>
> *(1) project_type — choose one: `narrow_tuning` (1–2 obvious hyperparameters to sweep;
> well-defined objective; e.g. quant-tuning an existing Sharpe pipeline),
> `standard_optimization` (multiple choices, partially-known solution space; e.g. model
> architecture search within a known task), `open_research` (solution space poorly defined;
> e.g. novel algorithm design).*
>
> *(2) eval_parallelizability — choose one: `serialized` (evaluation holds an exclusive
> resource like a single GPU or shared backtest DB), `parallel_capable` (evaluation is
> a pure function, independent processes, or parallelizable API calls).*
>
> *Return JSON: `{"project_type": "...", "eval_parallelizability": "...", "n_suggested": <int 1-9>, "reasoning": "<1-2 sentences>"}`. Use this matrix for n_suggested:*
>
> *narrow_tuning + serialized → 1; narrow_tuning + parallel_capable → 2;*
> *standard_optimization + serialized → 2-3; standard_optimization + parallel_capable → 3-5;*
> *open_research + serialized → 3-4; open_research + parallel_capable → 5-9.*

The subagent's stdout MUST be a single JSON object. Coordinator captures it
into `$AI_VP_ANALYSIS_RAW`.

**Stage 6.2 — Validation (W-6 lesson: validate before consumption)**

Coordinator validates the AI return BEFORE either A.2 or A.3 consumes it.
Without validation, a malformed AI return (e.g. `n_suggested: "many"` as a
string, or `project_type: "narrow tuning"` with a space) propagates into
session.yaml and the worktree loop, where it either crashes or silently
corrupts state. The validation block normalizes the output into a single
`$VP_ANALYSIS` handle that downstream sites consume.

```bash
# Pure-python validator: rejects malformed shapes with rc=2 (operator error
# class — the AI subagent contract was violated, not a business decision).
# argv-safe pattern: $AI_VP_ANALYSIS_RAW passed via sys.argv (NOT shell-
# interpolated into source) — same code-injection-safe class as G8 C-R1
# queued_at and G9 C-1 SYNTHESIS_Q.
if ! VP_ANALYSIS_JSON=$(python3 - "$AI_VP_ANALYSIS_RAW" <<'PY'
import json, sys

PROJECT_TYPES = {"narrow_tuning", "standard_optimization", "open_research"}
EVAL_TYPES    = {"serialized", "parallel_capable"}

raw = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    obj = json.loads(raw)
except (json.JSONDecodeError, TypeError):
    print("error: AI VP analysis is not valid JSON", file=sys.stderr)
    sys.exit(2)

if not isinstance(obj, dict):
    print("error: AI VP analysis must be a JSON object", file=sys.stderr)
    sys.exit(2)

pt = obj.get("project_type")
ep = obj.get("eval_parallelizability")
ns = obj.get("n_suggested")
rs = obj.get("reasoning", "")

if pt not in PROJECT_TYPES:
    print(f"error: project_type must be one of {sorted(PROJECT_TYPES)}, got {pt!r}",
          file=sys.stderr); sys.exit(2)
if ep not in EVAL_TYPES:
    print(f"error: eval_parallelizability must be one of {sorted(EVAL_TYPES)}, got {ep!r}",
          file=sys.stderr); sys.exit(2)
# isinstance-not-bool guard: True/False would pass `isinstance(x, int)` in Python
if not isinstance(ns, int) or isinstance(ns, bool) or not (1 <= ns <= 9):
    print(f"error: n_suggested must be int in [1,9], got {ns!r}", file=sys.stderr)
    sys.exit(2)
if not isinstance(rs, str):
    print(f"error: reasoning must be string, got {type(rs).__name__}",
          file=sys.stderr); sys.exit(2)

print(json.dumps({
    "project_type": pt,
    "eval_parallelizability": ep,
    "n_suggested": ns,
    "reasoning": rs,
}, ensure_ascii=False))
PY
); then
  rc=$?
  # W-8 fix (Opus review 2026-04-25-161635): the prior plan prose described
  # a 3-retry loop, but the code below just exits — this was a prose-vs-code
  # contradiction. Decision: KEEP fail-fast (no retry loop). Rationale: a
  # malformed AI VP analysis is a contract bug to fix in the prompt
  # (W-7 lock), not a transient failure to retry. T6's β diversity gate is
  # different — it retries because the AI may legitimately produce too-similar
  # directions on first try (a quality, not contract, failure). Here, the
  # validator rejects shape violations only. The coordinator should surface
  # the validator stderr to the operator and require a code fix, not a
  # silent re-roll.
  echo "error: A.1.6 AI VP analysis validation failed (rc=$rc). The AI subagent produced a non-conforming JSON object — the prompt template (W-7 lock) or the subagent itself needs investigation. Aborting init." >&2
  exit 2
fi

# At this point $VP_ANALYSIS_JSON is a normalized JSON object guaranteed to
# satisfy the contract. Export it to the named handle. ALL downstream sites
# (A.2, A.3) consume $VP_ANALYSIS — never $AI_VP_ANALYSIS_RAW.
export VP_ANALYSIS="$VP_ANALYSIS_JSON"
```

**Stage 6.3 — Record analysis to session.yaml + journal**

The validated analysis is recorded to two places so that resume.md can re-
derive intent without re-asking the AI:

1. **session.yaml** — populate `virtual_parallel.project_type`,
   `virtual_parallel.eval_parallelizability`, `virtual_parallel.selection_reason`
   (← `reasoning`), and provisional `virtual_parallel.n_initial` (← `n_suggested`;
   may be re-confirmed in A.2). The full `virtual_parallel` block schema is in
   the v3.1 extension at A.3 step 4 below; here we only seed the analysis fields.

2. **journal** — append `init_vp_analysis` event:

   ```bash
   # Coordinator-owned event (no seed yet at init time) — wrap in
   # (unset SEED_ID; ...) subshell so T16's auto-inject does not corrupt
   # the event with a stale SEED_ID from any prior outer-loop run.
   (unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
     append_journal_event "$(jq -cn \
       --argjson vp "$VP_ANALYSIS" \
       '{event: "init_vp_analysis", vp_analysis: $vp}')")
   ```

**Stage 6.4 — Acknowledge N=1 short-circuit explicitly**

If the validated `n_suggested == 1`, this is a legitimate outcome (e.g.
narrow_tuning + serialized projects), NOT an error. § 5.1a documents three
short-circuits triggered by N=1:

1. β generation skipped (T6 honors `--n 1` per its own short-circuit; A.3 must
   pass through unchanged).
2. Synthesis steps 4–6 skipped (T28 honors `n_current == 1` at its own entry).
3. γ fork inapplicable at init (no prior keeps; A.3 omits γ branch naturally).

The A.2 prompt below treats `n_suggested == 1` as a normal, suggestable value;
do NOT silently force `>= 2`.

→ Proceed to A.2.

## A.2: Goal & Configuration

If `NEW_GOAL` was set from arguments, use it. Otherwise, ask via AskUserQuestion:

> **v3.1 note**: When `$VERSION == "3.1.0"`, an additional sub-stage A.2.6
> below confirms the seed count N. Q1–Q4 below run unchanged for all versions.

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


### A.2.6 — N confirmation (v3.1+)

> **Version gate**: This sub-stage runs ONLY when `$VERSION == "3.1.0"`. For
> v2.x / v3.0.x, `N_CHOSEN` is implicitly 1 and the rest of the protocol degrades
> to the v3.0 single-seed flow — A.3 below skips its v3.1 extension entirely.

A.2.6 confirms the seed count N produced by A.1.6, honoring user-supplied
overrides. The CLI flags `--n-min` / `--n-max` / `--no-parallel` land in T35
(G11); A.2.6 reads them as exported environment variables today, so G10 ships
self-contained.

**Stage 7.1 — Read overrides + initial N suggestion**

```bash
# Defaults: any of these may be unset (use ${VAR:-default}). Foundation
# defensive pattern — never bare $X under set -u.
NO_PARALLEL="${DEEP_EVOLVE_NO_PARALLEL:-0}"   # "1" forces N=1
N_MIN_USER="${DEEP_EVOLVE_N_MIN:-1}"          # user clamp lower bound
N_MAX_USER="${DEEP_EVOLVE_N_MAX:-9}"          # user clamp upper bound

# Validate env-var values: N_MIN / N_MAX must be integers in [1, 9].
# Reject non-integer / out-of-range with rc=2 (operator error).
if ! python3 -c '
import sys
try:
    nmin = int(sys.argv[1]); nmax = int(sys.argv[2])
except ValueError:
    print("error: DEEP_EVOLVE_N_MIN / DEEP_EVOLVE_N_MAX must be integers",
          file=sys.stderr); sys.exit(2)
if not (1 <= nmin <= 9) or not (1 <= nmax <= 9) or nmin > nmax:
    print(f"error: N_MIN ({nmin}) / N_MAX ({nmax}) must satisfy "
          f"1 <= N_MIN <= N_MAX <= 9", file=sys.stderr); sys.exit(2)
' "$N_MIN_USER" "$N_MAX_USER" 2>/dev/null; then
  echo "error: A.2.6 N-range override validation failed" >&2
  exit 2
fi

# Pull n_suggested + reasoning from the validated $VP_ANALYSIS handle.
# argv-safe pattern: $VP_ANALYSIS is interpolated as sys.argv (already
# validated to be JSON in A.1.6 Stage 6.2, but argv pattern is the same
# class-of-fix we apply uniformly per G8 C-R1 / G9 C-1).
# W-1 fix (Opus review 2026-04-25-161635): rc-guard the python3 -c calls per
# the aff23c9 contract — defense-in-depth across protocol boundaries (A.1.6
# already validated, but a corrupted VP_ANALYSIS reaching A.2.6 should fail
# loud, not silently propagate empty strings into the prompt).
if ! N_SUGGESTED=$(python3 -c '
import json, sys
print(json.loads(sys.argv[1])["n_suggested"])
' "$VP_ANALYSIS"); then
  echo "error: A.2.6 could not extract n_suggested from \$VP_ANALYSIS — A.1.6 contract violated" >&2
  exit 2
fi
if ! VP_REASONING=$(python3 -c '
import json, sys
print(json.loads(sys.argv[1])["reasoning"])
' "$VP_ANALYSIS"); then
  echo "error: A.2.6 could not extract reasoning from \$VP_ANALYSIS — A.1.6 contract violated" >&2
  exit 2
fi
```

**Stage 7.2 — Apply --no-parallel short-circuit BEFORE asking**

If the user passed `--no-parallel`, the answer to "what N?" is determined
already. Asking AskUserQuestion in this case is dishonest — surface the
override and proceed.

```bash
if [ "$NO_PARALLEL" = "1" ]; then
  echo "A.2.6: --no-parallel set; forcing N=1 regardless of AI suggestion ($N_SUGGESTED)" >&2
  N_CHOSEN=1
  N_REASON="user override (--no-parallel)"
else
  # Stage 7.3 — clamp AI suggestion to user range + global range
  N_CHOSEN_PROVISIONAL=$(python3 -c '
import sys
ns = int(sys.argv[1]); nmin = int(sys.argv[2]); nmax = int(sys.argv[3])
# Clamp to user range first, then global [1, 9]
clamped_user = min(max(ns, nmin), nmax)
clamped_global = min(max(clamped_user, 1), 9)
print(clamped_global)
' "$N_SUGGESTED" "$N_MIN_USER" "$N_MAX_USER")

  # Stage 7.4 — coordinator emits AskUserQuestion via the prose-instruction
  # pattern (mirrors synthesis.md Step 6 Branch B).
  cat <<EOM >&2
A.2.6: coordinator agent must invoke AskUserQuestion with the following:

  Prompt:
    동시 진행할 seed 개수 N은? (AI 제안: ${N_CHOSEN_PROVISIONAL}, 근거: ${VP_REASONING})
    예상 실험 비용: N × (사용자 입력 실험 횟수 ÷ N) 동일 — 병렬 효과는 wall-clock 단축뿐.
    사용자 범위: [${N_MIN_USER}, ${N_MAX_USER}]; 전역 범위: [1, 9].
  Options:
    - "AI 제안 ${N_CHOSEN_PROVISIONAL} 사용"
    - "직접 입력 (정수 1~9 ${N_MIN_USER}≤N≤${N_MAX_USER})"
    - "단일 seed (N=1)로 v3.0 호환 모드"

  After the user responds, export N_USER_CHOICE = <chosen integer> then re-
  enter this protocol at "Stage 7.5 (post-AskUserQuestion)".
EOM
  N_CHOSEN=""   # set by Stage 7.5 below
fi
```

**Stage 7.5 — (post-AskUserQuestion) Apply user choice with final clamp**

When the coordinator agent has captured `N_USER_CHOICE` and re-entered this
section, this block normalizes it. Tests provide `N_USER_CHOICE` via env
var.

```bash
if [ -z "${N_CHOSEN:-}" ] && [ -n "${N_USER_CHOICE:-}" ]; then
  # User may have typed something other than an integer; reject and re-ask.
  # W-2 fix (Opus review 2026-04-25-161635): do NOT swallow stderr — the
  # validator's diagnostic ("not an integer" / "outside [1, 9]") is more
  # useful than the bash echo's vague "invalid". The "error:" prefix
  # convention from the foundation pattern is honored by the python script.
  if ! python3 -c '
import sys
try:
    n = int(sys.argv[1])
except ValueError:
    print(f"error: N_USER_CHOICE {sys.argv[1]!r} not an integer", file=sys.stderr)
    sys.exit(2)
if not (1 <= n <= 9):
    print(f"error: N_USER_CHOICE {n} outside [1, 9]", file=sys.stderr); sys.exit(2)
' "$N_USER_CHOICE"; then
    echo "error: A.2.6 N_USER_CHOICE invalid (see python validator stderr above); re-ask via AskUserQuestion" >&2
    exit 2
  fi
  # Clamp to user range (a user-typed 7 with N_MAX=4 gets demoted to 4 with warn)
  N_CHOSEN=$(python3 -c '
import sys
n = int(sys.argv[1]); nmin = int(sys.argv[2]); nmax = int(sys.argv[3])
clamped = min(max(n, nmin), nmax)
if clamped != n:
    print(f"warn: user N={n} clamped to user range [{nmin},{nmax}] → {clamped}",
          file=sys.stderr)
print(clamped)
' "$N_USER_CHOICE" "$N_MIN_USER" "$N_MAX_USER")
  N_REASON="user choice (clamped to [${N_MIN_USER},${N_MAX_USER}])"
fi

# Final invariant: N_CHOSEN is now an integer in [1, 9] regardless of path
# (no_parallel / AI-accepted / user-typed). Export for A.3 + journal.
export N_CHOSEN
export N_REASON
```

**Stage 7.6 — Journal the decision**

Coordinator emits `init_n_chosen` so resume.md can re-derive intent without
re-asking. (unset SEED_ID; ...) wrap because no seed exists yet at init time
and we don't want T16's auto-inject to corrupt session-wide events.

```bash
(unset SEED_ID; bash "$DEEP_EVOLVE_HELPER_PATH" \
  append_journal_event "$(jq -cn \
    --argjson n "$N_CHOSEN" \
    --arg reason "$N_REASON" \
    '{event: "init_n_chosen", n_chosen: $n, reason: $reason}')")
```

→ Proceed to A.2.5 (Meta Archive Lookup) unchanged.

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
session-helper.sh start_new_session "<goal>"
```
This creates `.deep-evolve/<session-id>/` with subdirs: `runs/`, `code-archive/`,
`strategy-archive/`, `meta-analyses/`. Sets `$SESSION_ID` and `$SESSION_ROOT`. Writes
`current.json` and `sessions.jsonl`.

> **v2.2.2 note (M-1, R-12)**: The legacy `--parent=<parent_id>` argument is still
> accepted by the helper for backwards compatibility but is no longer invoked directly
> from this protocol. Lineage is recorded via `lineage_set` event in Step 3.5 below
> (canonical flow).

3. Add `.deep-evolve/` to `.gitignore` (if not already present):
```bash
echo ".deep-evolve/" >> .gitignore
git add .gitignore
git commit -m "chore: add .deep-evolve/ to gitignore"
```

3.5. **Lineage Decision** (canonical via `lineage_set` event — M-1 fix):

Run `session-helper.sh list_sessions --status=completed`.
If at least one completed session exists:
  AskUserQuestion: "이 프로젝트에는 완료된 세션 N개가 있습니다. 어떻게 시작할까요?"
    - "fresh: 빈 상태로 시작" → parent_session = null, no lineage event
    - "continue from <last-completed>" → parent_session.id = last
    - "continue from ...: 특정 세션 선택" → list + pick
    - "transfer from other project" → 기존 transfer.md 경로

  If `continue` is selected, let `PARENT_ID` be the chosen parent's session_id.
  Execute (in order):
  1. `session-helper.sh append_sessions_jsonl lineage_set "$SESSION_ID" --parent_session_id="$PARENT_ID"`
     (`cmd_list_sessions` reduces `lineage_set` events into `parent_session_id` for queries)
  2. Copy parent's final `$EVOLVE_DIR/$PARENT_ID/strategy.yaml` → `$SESSION_ROOT/strategy.yaml`
  3. Populate `parent_session:` block in session.yaml (Step 4) with parent's receipt schema
     version and seed source
  4. Read parent's receipt for Step 6 Inherited Context generation

4. Generate `session.yaml` with all collected configuration.
   Must include `eval_mode` field (`cli` or `protocol`).
   If `protocol`, also include `protocol_tools` (list of required MCP/tool names).
   Include `program` version tracking, `outer_loop` state, and `evaluation_epoch`:
   ```yaml
   session_id: "<computed>"
   deep_evolve_version: "3.0.0"
   status: initializing                 # C-7: transitions to 'active' at end of Step 11
   created_at: "<ISO 8601 now>"
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
   shortcut:                           # v3.0.0 — spec §5.3
     cumulative_flagged: 0             # reset after 6.a.5 forced Section D
     flagged_since_last_tier3: 0       # reset after §7.3 Tier 3 expansion
     total_flagged: 0                  # lifetime counter (reporting only)
   diagnose_retry:                     # v3.0.0 — spec §5.3
     session_retries_used: 0           # counts toward max_per_session
     gave_up_count: 0
   legibility:                         # v3.0.0 — spec §5.3
     missing_rationale_count: 0
   entropy:                            # v3.0.0 — spec §5.3
     last_collapse_generation: null
   ```

#### v3.1.0 extension (when $VERSION == "3.1.0")

When `deep_evolve_version: "3.1.0"`, the session.yaml additionally includes the
`virtual_parallel` block. Coordinator populates this during Section A.2/A.3:

````yaml
deep_evolve_version: "3.1.0"  # version gate

virtual_parallel:
  enabled: true                # always true in 3.1+; N=1 is just n_current: 1
  n_current: <N>
  n_initial: <N>               # snapshot of init N (before any n_adjusted)
  n_range: {min: 1, max: 9}
  project_type: "<narrow_tuning|standard_optimization|open_research>"
  eval_parallelizability: "<serialized|parallel_capable>"
  selection_reason: "<AI's reasoning string>"
  budget_total: <total experiment budget>
  budget_unallocated: 0        # initially 0 (all split across seeds); grows when kills free budget
  synthesis:
    budget_allocated: <min(2*N, 10)>
    regression_tolerance: 0.05
  seeds:
    - id: 1
      status: "active"          # active | killed_<condition> | completed_early
      direction: "<β direction string, or null if N=1>"
      hypothesis: "<β hypothesis string, or null if N=1>"
      initial_rationale: "<β rationale, or 'single-seed session; no β generated' if N=1>"
      worktree_path: "worktrees/seed_1"   # relative to $SESSION_ROOT
      branch: "evolve/<session-id>/seed-1"
      created_at: "<ISO 8601>"
      created_by: "init_batch"  # init_batch | epoch_growth
      experiments_used: 0
      keeps: 0
      borrows_given: 0
      borrows_received: 0
      current_q: 0.0
      allocated_budget: <budget_total // N>   # equal split at init
      killed_at: null
      killed_reason: null
    # ... seed_2 … seed_N similarly ...
````

When `$VERSION` is "2.x" or "3.0.x", use the pre-existing v2/v3.0 template
unchanged (virtual_parallel block absent).

5. Generate evaluation harness based on eval_mode:

   **If eval_mode is `cli`:**
   Generate `prepare.py` from appropriate template:
   - If project has stdout-parseable metrics → use `templates/prepare-stdout-parse.py` template
   - If project has test framework → use `templates/prepare-test-runner.py` template
   - If code quality / pattern goal → use `templates/prepare-scenario.py` template
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

7. Initialize `results.tsv`:

   IF session.yaml.deep_evolve_version starts with `"3."`:
     Header: `commit\tscore\tstatus\tcategory\tscore_delta\tloc_delta\tflagged\trationale\tdescription`
     (9 columns, tab-separated, trailing newline)

   ELSE (v2 or earlier):
     Header: `commit\tscore\tstatus\tdescription` (4 columns, existing behavior)

   Downstream consumers (completion.md report, resume.md progress summary) use
   column-count auto-detect (see Task 19.5 Step 2) to read whichever layout is
   present.

8. Initialize empty `journal.jsonl`.

9. Generate `$SESSION_ROOT/strategy.yaml` with default parameters:
   ```yaml
   # strategy.yaml — Evolving strategy parameters (modified by Outer Loop)
   version: 2                          # v3.0.0 schema

   idea_selection:
     method: "weighted"                # random | sequential | weighted
     weights:                          # 10 categories — see protocols/taxonomy.md
       parameter_tune: 0.15
       refactor_simplify: 0.15
       add_guard: 0.10
       algorithm_swap: 0.15
       data_preprocessing: 0.10
       caching_memoization: 0.05
       error_handling: 0.10
       api_redesign: 0.10
       test_expansion: 0.05
       other: 0.05
     candidates_per_step: 3
     min_novelty_distance: 2

   judgment:
     min_delta: 0.001
     crash_tolerance: 3
     marginal_policy: "discard"
     diagnose_retry:                   # v3.0.0 — spec §5.a
       enabled: true
       max_per_session: 10
       severe_drop_delta: 0.05
       error_keywords:
         - "timeout"
         - "nan"
         - "inf"
         - "shape mismatch"
         - "exit 1"
         - "traceback"
         - "oom"

   convergence:
     consecutive_discard_limit: 10
     plateau_window: 15
     plateau_action: "branch"

   exploration:
     radical_threshold: 20
     backtrack_enabled: true
     backtrack_strategy: "least_explored"

   shortcut_detection:                 # v3.0.0 — spec §5.2
     enabled: true
     auto_flag_delta: 0.05
     min_loc: 5
     cumulative_threshold: 3           # 6.a.5 forced Section D trigger
     tier3_flagged_threshold: 3        # §7.3 stagnation trigger
     seal_prepare_read: false          # opt-in; when true, blocks reads too

   legibility:                         # v3.0.0 — spec §5.2
     enabled: true
     require_rationale_on_keep: true
     max_rationale_chars: 120
     block_identical_to_description: true

   entropy_tracking:                   # v3.0.0 — spec §5.2
     enabled: true
     window_size: 20
     collapse_threshold_bits: 1.5
   ```
   If meta-archive lookup (A.2.5) found a similar project, use its `final_strategy` as initial values.

   **Note (v3.0.0)**: If A.2.5 Meta Archive Lookup returned a v2 archive entry
   (`schema_version < 3`), its `final_strategy.weights` were already translated to
   10-category form via `session-helper.sh migrate_v2_weights` (see transfer.md).
   Use the translated values as initial weights above; otherwise use the defaults.

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

11. **Baseline measurement + writeback + status transition** (C-7):

    Scoring contract requires `session.yaml.metric.baseline == 1.0` for minimize
    metrics (raw → inverted → 1.0). This step establishes that contract. The session
    is still `status: initializing`, so `protect-readonly.sh` does NOT yet enforce
    prepare.py protection — we can writeback `BASELINE_SCORE` during this step.

    **11.a — First measurement (raw)**:

    **If eval_mode is `cli`:**
    ```bash
    python3 $SESSION_ROOT/prepare.py > $SESSION_ROOT/runs/run-000-raw.log 2>&1
    ```

    **If eval_mode is `protocol`:**
    Execute the evaluation protocol defined in `$SESSION_ROOT/prepare-protocol.md`:
    - Follow each step exactly using the specified tools
    - Record all tool call results to `$SESSION_ROOT/runs/run-000-raw.log`
    - Compute score using the protocol's formula

    Parse `raw_score` from the `score: X.XXXXXX` line.

    **11.b — BASELINE_SCORE writeback** (cli mode, stdout-parse template, minimize
    direction only):

    For `stdout-parse` template with `METRIC_DIRECTION == "minimize"`, writeback the
    raw measurement so the second run produces 1.0:

    - Read `$SESSION_ROOT/prepare.py`
    - Replace the line `BASELINE_SCORE = None` with `BASELINE_SCORE = <raw_score>`
      (Write tool — hook allows writes because session.yaml.status is `initializing`)
    - Re-run: `python3 $SESSION_ROOT/prepare.py > $SESSION_ROOT/runs/run-000.log 2>&1`
    - Parse `score:` from the new log — it MUST be `1.000000` (± float epsilon).
    - If it is not ~1.0, abort with: "baseline writeback 검증 실패: expected ~1.0, got <score>"

    For `test-runner` / `scenario` templates (pass-rate based) and `maximize` metrics:
    - No writeback needed; `raw_score` is already the normalized baseline.
    - Copy `run-000-raw.log` → `run-000.log` for consistency.

    **11.c — Record baseline**:

    - `session.yaml.metric.baseline = 1.0` (for minimize after writeback) or `raw_score`
      (for maximize / pass-rate templates)
    - `session.yaml.metric.current = session.yaml.metric.baseline`
    - `session.yaml.metric.best = session.yaml.metric.baseline`
    - Append to `results.tsv`:
      
      **If `session.yaml.deep_evolve_version` starts with `"3."`** (9-column v3 schema):
      ```
      baseline\t<baseline_value>\tbaseline\t\t0\t0\tfalse\t\tinitial measurement
      ```
      (9 tab-separated fields: `commit=baseline`, `score=<value>`, `status=baseline`,
      empty `category`, `score_delta=0`, `loc_delta=0`, `flagged=false`, empty
      `rationale`, `description="initial measurement"`. Matches Step 7's 9-col
      header; prevents awk-split misreads in resume.md/completion.md consumers.)
      
      **Else** (v2 4-column schema, existing behavior):
      ```
      baseline\t<baseline_value>\tbaseline\tinitial measurement
      ```

    **11.d — Status transition**:

    `session-helper.sh mark_session_status "$SESSION_ID" active`

    From this point forward, `protect-readonly.sh` enforces prepare.py/program.md/
    strategy.yaml protection. The inner loop can proceed.

→ Proceed to Inner Loop: Read `protocols/inner-loop.md`
