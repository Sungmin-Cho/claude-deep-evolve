**English** | [한국어](./README.ko.md)

# deep-evolve

Autonomous experimentation plugin for Claude Code. Specify a goal, and deep-evolve systematically improves your project through measured experiment loops.

## Inspiration

This project is inspired by [autoresearch](https://github.com/karpathy/autoresearch) by Andrej Karpathy — an experiment to have AI agents do their own research autonomously. The core idea: give an AI agent a codebase, let it experiment overnight — modifying code, evaluating results, keeping improvements, discarding regressions — and wake up to a better project.

The self-evolutionary architecture (v2.0) is inspired by [HyperAgents](https://arxiv.org/abs/2603.19461) — agents that evolve their own strategies through meta-learning, not just the target code.

deep-evolve generalizes this methodology from ML training to **any software project**, packaging it as a Claude Code plugin with automatic evaluation harness generation, journal-based crash recovery, multi-domain template support, and self-evolutionary strategy evolution.

### Role in Harness Engineering

deep-evolve operates **outside** the standard [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) framework — it is an autonomous experimentation protocol that iteratively improves code through measured experiment loops. While the framework focuses on guiding and sensing during normal development, deep-evolve represents a complementary approach: using automated experimentation to discover improvements that no guide or sensor would suggest. It is part of the [Deep Suite](https://github.com/Sungmin-Cho/claude-deep-suite) ecosystem but follows its own experiment→evaluate→keep/discard cycle.

With v2.0's Outer Loop, deep-evolve goes further: it not only improves the target code but also evolves the **strategy** that drives experiments — and can even expand the **evaluation harness** itself when convergence is detected. This 3-layer self-evolution (parameters → strategy text → evaluation expansion) makes the system a true meta-optimizer that improves its own improvement process.

## Self-Evolutionary Experiment Loop (v2.0)

v2.0 introduces a self-evolutionary architecture where the system not only improves target code but also evolves the **strategy** that drives experiments.

### 2-Tier Architecture: Outer Loop + Inner Loop

```
┌─────────────────────────────────────────────────────────────┐
│  Outer Loop (Strategy Evolution)                            │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  strategy.yaml: evolvable strategy parameters       │    │
│  │  (mutation_rate, idea_bank, focus_areas, ...)       │    │
│  └───────────────────┬─────────────────────────────────┘    │
│                      ▼                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Inner Loop (Experiment Execution)                  │    │
│  │  Run N experiments with current strategy            │    │
│  │  → measure Q(v) meta-metric                         │    │
│  └───────────────────┬─────────────────────────────────┘    │
│                      ▼                                      │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Evaluate & Evolve Strategy                         │    │
│  │  Q(v) = (best_score - baseline) / experiments_used  │    │
│  │  → mutate strategy.yaml for next outer iteration    │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

- **Inner Loop**: The original experiment cycle — modify code, evaluate, keep/discard. Now driven by `strategy.yaml` parameters.
- **Outer Loop**: Evolves the strategy itself. After each inner loop epoch, measures **Q(v)** (improvement velocity) and mutates strategy parameters to find better experimental approaches.

### 3-Layer Self-Evolution

deep-evolve evolves at three layers simultaneously:

| Layer | File | What Evolves | How |
|-------|------|-------------|-----|
| **Parameters** | `strategy.yaml` | Mutation rate, focus areas, idea bank | Outer Loop mutates per epoch |
| **Strategy Text** | `program.md` | Agent instructions, experiment approach | Meta Analysis auto-revises on convergence |
| **Evaluation** | `prepare.py` | Scenarios, difficulty, coverage | Section D auto-triggers on plateau |

### Strategy & Code Archives (Stepping Stones)

Every strategy that achieves a new best Q(v) is archived as a **stepping stone**:

- **Strategy Archive**: Stores `strategy.yaml` snapshots with their Q(v) scores and lineage. New strategies are bred from high-performing parents, not just the latest one.
- **Code Archive**: Named git branches (`archive/<name>`) preserve best-scoring code states. The system can backtrack to any archived state when a new strategy direction fails.
- **Idea Ensemble**: Each experiment selects from multiple candidate ideas, scored and ranked. This avoids single-point-of-failure in idea generation.

### Cross-Project Transfer

Strategies that work well in one project can transfer to others:

- **Meta-archive** (`~/.claude/deep-evolve/meta-archive.jsonl`): A shared, flock-protected archive of proven strategies across all projects.
- When starting a new project, deep-evolve seeds its initial strategy from the meta-archive, filtered by project domain similarity.
- Successful strategies are contributed back to the meta-archive after each session.

### Cross-Plugin Feedback (v2.1)

deep-evolve exchanges bidirectional data with other plugins in the deep-suite ecosystem:

**Producer (exports):**
- `evolve-receipt.json` → collected by deep-dashboard for evolve effectiveness dimension
- `evolve-insights.json` → consumed by deep-work Phase 1 Research as advisory context
- Deep-review trigger before merge/PR (handles APPROVE/REQUEST_CHANGES/FAILURE)

**Consumer (imports):**
- `.deep-review/recurring-findings.json` → read during init Stage 3.5 to steer experiment direction (prepare.py scenarios + program.md + strategy.yaml weight adjustment)

### Session Management (v2.2)

deep-evolve manages sessions in per-session namespaces under `.deep-evolve/<session-id>/`, preserving all experiment data across sessions.

- **Session lifecycle**: `initializing` (baseline 측정/writeback) → `active` (inner loop) → `paused` (outer loop 실행 중) → `active` → `completed` / `aborted` (v2.2.2).
- **Resume**: Stop anytime. Run `/deep-evolve` again — it detects the active session, performs integrity checks (branch alignment, dirty tree, orphan experiments), and picks up where it left off. Outer Loop resume is **idempotent per-phase**: each sub-step is identified by a journal event (`outer_loop`, `strategy_update`, `strategy_judgment`, `notable_marked`, `program_skip`) and is skipped on restart if already completed (v2.2.2).
- **Baseline contract**: Minimize-direction metrics are writebacked during init so that `session.yaml.metric.baseline == 1.0` for every session. All downstream comparisons (`improvement_pct`, Q(v) `normalized_delta`, archive scoring) share a common scale (v2.2.2).
- **History**: View all sessions for the current project with `/deep-evolve history`. See experiment counts, keep rates, Q trajectories, and score improvements at a glance.
- **Session Lineage**: New sessions can continue from a completed session, inheriting its final strategy, program, and notable keeps as starting context. Inherited Context (strategy patterns, notable discoveries, and lessons from the parent session) is automatically injected into the new session's `program.md`. The lineage chain is visible via `/deep-evolve history --lineage`.

## The Methodology

### Three Files That Matter

The autoresearch methodology revolves around a strict separation of concerns:

```
┌─────────────────────────────────────────────────────┐
│  eval harness  — Fixed evaluation infrastructure    │
│                  The ground truth. Never modified    │
│                  by the agent during experiments.    │
│                                                     │
│  Two forms:                                         │
│  • prepare.py          — CLI-based metrics          │
│  • prepare-protocol.md — MCP/tool-based protocol    │
├─────────────────────────────────────────────────────┤
│  target files  — The code being improved            │
│                  Everything is fair game:            │
│                  architecture, parameters, logic,    │
│                  patterns — whatever moves the       │
│                  metric in the right direction.      │
├─────────────────────────────────────────────────────┤
│  program.md    — Instructions for the agent         │
│                  Defines the goal, constraints,      │
│                  and experiment strategy.            │
│                  "Research org code" — humans        │
│                  program the process, not the code.  │
└─────────────────────────────────────────────────────┘
```

### The Experiment Loop

Each experiment follows the same cycle. The agent never asks for permission — it runs autonomously until stopped.

```
    ┌──────────────┐
    │ Select Idea  │ ← Learn from previous keep/discard history
    └──────┬───────┘
           ▼
    ┌──────────────┐
    │ Modify Code  │ ← One idea per commit, target files only
    └──────┬───────┘
           ▼
    ┌──────────────┐
    │   Evaluate   │ ← Run prepare.py, get score
    └──────┬───────┘
           ▼
    ┌──────────────┐
    │   Compare    │ ← Score improved?
    └──┬───────┬───┘
       │       │
     Yes      No
       │       │
       ▼       ▼
    ┌──────┐ ┌──────────┐
    │ Keep │ │ Discard  │ ← git reset --hard HEAD~1
    └──┬───┘ └────┬─────┘
       │          │
       └────┬─────┘
            ▼
    ┌──────────────┐
    │   Repeat     │ ← Until goal met or diminishing returns
    └──────────────┘
```

### One Metric, One Truth

Every experiment is judged by a single composite score. This removes ambiguity:

- **Score improved** → keep the change, no matter how small
- **Score same or worse** → discard, no matter how clever the idea seemed
- **Crashed** → discard, log the failure, move on

The metric can be anything measurable: validation loss, test pass rate, Sharpe ratio, scenario coverage. What matters is that it's **fixed during experiments** — you can't optimize a moving target.

### Simplicity Criterion

All else being equal, simpler is better. A small improvement that adds ugly complexity is not worth it. Conversely, removing code and getting equal or better results is a great outcome — that's a simplification win.

> A 0.001 improvement that adds 20 lines of hacky code? Probably not worth it.
> A 0.001 improvement from deleting code? Definitely keep.
> An improvement of ~0 but much simpler code? Keep.

### Diminishing Returns

Experiments naturally follow a diminishing returns curve:

```
Score
  ▲
  │    ╱──────────────────  ← Plateau (converged)
  │   ╱
  │  ╱    ← Rapid improvement
  │ ╱
  │╱
  └──────────────────────► Experiments
```

deep-evolve detects this automatically. When the last 10 experiments yield no improvements, it asks: continue, expand the evaluation harness with harder scenarios, or stop here?

### Learning From History

The agent reads `results.tsv` before each experiment. It learns what worked and what didn't:

```
commit   score      status    description
abc1234  0.921053   keep      add perl -pi -e file write pattern
def5678  0.921053   discard   narrow node -e safe pattern (insufficient alone)
ghi9012  0.973684   keep      add runtime language file write patterns
```

Discarded approaches are not repeated. The agent evolves its strategy based on accumulated evidence.

## How deep-evolve Works

### 1. Project Analysis

When you run `/deep-evolve`, the plugin performs a deep 5-stage analysis of your project:

1. **Structure Scan** — File tree, language, framework, entry points
2. **Dependency & Tooling** — Package manager, test frameworks, linters, CI/CD
3. **Code Deep Analysis** — Read all target files completely, understand architecture
4. **Metric Validation** — Actually run the evaluation command, parse output, measure timing
5. **Confirmation** — Present findings to user before proceeding

No guessing — every judgment is grounded in actual file reads.

### 2. Evaluation Harness Generation

Based on the analysis, deep-evolve generates an evaluation harness tailored to your project:

**CLI mode** (`prepare.py`):

| Domain Signal | Template | Example |
|---|---|---|
| stdout contains parseable metrics | stdout-parse | ML training (val_bpb), backtesting (Sharpe ratio) |
| Test framework detected | test-runner | jest, pytest, vitest, cargo test, go test |
| Code quality / pattern goals | scenario-based | Plugin hooks, security patterns, lint rules |

**Protocol mode** (`prepare-protocol.md`):

| Domain Signal | Evaluation Tool | Example |
|---|---|---|
| Game engine project | MCP server | Unity replay verification, Unreal automation |
| GUI / desktop app | Browser/app automation | UI state verification, accessibility testing |
| External runtime dependency | MCP/HTTP calls | Data pipelines, hardware testing |

Both modes output the same `score: X.XXXXXX` standardized format, making the experiment loop domain-independent.

### 3. Autonomous Experiment Loop

The loop runs in your current Claude Code session. Each experiment:
- Journals its state atomically (crash-safe recovery)
- Commits on a dedicated branch (main stays clean)
- Verifies branch and worktree safety before every rollback

### 4. Resume Across Sessions

Stop anytime. Come back later and run `/deep-evolve` again — it detects the active session, shows progress, and picks up where it left off. The journal-based state machine ensures no work is lost, even after crashes.

### 5. Completion Report

When done, deep-evolve generates a report with:
- Experiment statistics and score progression
- Diminishing returns curve per evaluation harness version
- Key discoveries ranked by impact
- Lessons from discarded experiments

Then asks: merge to main, create PR, keep branch, or discard?

## Quick Start

```bash
# Start a new session (interactive goal/target selection)
/deep-evolve

# Run 50 experiments
/deep-evolve 50

# Start with a specific goal
/deep-evolve "minimize val_bpb"

# Resume an interrupted session
/deep-evolve resume

# View session history
/deep-evolve history

# View lineage tree
/deep-evolve history --lineage
```

## Supported Domains

### CLI mode (prepare.py)

| Domain | Evaluator | Example Metrics |
|--------|-----------|-----------------|
| ML / Training | stdout metric parsing | val_bpb, loss, accuracy, perplexity |
| Testing | Test pass rate + coverage | jest, pytest, vitest, cargo test, go test |
| Code quality | Custom test scenarios | Security patterns, hook reliability, lint rules |
| Strategy optimization | Backtest results | Sharpe ratio, max drawdown, composite score |

### Protocol mode (prepare-protocol.md)

| Domain | Evaluation Tool | Example Metrics |
|--------|----------------|-----------------|
| Game engines | Unity MCP, Unreal MCP | Replay accuracy, frame time, test pass rate |
| GUI apps | Browser/app automation | UI state match rate, accessibility score |
| External systems | MCP/HTTP calls | API accuracy, pipeline success rate |

Protocol mode evaluates projects that cannot be assessed via CLI by using MCP servers, browser automation, external APIs, etc. The appropriate mode is automatically recommended during project analysis.

## Installation

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and configured

### Via Deep Suite marketplace (recommended)

```bash
# 1. Add the marketplace
/plugin marketplace add Sungmin-Cho/claude-deep-suite

# 2. Install the plugin
/plugin install deep-evolve@Sungmin-Cho-claude-deep-suite
```

### Standalone

```bash
# 1. Add this repo as a marketplace
/plugin marketplace add Sungmin-Cho/claude-deep-evolve

# 2. Install
/plugin install deep-evolve@Sungmin-Cho-claude-deep-evolve
```

## License

MIT
