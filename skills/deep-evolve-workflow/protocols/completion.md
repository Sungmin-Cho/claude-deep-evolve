# Completion Report (Section E)

## Protocol Entry — Version Gate

Every entry to this protocol MUST initialize `$VERSION` locally. Do NOT rely
on shell state inherited from the caller — Claude Code's Read tool loads a
fresh context.

```bash
VERSION=$(grep '^deep_evolve_version:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/^deep_evolve_version:[[:space:]]*//; s/"//g')
```

The v3 signals block (added in Task 16) checks `$VERSION` locally to decide
whether to emit the v3-specific report section.

## Pre-completion: Meta Archive Update

Before generating the report, record this session's strategy evolution:
→ Read `protocols/transfer.md`, execute **Meta Archive Update (E.0)** section.

## Completion Report

Generate `$SESSION_ROOT/report.md`:

**Column-count auto-detect (v3 addition)**:

Read the first line of `$SESSION_ROOT/results.tsv`:

```bash
header_cols=$(head -1 "$SESSION_ROOT/results.tsv" | awk -F'\t' '{print NF}')
```

IF `$header_cols == 4`: v2 schema — columns are `commit score status description`.
IF `$header_cols == 9`: v3 schema — columns are `commit score status category score_delta loc_delta flagged rationale description`.
ELSE: abort with error: "Unexpected results.tsv column count: $header_cols. Expected 4 (v2) or 9 (v3)."

All downstream parsing in this report must use the detected column layout.

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

### v3.0.0 Signals (v3 sessions only)

IF $VERSION starts with "3.":

Append to report.md:

```markdown
## v3.0.0 Signals

- **Idea entropy trajectory**: <comma-separated entropy_bits per generation from journal entropy_snapshot events>
- **Shortcut flagged (total)**: <session.shortcut.total_flagged> (<pct>% of kept experiments)
- **Hard-rejected (flagged_unexplained)**: <count from journal.jsonl `discarded` events where reason="flagged_unexplained">
  (Count by: `grep -c '"reason":"flagged_unexplained"' $SESSION_ROOT/journal.jsonl` or `jq -c 'select(.status=="discarded" and .reason=="flagged_unexplained")' | wc -l`.
  Note: v3 results.tsv has no `reason` column — the journal `discarded` event
  is the authoritative source per §5.5.)
- **Diagnose-retry**: used <session.diagnose_retry.session_retries_used>/<strategy.judgment.diagnose_retry.max_per_session>, recovered <N>, gave up <session.diagnose_retry.gave_up_count>
- **Rationale missing**: <session.legibility.missing_rationale_count> / <total kept> (<pct>%)
- **Section D forced (from 6.a.5)**: <count of shortcut_escalation events in journal>
- **Tier 3 flagged-trigger fires**: <count of tier3_flagged_reset events in journal>
```

ELSE (v2): skip (existing report format unchanged).

Display the report to the user.

## Evolve Receipt Generation (M3 envelope-wrapped — v3.2.0+)

Generate `$SESSION_ROOT/evolve-receipt.json` as an **M3 envelope-wrapped artifact**
(cf. `claude-deep-suite/docs/envelope-migration.md` §1) from `session.yaml` and
`results.tsv`. The payload below — preserved verbatim from v3.1.x — becomes the
`payload` of the wrapped envelope.

> **Cross-plugin chain (handoff §3.3)**: when `.deep-review/recurring-findings.json`
> was consumed by Stage 3.5 (init.md), the wrap helper sets
> `envelope.parent_run_id = <recurring-findings envelope.run_id>` and adds the
> path to `envelope.provenance.source_artifacts[]`. This makes deep-review →
> deep-evolve traceable via `run_id` chain in M4 telemetry.

**Payload shape** (legacy v3.1.x receipt body, kept identical):

```json
{
  "plugin": "deep-evolve",
  "version": "<session.yaml.deep_evolve_version>",                        // string — MUST match session's recorded version (not hardcoded). v3.1 sessions emit "3.1.0"; v3.0.x sessions continuing to complete emit "3.0.0"; v2 sessions continuing to complete emit "2.2.2".
  "receipt_schema_version": 2,                                           // number
  "timestamp": "<ISO 8601 now>",                                         // string
  "goal": "<session.yaml.goal>",                                         // string
  "eval_mode": "<session.yaml.eval_mode>",                               // string: cli | protocol
  "experiments": {
    "total": <session.yaml.experiments.total>,                           // number (not string)
    "kept": <session.yaml.experiments.kept>,                             // number
    "discarded": <session.yaml.experiments.discarded>,                   // number
    "crashed": <session.yaml.experiments.crashed>,                       // number
    "keep_rate": <kept / total, ratio 0.0-1.0 — NOT percentage>          // number
  },
  "score": {
    "baseline": <session.yaml.metric.baseline>,                          // number (normalized, higher-is-better)
    "current": <session.yaml.metric.current>,                            // number
    "best": <session.yaml.metric.best>,                                  // number
    "improvement_pct": <(best - baseline) / baseline * 100>              // number (percentage, 0 when baseline==0)
  },
  "strategy_evolution": {
    "outer_loop_generations": <session.yaml.outer_loop.generation>,      // number
    "q_trajectory": [<Q values per generation>],                         // array of numbers
    "strategy_versions": <count of strategy-archive/ directories>,       // number
    "best_generation": <generation with highest Q in q_history>          // number
  },
  "program": {
    "versions": <session.yaml.program.version>,                          // number
    "meta_analyses": <count of program.history entries containing 'meta_analysis'>  // number
  },
  "evaluation_epochs": <session.yaml.evaluation_epoch.current>,          // number
  "archives": {
    "strategy_archive_size": <count of strategy-archive/ directories>,   // number
    "code_archive_size": <count of code-archive/ directories>,           // number
    "code_forks_used": <count of lineage.previous_branches>              // number
  },
  "meta_archive_updated": <true | false>,                                // boolean
  "transfer": {
    "received_from": <session.yaml.transfer.source_id or null>,          // string | null
    "adopted_patterns_kept": <ratio of transferred patterns retained>    // number | null
  },
  "duration_minutes": <minutes between created_at and now, or null>,     // number | null
  "quality_score": <0-100, computed below>,                              // number
  "outcome": null                                                        // string | null (set after user selection)
}
```

> **Type strictness (v2.2.2, M-3)**: values marked `// number` MUST be emitted as JSON
> numbers, not quoted strings. `cmd_append_meta_archive_local` and deep-dashboard
> aggregations depend on numeric arithmetic (`/`, `*`).

Notes:
- `duration_minutes`: null if session.yaml lacks created_at (pre-2.1.0 sessions)
- `improvement_pct` is always positive when `best > baseline`; use 0 if baseline == 0
- `quality_score` computation (0-100):
  if experiments.total == 0: quality_score = 0
  else: quality_score = (
    keep_rate * 20 +
    min(improvement_pct / 10, 1.0) * 30 +
    (1 - crashed / total) * 15 +
    min(program.meta_analyses / 3, 1.0) * 10 +
    min(outer_loop_generations / 5, 1.0) * 15 +
    (1 if code_forks_used > 0 else 0) * 5 +
    (1 if transfer.received_from else 0) * 5
  )
- `outcome` is set to the user's chosen action after the menu selection below (e.g., `"merged"`, `"pr_created"`, `"kept"`, `"discarded"`)
- Write the file before presenting the menu; update `outcome` after the user selects

**v2.2.0 receipt 확장 필드** (기존 필드 유지 + 아래 추가):

- `"receipt_schema_version": 2`
- `"experiments_table"`: $SESSION_ROOT/results.tsv 전체 dump (각 행에 generation 번호 매핑)
- `"generation_snapshots"`: $SESSION_ROOT/meta-analyses/gen-*.md 로드. 최대 10개; 초과 시 오래된 것부터 summary_only=true
- `"notable_keeps"`: journal.jsonl에서 `event: "notable_marked"` 항목 수집 (source="auto_top_n" 또는 "marked") + legacy `event: "outer_loop", notable: true` 항목도 항상 수집 (source="legacy") + session 전체 top-5 score_delta (source="top_n"). 세 source를 merge 후 중복 제거: experiment id 기준, 우선순위 auto_top_n > marked > legacy > top_n. (v2.2.0에서 시작하여 v2.2.1에서 completion하는 mixed-version 세션에서도 데이터 손실 없음)
- `"runtime_warnings"`: journal.jsonl에서 branch_mismatch_accepted, branch_rebound 등 수집
- `"parent_session"`: session.yaml.parent_session 복사

**Receipt write sequence**: write payload temp → envelope wrap → user selection →
outcome update via in-place `payload.outcome` edit → freeze.

### Envelope wrap (atomic)

Write the payload above to a temp file and invoke the wrap helper. The helper
generates `envelope.run_id` (ULID), sets `producer = "deep-evolve"`,
`artifact_kind = "evolve-receipt"`, `schema.name = "evolve-receipt"`, and
performs an **atomic** temp-then-rename write to the canonical path.

> **Important — failure semantics**: the snippet uses `set -euo pipefail` so
> that any sub-command failure aborts before `rm -f` runs. The cleanup is
> gated with an `if/then/else` block so that on helper failure the payload
> temp file is **preserved** for retry. To re-attempt a failed wrap, simply
> re-execute this section (the upstream payload composition does not re-run;
> the same payload temp file is used). (handoff §4 round-1 C2 lesson.)

```bash
set -euo pipefail

PAYLOAD_TMP="$SESSION_ROOT/.evolve-receipt.payload.json"
OUT_PATH="$SESSION_ROOT/evolve-receipt.json"

# Write the legacy payload JSON (composed from session.yaml + results.tsv per
# the schema above) to PAYLOAD_TMP. Outcome is null at this stage.

# Resolve PROJECT_ROOT locally — Bash-tool calls are stateless across
# invocations (handoff §4 round-1 W2 + Round-1 C1 lesson).
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Re-detect `.deep-review/recurring-findings.json` at finish time (Round-1
# C1 fix — Stage 3.5 in init.md does NOT persist this state to session.yaml,
# because session.yaml does not exist at A.1 time). The wrap helper applies
# its own identity gate (producer=deep-review, artifact_kind=
# recurring-findings, schema.name match, ULID format), so passing a path
# that is foreign-producer or legacy is safe — chain just skips.
REC_PATH="$PROJECT_ROOT/.deep-review/recurring-findings.json"

WRAP_ARGS=(
  --artifact-kind evolve-receipt
  --payload-file "$PAYLOAD_TMP"
  --output "$OUT_PATH"
)
SESSION_ID=$(grep '^session_id:' "$SESSION_ROOT/session.yaml" | head -1 | sed 's/^session_id:[[:space:]]*//; s/"//g')
[ -n "$SESSION_ID" ] && WRAP_ARGS+=(--session-id "$SESSION_ID")
[ -f "$REC_PATH" ] && WRAP_ARGS+=(--source-recurring-findings "$REC_PATH")

if node "$CLAUDE_PLUGIN_ROOT/hooks/scripts/wrap-evolve-envelope.js" "${WRAP_ARGS[@]}"; then
  rm -f "$PAYLOAD_TMP"
else
  echo "wrap-evolve-envelope failed — preserving $PAYLOAD_TMP for retry; re-run this section to retry." >&2
  exit 1
fi
```

The helper:
- Generates `envelope.run_id` (ULID), sets `producer = "deep-evolve"`,
  `artifact_kind = "evolve-receipt"`, `schema.name = "evolve-receipt"`.
- Sets `envelope.parent_run_id` from the consumed recurring-findings envelope's
  `run_id` (handoff §3.3 cross-plugin chain) when `--source-recurring-findings`
  is passed and the file is itself an envelope (loose+strict gate via
  `isValidEnvelope`).
- Adds `recurring-findings.json` path to `envelope.provenance.source_artifacts[]`
  (with its `run_id` when envelope-wrapped, path-only when legacy).
- **Atomic write**: writes to `<output>.tmp.<pid>.<ts>` then `fs.renameSync` to
  the final path so concurrent finishers / mid-write interruption never leave
  a truncated JSON. (handoff §4 round-1 C1 lesson.)

### Outcome update (post user-selection)

After the user chooses the apply path, update `payload.outcome` **in place**
to preserve the envelope wrapper. **Each apply-path branch below sets its
own `OUTCOME_VALUE`** before invoking this snippet. The snippet is
**self-contained** — it re-resolves `$SESSION_ROOT`-relative paths locally
and asserts `$OUTCOME_VALUE` was set by the caller.

```bash
set -euo pipefail

# Round-2 deep-review R2-3 (Codex adversarial medium): make the snippet
# stateless-safe. Bash-tool invocations don't preserve env vars between
# calls (handoff §4 W2), so re-resolve locally rather than relying on
# variables from earlier blocks in this protocol.
SESSION_ROOT="${SESSION_ROOT:?SESSION_ROOT must be set by caller — derive from session.yaml or env}"
OUT_PATH="$SESSION_ROOT/evolve-receipt.json"
: "${OUTCOME_VALUE:?OUTCOME_VALUE must be set by the apply-path branch (e.g., OUTCOME_VALUE=merged)}"

# Distinct prefix from wrap helper's `<output>.tmp.<pid>.<ts>` so a future
# residue scanner can attribute lingering temps correctly.
TMP_OUT="$OUT_PATH.tmp.outcome.$$.$(date +%s)"
if jq --arg o "$OUTCOME_VALUE" '.payload.outcome = $o' "$OUT_PATH" > "$TMP_OUT"; then
  mv "$TMP_OUT" "$OUT_PATH"
else
  # Round-1 deep-review W2 (Opus): jq failure left $TMP_OUT residue
  # because `&&` short-circuited mv but never unlinked the partial output.
  rm -f "$TMP_OUT"
  echo "outcome update failed; receipt unchanged at $OUT_PATH" >&2
  exit 1
fi
```

> **Why**: the envelope's `run_id` and `generated_at` should NOT change once
> emitted — only the payload mutates. `jq` + atomic rename achieves this
> without re-running the wrap helper. Explicit `rm -f` on jq failure
> prevents `.tmp.outcome.*` residue accumulating across retries. The
> `${VAR:?msg}` guards make the snippet fail-fast when the caller forgot
> to set `OUTCOME_VALUE` (Round-2 R2-3 fix — previously the block opened
> with `set -u` referencing undefined OUT_PATH and OUTCOME_VALUE).

> **Round-2 deep-review R2-2 (Codex adversarial — design-level)**: the wrap
> step above re-detects `.deep-review/recurring-findings.json` at finish
> time. If deep-review regenerates that file mid-session, the chained
> `parent_run_id` reflects the **most-recent upstream state** at finish,
> not necessarily the version Stage 3.5 consumed for harness biasing. This
> matches the suite spec wording (`parent_run_id = recurring-findings.run_id`,
> no temporal binding specified) and is consistent with deep-work's pattern
> for evolve-insights re-detection in `gather-signals.sh`. A consumption-
> bound snapshot (writing the consumed run_id at A.3 Step 4 to a session-
> local file and using that here) would tighten the contract; tracked as
> a follow-up since it requires init.md A.3 restructuring.

## M5.7.B — Loop-epoch-end compaction-state emit (v3.3.0+)

**Always runs** after the evolve-receipt is wrapped (above) and before the
apply-path branch. Emits an envelope-wrapped `compaction-state.json` so the
dashboard's `suite.compaction.frequency` + `suite.compaction.preserved_artifact_ratio`
metrics see this epoch's compaction event. Strategy is `receipt-only` —
the evolve-receipt subsumes intermediate experiment state, intermediate
trace files are discarded.

```bash
set -euo pipefail

# Re-resolve PROJECT_ROOT (handoff §4 W2 — Bash-tool calls are stateless).
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
EVOLVE_RECEIPT="$SESSION_ROOT/evolve-receipt.json"

# Flat-dir layout matches dashboard SOURCE_SPECS (.deep-evolve/compaction-states/*.json).
CS_DIR="$PROJECT_ROOT/.deep-evolve/compaction-states"
mkdir -p "$CS_DIR"
CS_TS="$(date -u +%Y%m%dT%H%M%SZ)"
CS_OUT="$CS_DIR/${CS_TS}-${SESSION_ID:-loop-end}.json"

# Collect discarded epoch trace files (best-effort; missing dirs OK).
DISCARDED=""
for d in "$SESSION_ROOT/code-archive" "$SESSION_ROOT/strategy-archive"; do
  [ -d "$d" ] || continue
  # Comma-separated list of immediate subdirs that hold per-epoch traces.
  for sub in "$d"/*/; do
    [ -d "$sub" ] || continue
    DISCARDED="${DISCARDED:+$DISCARDED,}${sub%/}"
  done
done

CS_ARGS=(
  --trigger loop-epoch-end
  --output "$CS_OUT"
  --preserved "$EVOLVE_RECEIPT"
  --strategy receipt-only
  --source-parent "$EVOLVE_RECEIPT"
)
[ -n "${SESSION_ID:-}" ] && CS_ARGS+=(--session-id "$SESSION_ID")
[ -n "$DISCARDED" ] && CS_ARGS+=(--discarded "$DISCARDED")

if node "$CLAUDE_PLUGIN_ROOT/hooks/scripts/emit-compaction-state.js" "${CS_ARGS[@]}"; then
  echo "✓ compaction-state emitted → $CS_OUT"
else
  echo "⚠️ compaction-state emit failed (non-fatal); receipt already finalized." >&2
fi
```

This emit MUST NOT block the apply path on failure — `compaction-state.json`
is dashboard telemetry, not a control artifact. Treat any non-zero exit as a
loggable warning and continue.

## M5.7.B — Optional reverse-handoff emit (v3.3.0+)

**Triggers** (LLM decides):
- This epoch ended on a **plateau** (`session.yaml.outer_loop.terminated_by == "plateau"`)
  or **budget exhaustion** AND `session.yaml.metric.best` falls short of the
  user-stated target → strongly recommend handing back to deep-work for
  structural refactor.
- Or user opts in via menu (added below the existing AskUserQuestion).

When the reverse-handoff branch fires, build a handoff payload chaining
`parent_run_id` to the upstream **forward handoff** if one exists (so the
dashboard's `suite.handoff.roundtrip_success_rate` reads 1.0), otherwise to
the evolve-receipt itself.

```bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
EVOLVE_RECEIPT="$SESSION_ROOT/evolve-receipt.json"
HANDOFF_DIR="$PROJECT_ROOT/.deep-evolve/handoffs"
mkdir -p "$HANDOFF_DIR"
HANDOFF_TS="$(date -u +%Y%m%dT%H%M%SZ)"
HANDOFF_OUT="$HANDOFF_DIR/${HANDOFF_TS}-${SESSION_ID:-reverse}.json"

# R1 review C1 (THREE-WAY UNANIMOUS — Opus + Codex review + adversarial):
# Find the upstream forward handoff to chain to. Filter strictly: identity-triplet
# (producer=deep-work, artifact_kind=handoff, schema.name=handoff) + to.producer
# = deep-evolve + (when session correlation is available) session_id match.
# Falls back to mtime-newest only within the same identity scope.
#
# R1 review W4 (Opus): reject symlinks to prevent forged handoffs at fixed
# paths (matches dashboard's suite-collector.js out-of-boundary-symlink defense).
#
# Source correlation: prefer session.yaml.transfer.source_id (records the
# upstream handoff's source identifier when init.md adopted it). Fall back to
# session_id matching. If neither correlates, picks mtime-newest within the
# filtered candidates (still envelope-strict).
SOURCE_ID=""
if [ -f "$SESSION_ROOT/session.yaml" ]; then
  # transfer.source_id may live at top-level transfer block in session.yaml
  SOURCE_ID=$(grep -E '^  source_id:' "$SESSION_ROOT/session.yaml" 2>/dev/null \
    | head -1 | sed 's/^  source_id:[[:space:]]*//; s/"//g' || true)
fi

FWD_HANDOFF=""
if [ -d "$PROJECT_ROOT/.deep-work/handoffs" ]; then
  FWD_HANDOFF=$(node -e '
    const fs = require("fs");
    const path = require("path");
    const dir = process.argv[1];
    const sourceId = process.argv[2] || "";
    const sessionId = process.argv[3] || "";
    let names = [];
    try { names = fs.readdirSync(dir).filter(f => f.endsWith(".json")); } catch { process.exit(0); }
    const cands = [];
    for (const f of names) {
      const p = path.join(dir, f);
      // W4: reject symlinks (containment defense — mirrors dashboard collector).
      let lstat;
      try { lstat = fs.lstatSync(p); } catch { continue; }
      if (lstat.isSymbolicLink()) continue;
      if (!lstat.isFile()) continue;
      let obj;
      try { obj = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
      // Identity-triplet check (envelope-strict, mirrors dashboard unwrapStrict).
      if (!obj || obj.schema_version !== "1.0"
          || !obj.envelope || typeof obj.envelope !== "object"
          || obj.envelope.producer !== "deep-work"
          || obj.envelope.artifact_kind !== "handoff"
          || !obj.envelope.schema || obj.envelope.schema.name !== "handoff"
          || !obj.payload || typeof obj.payload !== "object" || Array.isArray(obj.payload)
          || !obj.payload.to || obj.payload.to.producer !== "deep-evolve") {
        continue;
      }
      const mtime = lstat.mtimeMs;
      const runId = obj.envelope.run_id || "";
      const fromSid = (obj.payload.from && obj.payload.from.session_id) || "";
      cands.push({ p, mtime, runId, fromSid });
    }
    if (cands.length === 0) process.exit(0);
    // Tier 1: exact match on transfer.source_id (handoff envelope run_id OR
    // upstream session_id).
    if (sourceId) {
      const m = cands.find(c => c.runId === sourceId || c.fromSid === sourceId);
      if (m) { console.log(m.p); process.exit(0); }
    }
    // Tier 2: exact match on current session_id (if upstream embedded it).
    if (sessionId) {
      const m = cands.find(c => c.fromSid === sessionId);
      if (m) { console.log(m.p); process.exit(0); }
    }
    // Tier 3: mtime-newest within filtered identity scope (last-resort fallback;
    // emits stderr hint so callers know correlation was weak).
    cands.sort((a, b) => b.mtime - a.mtime);
    process.stderr.write(`info: forward-handoff picked by mtime fallback (${cands.length} candidates, no session correlation matched)\n`);
    console.log(cands[0].p);
  ' "$PROJECT_ROOT/.deep-work/handoffs" "$SOURCE_ID" "${SESSION_ID:-}" 2>/dev/null || true)
fi

CHAIN_TARGET="${FWD_HANDOFF:-$EVOLVE_RECEIPT}"

# Build the reverse-handoff payload. SKILL composes this from session.yaml +
# evolve-receipt + meta-analyses.
HANDOFF_PAYLOAD="$SESSION_ROOT/.reverse-handoff.payload.json"
# (the LLM writes the payload JSON to HANDOFF_PAYLOAD per the schema; see
# `claude-deep-suite/schemas/handoff.schema.json`. handoff_kind MUST be
# "evolve-to-deep-work"; from.producer = "deep-evolve"; to.producer = "deep-work".)

H_ARGS=(
  --payload-file "$HANDOFF_PAYLOAD"
  --output "$HANDOFF_OUT"
  --source-parent "$CHAIN_TARGET"
)
[ -n "${SESSION_ID:-}" ] && H_ARGS+=(--session-id "$SESSION_ID")

if node "$CLAUDE_PLUGIN_ROOT/hooks/scripts/emit-handoff.js" "${H_ARGS[@]}"; then
  rm -f "$HANDOFF_PAYLOAD"
  echo "✓ reverse handoff emitted → $HANDOFF_OUT (chains to: $CHAIN_TARGET)"
else
  echo "⚠️ reverse handoff emit failed — payload preserved at $HANDOFF_PAYLOAD" >&2
fi
```

The emit-handoff helper validates the payload against
`HANDOFF_REQUIRED = [schema_version, handoff_kind, from, to, summary, next_action_brief]`
before writing. Missing fields → exit 1 with the field name and the payload
file is preserved for retry. The identity-triplet (`producer = deep-evolve`,
`artifact_kind = handoff`, `schema.name = handoff`, `schema.version = "1.0"`)
is set automatically and satisfies the dashboard's `unwrapStrict`.

**Round-trip closure semantics**: when `FWD_HANDOFF` is found, the dashboard
sees `reverse-handoff.envelope.parent_run_id === forward-handoff.envelope.run_id`
and counts this as a successful round-trip — `suite.handoff.roundtrip_success_rate`
trends toward 1.0. When no forward handoff exists (deep-evolve session started
directly without a deep-work handoff), the chain falls back to the
evolve-receipt; the dashboard sees this as an "orphan" reverse handoff (no
counterpart) and counts it as a failed round-trip in that metric — which is
the correct semantics.

**Completion hooks**:
- `session-helper.sh append_sessions_jsonl finished <id> --status=completed --outcome=<outcome> ...`
- `session-helper.sh append_meta_archive_local <id>`

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

- **deep-review 실행 후 merge**: outcome remains null until deep-review completes; set based on final action taken. → See **Deep-Review Integration** section below; on APPROVE auto-merge.
- **deep-review 실행 후 PR 생성**: outcome remains null until deep-review completes; set based on final action taken. → See **Deep-Review Integration** section below; on APPROVE auto-create PR.
- **main에 merge**: Set `outcome = "merged"` in receipt. `git checkout main && git merge <session.yaml.lineage.current_branch>`
- **PR 생성**: Set `outcome = "pr_created"` in receipt. `git push -u origin <session.yaml.lineage.current_branch> && gh pr create --title "deep-evolve: <goal>" --body "<report summary>"`
- **branch 유지 (나중에 결정)**: Set `outcome = "kept"` in receipt. No action; inform user of branch name (`session.yaml.lineage.current_branch`).
- **폐기 (변경사항 삭제)**: Set `outcome = "discarded"` in receipt. `git checkout main && git branch -D <session.yaml.lineage.current_branch>`

After executing, write the updated `outcome` value back to
`$SESSION_ROOT/evolve-receipt.json` using the **in-place `payload.outcome`
edit** snippet shown above ("Outcome update (post user-selection)") — do NOT
re-run the wrap helper, as that would mint a fresh `envelope.run_id` and break
trace continuity for any consumer that already harvested the original.

## Deep-Review Integration

This section applies only when the user chose **"deep-review 실행 후 merge"** or **"deep-review 실행 후 PR 생성"**.

**Target**: diff of `session.yaml.lineage.current_branch` against its base branch.

**Steps**:
1. Run the deep-review skill on the branch diff:
   - Invoke the deep-review evaluator targeting `lineage.current_branch`
2. Handle the deep-review result:

**APPROVE**:
- If path is `merged`: `git checkout main && git merge <session.yaml.lineage.current_branch>`
- If path is `pr_created`: `git push -u origin <session.yaml.lineage.current_branch> && gh pr create --title "deep-evolve: <goal>" --body "<report summary>"`

**REQUEST_CHANGES**:
- Display the deep-review findings to the user.
- Ask via AskUserQuestion: "deep-review가 변경을 요청했습니다. 어떻게 하시겠습니까?"
  Options:
  - "수정 후 재시도"
  - "그래도 진행 (review 무시)"
  - "branch 유지 (나중에 결정)"
  - "폐기 (변경사항 삭제)"
- Execute accordingly:
  - "수정 후 재시도" 선택 시:
    1. 사용자가 코드를 수정하고 커밋
    2. 다시 deep-review 실행 (동일한 branch diff 대상)
    3. 결과에 따라 다시 APPROVE/REQUEST_CHANGES/FAILURE 처리
  - 그 외 선택지는 original path의 action에 따라 처리 (on "그래도 진행" follow the original path's action).

**FAILURE** (deep-review tool itself fails or errors):
- Inform the user that deep-review encountered an error.
- If original path is `merged`, ask via AskUserQuestion:
  "deep-review 실행에 실패했습니다. 어떻게 하시겠습니까?"
  Options:
  - "그래도 merge 진행"
  - "branch 유지 (나중에 결정)"
  - "중단"
- If original path is `pr_created`, ask via AskUserQuestion:
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
3. Preserve `$SESSION_ROOT/code-archive/` metadata files (useful for analysis).
4. Preserve `$SESSION_ROOT/strategy-archive/` (useful for cross-project transfer).

Run `session-helper.sh mark_session_status <session_id> completed` (updates both session.yaml and sessions.jsonl atomically).
