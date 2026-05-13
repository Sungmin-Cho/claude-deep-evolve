# deep-evolve — Project Guide for Claude

Autonomous Experimentation Protocol — goal-driven experiment loops that systematically improve any project through measured code modifications. Supports multi-seed virtual parallel exploration (N=1–9), self-evolving strategy (`outer-loop`), and meta-archive transfer across projects.

For detailed version history see [`CHANGELOG.md`](CHANGELOG.md) / [`CHANGELOG.ko.md`](CHANGELOG.ko.md). This file is intentionally short — it holds the overview, structure, and drift-resistant conventions only.

To check the current version: `jq -r .version .claude-plugin/plugin.json`

---

## Project Overview

**deep-evolve** is a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that runs autonomous experiment loops against a measured fitness metric. Each iteration commits a code modification, evaluates it, and either keeps or rolls back based on a baseline. The strategy itself evolves over time (`outer-loop`) and can be transferred across projects via a shared meta-archive.

**Architectural pillars:**
1. **Inner loop (AAR-style)** — single-seed iterate-evaluate-decide loop with entropy tracking, legibility gate, shortcut detection, and diagnose-retry
2. **Outer loop** — every N=20 inner generations, mutate `strategy.yaml` and (when convergence is detected) auto-expand `prepare.py` evaluation harness
3. **Multi-seed virtual parallel exploration** (v3.1+) — N=1–9 independent seed worktrees coordinated by an adaptive scheduler, with cross-seed idea borrows over a shared `forum.jsonl`, session-end synthesis cascade
4. **Meta-archive transfer** — winning strategies + lineage are recorded to `~/.claude/deep-evolve/meta-archive.jsonl` and looked up on init for projects in similar domains

**Marketplace presence**: One of six plugins in the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite) marketplace.

---

## 🚨 CRITICAL — Plugin Update Workflow

**Every deep-evolve release must be accompanied by the following work. No exceptions.**

### 1. Sync the deep-suite marketplace (required)

Update the following files in `/Users/sungmin/Dev/claude-plugins/deep-suite/`:

- **`.claude-plugin/marketplace.json`** — under the `deep-evolve` entry: `sha` = full 40-character merge commit hash on the new `main`; description = one-line headline summary.
- **`README.md`** / **`README.ko.md`** — the `deep-evolve` row in the Plugins table and any narrative sections that reference the version.
- **`guides/integrated-workflow-guide*.md`** — version-tagged guidance, if any.

After editing:
```bash
cd /Users/sungmin/Dev/claude-plugins/deep-suite
git add .claude-plugin/marketplace.json README.md README.ko.md
git commit -m "chore: bump deep-evolve to vX.Y.Z — <one-line summary>"
git push
```

### 2. Update deep-evolve CHANGELOG (both languages, required)

- Add a new version entry to both `CHANGELOG.md` and `CHANGELOG.ko.md`
- Bump the version in `.claude-plugin/plugin.json` and `package.json`
- Bump `session-helper.sh` `HELPER_VERSION` constant if any session-state schema changes

**Do NOT inline release notes in this CLAUDE.md** — CHANGELOG is the single source of truth.

---

## Directory Structure

```
deep-evolve/
├── .claude-plugin/plugin.json     # plugin manifest
├── package.json                    # npm manifest (Node 18+, node:test runner)
├── pyproject.toml                  # pytest config + Python deps
├── commands/
│   └── deep-evolve.md             # entry point — Step 0 arg parse, Step 1 state routing
├── skills/
│   └── deep-evolve-workflow/
│       ├── SKILL.md               # routing table + state machine + CLI flag matrix
│       └── protocols/             # 11 state-driven subflows
│           ├── init.md            # A.1–A.3: project analysis → init UI → goal/target → baseline → harness gen
│           ├── coordinator.md     # multi-seed dispatch + scheduler-decide + cross-seed forum + synthesis
│           ├── inner-loop.md      # single-seed AAR Inner Loop (Steps 1–6 + resume + prepare expansion)
│           ├── outer-loop.md      # strategy evolution per Q(v) metric + prepare.py auto-expansion
│           ├── synthesis.md       # session-end cascade fallback baseline select
│           ├── resume.md          # journal-event idempotent reconciliation
│           ├── completion.md      # final report + evolve-receipt envelope emit + meta-archive update
│           ├── history.md         # session list, lineage tree, stats
│           ├── archive.md         # code archive backtrack + strategy archive save/restore
│           ├── transfer.md        # meta-archive lookup / record / prune
│           └── taxonomy.md        # shared constants (status enum, journal event types)
├── hooks/
│   ├── hooks.json                 # PreToolUse guard config (protect-readonly, 5s timeout)
│   └── scripts/
│       ├── session-helper.sh      # session CRUD, ULID gen, journal atomic writes, flock coordination
│       ├── protect-readonly.sh    # PreToolUse hook — guards prepare.py / program.md / strategy.yaml
│       ├── envelope.js            # M3 envelope schema + atomic write helpers
│       ├── emit-handoff.js        # reverse-handoff envelope (cross-plugin synthesis)
│       ├── emit-compaction-state.js  # loop-epoch-end compaction state for M4 telemetry
│       ├── wrap-evolve-envelope.js   # wraps evolve-receipt + evolve-insights in M3 envelope
│       ├── validate-envelope-emit.js # schema validator (zero-dep)
│       ├── scheduler-decide.py    # returns schedule / kill_then_schedule / grow_then_schedule per seed
│       ├── scheduler-signals.py   # computes Q, in_flight_block, borrows_received, last_keep_age
│       ├── baseline-select.py    # cascade fallback (preferred → non-quarantine → best-effort → no-baseline)
│       ├── borrow-preflight.py    # cross-seed idea borrow preflight (P2 filter, P3 floor, dedup)
│       ├── borrow-abandoned-scan.py  # janitor for stale borrow_planned events
│       ├── kill-conditions.py     # computes when a seed should be retired
│       ├── status-dashboard.py    # renders per-seed dashboard (--status subcommand)
│       ├── convergence-detect.py  # detects prepare.py expansion trigger
│       └── tests/                 # pytest suite (~550 cases)
├── templates/
│   ├── prepare-stdout-parse.py    # metric stdout parsing, minimize→inverted via baseline writeback
│   ├── prepare-test-runner.py     # test coverage + pass-rate scoring template
│   ├── prepare-scenario.py        # scenario-based scoring template (security, linting)
│   └── prepare-protocol.md        # MCP/HTTP-based evaluation protocol skeleton
├── tests/                          # node:test suite
│   ├── envelope-{emit,chain}.test.js
│   ├── handoff-roundtrip.test.js
│   ├── protect-readonly-golden.test.js
│   └── session-recovery.test.js
├── CHANGELOG.md / CHANGELOG.ko.md
├── README.md / README.ko.md
└── docs/                           # author-local (gitignored)
```

---

## Key Concepts

### Session state machine

Status transitions: `initializing` → `active` → `paused` (outer loop) → `active` | `completed` | `aborted`.

`commands/deep-evolve.md` Step 1 reads the current session's `status` and dispatches to the appropriate protocol under `skills/deep-evolve-workflow/protocols/`.

### `session.yaml` — session configuration

```yaml
session_id: <ULID>
status: initializing | active | paused | completed | aborted
created_at: <RFC 3339>
deep_evolve_version: <SemVer>
eval_mode: cli | protocol
metric: { name, direction: minimize|maximize, baseline: 1.0, current, best }
experiments: { total, kept, discarded, crashed, requested }
strategy: { generation, parent_lineage_id, mutation_rate }
program: { version, history }
outer_loop: { generation, interval: 20, auto_trigger, q_history }
evaluation_epoch: { current, history }
lineage: { current_branch, forked_from, previous_branches }
cross_plugin: { parent_run_id }            # set from consumed deep-review run_id
virtual_parallel:                          # v3.1+ schema_v4
  n_seeds: <1..9>
  seeds: [ { seed_id, seed_origin: β|γ, status, best_score, experiments_used } ]
  forum_path: <.deep-evolve/<sid>/forum.jsonl>
  scheduler_signals: { ... }
```

**Invariant**: `metric.baseline` is always `1.0` after `init.md` Step 11. Minimize metrics are inverted in the harness via baseline writeback, so downstream math (Q(v), archive scoring) always treats higher-is-better. **Never** invert post-baseline (e.g., `score = 1.0 / raw_score`) — this breaks when raw_score < 1.0.

### `journal.jsonl` — append-only event log

ULID `run_id` + RFC 3339 `generated_at` per M3 envelope. 25 event types including `planned`, `committed`, `evaluated`, `kept`, `discarded`, `outer_loop`, `strategy_update`, `seed_created`, `seed_killed`, `borrow_planned`, `cross_seed_borrow`, `scheduler_turn`, etc.

**Resume idempotency** — outer-loop sub-steps (outer_loop, strategy_update, strategy_judgment, notable_marked, program_skip) are skipped on resume if the corresponding journal event already exists. `session-helper.sh::atomicJsonlAppend()` must use `flock` throughout; any busy-loop fallback voids the idempotency guarantee.

**Per-seed injection** (v3.1+) — journal events gain a `seed_id` field for per-seed experiment tracking.

### M3 envelope contract (v3.2.0+)

```json
{
  "schema_version": "1.0",
  "envelope": {
    "producer": "deep-evolve",
    "producer_version": "<from .claude-plugin/plugin.json>",
    "artifact_kind": "evolve-receipt | evolve-insights | evolve-handoff | compaction-state",
    "run_id": "<ULID>",
    "generated_at": "<RFC 3339>",
    "git": { "head": "<sha>", "branch": "<name>", "dirty": <bool> },
    "provenance": { "source_artifacts": [...], "tool_versions": {...} },
    "parent_run_id": "<deep-review run_id>" | null
  },
  "payload": { /* artifact-specific body */ }
}
```

- **`evolve-receipt`** — single per-session completion (experiments, score_delta, kept_count, Q_trajectory)
- **`evolve-insights`** — multi-source aggregator (notable_keeps, lessons, archive_recommendations)
- **`evolve-handoff`** (v3.3.0+) — reverse synthesis output (merged_branch, fallback_reasoning)
- **`compaction-state`** (v3.3.0+) — loop-epoch snapshot for M4 telemetry

All writers use atomic temp + rename (no truncation mid-write).

### Cross-seed coordination (v3.1+)

- **β directions**: init-time AI-generated ambiguous seed directions (`seed_origin: β`)
- **γ directions**: mid-session AI replacement via `grow_then_schedule` decision (`seed_origin: γ`)
- **Borrow lifecycle**: `borrow_planned` (journal, intent) → `cross_seed_borrow` (forum, executed) | `borrow_abandoned` (janitor cleanup). Crashes / discards before commit leave orphan `borrow_planned` events that `borrow-abandoned-scan.py` cleans up.
- **Fairness signals**: per-seed Q, in_flight_block, borrows_received (MIN-wins), last_keep_age feed `scheduler-decide.py`
- **Cascade fallback**: preferred-baseline (5.a) → non-quarantine (5.b) → best-effort (5.c) → no-baseline (5.d)

### Meta-archive (`~/.claude/deep-evolve/meta-archive.jsonl`)

Shared across projects, flock-protected. Each line: `{ session_id, project_domain, strategy_yaml_content, Q_score, lineage, timestamp }`. Looked up at init (A.2.5) by domain similarity; updated on completion (E.0); pruned after 270 days (Section F).

### Protect-readonly hook

`hooks/scripts/protect-readonly.sh` is a `PreToolUse` guard that denies `Write`/`Edit`/`Bash` against `prepare.py`, `program.md`, `strategy.yaml` unless `DEEP_EVOLVE_META_MODE` is set or session `status === initializing`.

**Important**: the hook only guards direct Claude tool use. Subagent helper scripts that modify these files via `Bash` must `export DEEP_EVOLVE_META_MODE=...` before shelling out — otherwise writes succeed silently and Section B (Resume) reconciliation has to recover.

**Shortcut detection** (v3.0+): `strategy.yaml.shortcut_detection.seal_prepare_read: true` activates `DEEP_EVOLVE_SEAL_PREPARE=1`, which makes `protect-readonly.sh` also block reads (`cat`, `less`, `tee`, `perl`) of `prepare.py` / `prepare-protocol.md` during the inner loop.

---

## Workflows & Conventions

### Bash 3.2 portability (required)

macOS ships `/bin/bash` at 3.2.57. Avoid `declare -A`, `mapfile`, `readarray`, `${var,,}`/`${var^^}`, `&>/dev/null` (use `>/dev/null 2>&1`), `globstar`, and some ERE features inside `[[ =~ ]]`. Use newline-delimited strings + `grep -Fxq` or TSV temp files as fallback.

`session-helper.sh` uses `set -Eeuo pipefail` and provides a `compute_slug()` fallback for Unicode-only input (SHA hash).

### UTC ISO 8601 timestamps (required)

All journal lines, envelope `generated_at`, and `session.yaml` timestamps use `YYYY-MM-DDTHH:MM:SSZ` (Z suffix, zero-padded, no fractional seconds). `date -u +"%Y-%m-%dT%H:%M:%SZ"`, with `gdate -u` fallback via the `iso_now()` helper. Lexicographic comparison must match chronological order — no local timezone offsets.

### Atomic operations

- **Session lock**: `mkdir $PROJECT_ROOT/.deep-evolve/.session-lock` is the atomic primitive; cleanup trap checks PID ownership before release.
- **JSON writes**: temp → rename (no truncation on interrupt). Envelope helpers and `emit-handoff.js` enforce this.
- **`flock` fallback**: `FLOCK_AVAILABLE=1` triggers `flock(1)` usage; absent systems fall back to a busy-loop (loses idempotency — note in CHANGELOG when targeting such systems).

### Argument parsing safety

`commands/deep-evolve.md` Step 0 / Step 0.5 uses `case " $ARGS_LINE "` with surrounding spaces (no regex) for word-boundary matching (C2 fix). New flags must follow this pattern.

---

## Slash commands

| Command | Description |
|---|---|
| `/deep-evolve` | Start a new session or resume the active one |
| `/deep-evolve <N>` | Request `N` experiments in this batch |
| `/deep-evolve "<goal>"` | New session with an explicit goal |
| `/deep-evolve resume` | Explicit resume (first-token match) |
| `/deep-evolve history` | List all sessions + stats |
| `/deep-evolve history <session-id>` | Detailed session view |
| `/deep-evolve history --lineage` | Lineage tree (parent → child) |
| `/deep-evolve --no-parallel` | Force single-seed (disable v3.1 N-seed) |
| `/deep-evolve --n-min=<1..9>` | Lower bound on AI-chosen N |
| `/deep-evolve --n-max=<1..9>` | Upper bound on AI-chosen N |
| `/deep-evolve --kill-seed=<id>` | Queue a seed retirement (mid-session) |
| `/deep-evolve --status` | Read-only per-seed dashboard |
| `/deep-evolve --archive-prune` | Prune meta-archive (> 270 days) |

---

## Tests

```bash
npm test
# → node --test on tests/*.test.js (129 node:test cases)

pytest hooks/scripts/tests/ -q
# → ~550 pytest cases (session-helper contracts, v3.1 scheduler, manifest drift,
#   protect-readonly matrix, fallback note logic)
```

CI matrix: `ubuntu-latest` + `macos-latest` — both must pass `npm test` and `pytest`.

---

## Quick references

| Question | Answer |
|---|---|
| New session blocked by stale lock? | Check `$PROJECT_ROOT/.deep-evolve/.session-lock`; trap PID owner mismatch → manual `rm -rf` if process is dead |
| `protect-readonly` blocking helper script? | Helper must `export DEEP_EVOLVE_META_MODE=outer-loop` (or appropriate phase) before shelling out |
| Need to inspect a seed mid-run? | `/deep-evolve --status` (read-only; no state mutation) |
| Score going negative or absurd? | Check `metric.baseline === 1.0` and that the harness inverts minimize at baseline writeback time, NOT post-baseline |
| Cross-plugin chain broken? | Verify `envelope.parent_run_id` is set from the consumed deep-review run_id at init time |

---

## Related repositories

- **deep-suite (marketplace)**: https://github.com/Sungmin-Cho/claude-deep-suite — `/Users/sungmin/Dev/claude-plugins/deep-suite`
- **deep-work**: https://github.com/Sungmin-Cho/claude-deep-work
- **deep-wiki**: https://github.com/Sungmin-Cho/claude-deep-wiki
- **deep-review**: https://github.com/Sungmin-Cho/claude-deep-review
- **deep-docs**: https://github.com/Sungmin-Cho/claude-deep-docs
- **deep-dashboard**: https://github.com/Sungmin-Cho/claude-deep-dashboard

---

**🔁 Reminder**: This CLAUDE.md is intentionally kept short. For every new release:

1. **Write the details in CHANGELOG** (not here — prevents drift)
2. **Only sync the schema sections** (session.yaml, journal events, envelope contract, protect-readonly invariants) if the schema itself changed
3. **Sync the deep-suite marketplace** (see the "CRITICAL" section above)
