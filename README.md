**English** | [한국어](./README.ko.md)

# deep-evolve

> Autonomous experimentation plugin for Claude Code and Codex — specify a goal, and deep-evolve systematically improves your project through measured experiment loops.

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/claude-deep-evolve?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/claude-deep-evolve)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/claude-deep-suite)

deep-evolve gives an AI agent a codebase and a fitness metric, then lets it experiment autonomously — modifying code, evaluating results, keeping improvements, and discarding regressions — until the goal is met or returns diminish. It generates an evaluation harness tailored to your project, runs a crash-safe journal-based experiment loop on a dedicated branch, and can evolve the experiment **strategy** itself over time.

## Role in deep-suite

deep-evolve is the autonomous-experimentation member of the [claude-deep-suite](https://github.com/Sungmin-Cho/claude-deep-suite). It operates **outside** the standard [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) feedforward/feedback loop: rather than guiding and sensing during normal development, it uses automated experimentation to discover improvements no guide or sensor would suggest, following its own experiment → evaluate → keep/discard cycle. It consumes deep-review's recurring findings to steer experiments and emits receipts/insights consumed by deep-dashboard and deep-work.

## Inspiration

deep-evolve is inspired by [autoresearch](https://github.com/karpathy/autoresearch) by Andrej Karpathy — an experiment in having AI agents do their own research autonomously: give an agent a codebase, let it experiment overnight, and wake up to a better project. Its self-evolutionary architecture draws on [HyperAgents](https://arxiv.org/abs/2603.19461) — agents that evolve their own strategies through meta-learning, not just the target code. The behavioral layers (entropy tracking, legibility gate, shortcut detection, diagnose-and-retry) draw on Wen et al. 2026, "Automated Weak-to-Strong Researcher". deep-evolve generalizes this methodology from ML training to **any software project**.

## Install

### Via the Deep Suite marketplace (recommended)

```bash
# Claude Code
/plugin marketplace add Sungmin-Cho/claude-deep-suite
/plugin install deep-evolve@claude-deep-suite

# Codex
codex plugin install deep-evolve
```

### Standalone

```bash
/plugin marketplace add Sungmin-Cho/claude-deep-evolve
/plugin install deep-evolve@Sungmin-Cho-claude-deep-evolve
```

The repository ships both a Claude Code manifest (`.claude-plugin/plugin.json`) and a Codex-native manifest (`.codex-plugin/plugin.json`); see [`AGENTS.md`](AGENTS.md) for the Codex project guide. Claude Code requires the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code).

## Quick start

```bash
# Start a new session (interactive goal/target selection)
/deep-evolve

# Run N experiments in this batch
/deep-evolve 50

# Start with a specific goal
/deep-evolve "minimize val_bpb"

# Resume an interrupted session
/deep-evolve resume

# View session history / lineage tree
/deep-evolve history
/deep-evolve history --lineage

# Virtual parallel exploration
/deep-evolve --no-parallel               # force single-seed (N=1)
/deep-evolve --n-min=2 --n-max=5         # narrow the AI's N decision range
/deep-evolve --kill-seed=<seed_id>       # retire a seed mid-session
/deep-evolve --status                    # per-seed dashboard (read-only)
```

Codex invokes the same public workflow as `$deep-evolve:deep-evolve` with the
same argument string, for example `$deep-evolve:deep-evolve resume`. Claude Code
continues to use the slash forms above.

## The methodology

### Three files that matter

The methodology revolves around a strict separation of concerns:

- **Evaluation harness** — the fixed ground truth. Never modified by the agent during experiments. Two forms: the evaluator file `prepare.cjs` plus validated config (CLI metrics), or `prepare-protocol.md` (fixed tool protocol).
- **Target files** — the code being improved. Everything is fair game: architecture, parameters, logic, patterns — whatever moves the metric in the right direction.
- **`program.md`** — instructions for the agent: the goal, constraints, and experiment strategy. Humans program the process, not the code.

### The experiment loop

Each experiment follows the same cycle, autonomously until stopped: select an idea (learning from prior keep/discard history) → modify code (one idea per commit, target files only) → evaluate (run the harness, get a score) → compare → **keep** if the score improved, otherwise **discard** (`git reset --hard HEAD~1`). Repeat until the goal is met or returns diminish.

### One metric, one truth

Every experiment is judged by a single composite score, which removes ambiguity:

- **Score improved** → keep, no matter how small.
- **Score same or worse** → discard, no matter how clever the idea seemed.
- **Crashed** → discard, log the failure, move on.

The metric can be anything measurable — validation loss, test pass rate, Sharpe ratio, scenario coverage — as long as it's **fixed during experiments**. You can't optimize a moving target.

### Simplicity criterion

All else equal, simpler is better. A small improvement that adds ugly complexity is not worth it; removing code for equal-or-better results is a win.

> A 0.001 improvement that adds 20 lines of hacky code? Probably not worth it.
> A 0.001 improvement from deleting code? Definitely keep.
> An improvement of ~0 but much simpler code? Keep.

### Diminishing returns

Experiments follow a diminishing-returns curve. deep-evolve detects this automatically: when the last 10 experiments yield no improvement, it asks whether to continue, expand the evaluation harness with harder scenarios, or stop.

### Self-evolution

deep-evolve doesn't just improve the target code — it evolves the process that improves it, at three layers:

| Layer | File | What evolves | How |
|---|---|---|---|
| Parameters | `strategy.yaml` | mutation rate, focus areas, idea bank | Outer Loop mutates per epoch |
| Strategy text | `program.md` | agent instructions, experiment approach | auto-revised on convergence |
| Evaluation | `prepare.cjs` + config | scenarios, difficulty, coverage | auto-triggered on plateau |

An **Inner Loop** runs experiments under the current `strategy.yaml`; an **Outer Loop** measures improvement velocity Q(v) after each epoch and mutates the strategy. Winning strategies are archived as stepping stones and code states as named git branches, and proven strategies transfer through the runtime-owned atomic meta-archive.

### Virtual parallel exploration

A session can run N=1–9 independent seed worktrees in parallel, coordinated by an adaptive scheduler. Seeds observe each other through a shared forum and borrow promising ideas; at session end, a synthesis step merges the per-seed results into a single best branch with cascade-fallback baseline selection.

## How deep-evolve works

1. **Project analysis** — a 5-stage deep analysis (structure scan, dependency/tooling, code deep-read, metric validation by actually running the eval command, then confirmation). Every judgment is grounded in real file reads.
2. **Evaluation harness generation** — deep-evolve generates a harness tailored to your project in either CLI or protocol mode. Both output the same `score: X.XXXXXX` format, making the loop domain-independent.
3. **Autonomous experiment loop** — runs in your current session, journaling state atomically (crash-safe), committing on a dedicated branch, and verifying branch/worktree safety before every rollback.
4. **Resume across sessions** — stop anytime; run `/deep-evolve` again and it detects the active session, runs integrity checks, and picks up where it left off.
5. **Completion report** — experiment statistics, score progression, key discoveries, and lessons from discarded experiments, then a prompt to merge to main, create a PR, keep the branch, or discard.

## Supported domains

**CLI mode (`prepare.cjs` plus validated config):**

| Domain | Evaluator | Example metrics |
|---|---|---|
| ML / training | stdout metric parsing | val_bpb, loss, accuracy, perplexity |
| Testing | test pass rate + coverage | jest, pytest, vitest, cargo test, go test |
| Code quality | custom test scenarios | security patterns, hook reliability, lint rules |
| Strategy optimization | backtest results | Sharpe ratio, max drawdown, composite score |

**Protocol mode (`prepare-protocol.md`):**

| Domain | Evaluation tool | Example metrics |
|---|---|---|
| Game engines | Unity / Unreal MCP | replay accuracy, frame time, test pass rate |
| GUI apps | browser/app automation | UI state match rate, accessibility score |
| External systems | MCP/HTTP calls | API accuracy, pipeline success rate |

Protocol mode evaluates projects that cannot be assessed via CLI (game engines, GUI apps, external runtime dependencies). The appropriate mode is recommended automatically during project analysis.

## Links

- [Changelog](CHANGELOG.md) ([한국어](CHANGELOG.ko.md)) — release history
- [Deep Suite marketplace](https://github.com/Sungmin-Cho/claude-deep-suite)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md)

## License

[MIT](LICENSE)
