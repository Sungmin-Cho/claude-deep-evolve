**English** | [한국어](./README.ko.md)

# deep-evolve

Autonomous experimentation plugin for Claude Code. Specify a goal, and deep-evolve systematically improves your project through measured experiment loops.

## Inspiration

This project is inspired by [autoresearch](https://github.com/karpathy/autoresearch) by Andrej Karpathy — an experiment to have AI agents do their own research autonomously. The core idea: give an AI agent a codebase, let it experiment overnight — modifying code, evaluating results, keeping improvements, discarding regressions — and wake up to a better project.

deep-evolve generalizes this methodology from ML training to **any software project**, packaging it as a Claude Code plugin with automatic evaluation harness generation, journal-based crash recovery, and multi-domain template support.

## The Methodology

### Three Files That Matter

The autoresearch methodology revolves around a strict separation of concerns:

```
┌─────────────────────────────────────────────────────┐
│  prepare.py    — Fixed evaluation infrastructure    │
│                  The ground truth. Never modified    │
│                  by the agent during experiments.    │
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

Based on the analysis, deep-evolve generates a `prepare.py` tailored to your project:

| Domain Signal | Template | Example |
|---|---|---|
| stdout contains parseable metrics | stdout-parse | ML training (val_bpb), backtesting (Sharpe ratio) |
| Test framework detected | test-runner | Web apps (jest), libraries (pytest, cargo test) |
| Code quality / pattern goals | scenario-based | Plugin hooks, security patterns, lint rules |

The harness always outputs a standardized format, making the experiment loop domain-independent.

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
```

## Supported Domains

| Domain | Evaluator | Example Metrics |
|--------|-----------|-----------------|
| ML / Training | stdout metric parsing | val_bpb, loss, accuracy, perplexity |
| Testing | Test pass rate + coverage | jest, pytest, vitest, cargo test, go test |
| Code quality | Custom test scenarios | Security patterns, hook reliability, lint rules |
| Strategy optimization | Backtest results | Sharpe ratio, max drawdown, composite score |

## Installation

```bash
git clone https://github.com/Sungmin-Cho/claude-deep-evolve.git ~/.claude/plugins/deep-evolve
ln -s ~/.claude/plugins/deep-evolve ~/.claude/local-marketplace/plugins/deep-evolve
```

Then restart Claude Code or run `/reload-plugins`.

## License

MIT
