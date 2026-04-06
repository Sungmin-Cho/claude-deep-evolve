# deep-evolve

Autonomous experimentation plugin for Claude Code. Specify a goal, and deep-evolve systematically improves your project through measured experiment loops.

## How it works

1. `/deep-evolve` — Analyzes your project, generates an evaluation harness
2. Runs experiment loops: modify code → evaluate → keep improvements, discard regressions
3. Reports results with diminishing returns analysis

## Quick start

```bash
# In Claude Code, just run:
/deep-evolve

# Or with specific count:
/deep-evolve 50
```

## Methodology

Validated across three domains:
- **ML training**: val_bpb optimization (100+ experiments)
- **Quantitative trading**: Composite score optimization (+12.3% over 100 experiments)
- **Plugin engineering**: 10 bugs found and fixed (60 experiments, 146 test scenarios)

## Supported domains

| Domain | Evaluator | Example |
|--------|-----------|---------|
| ML / Training | stdout metric parsing | val_bpb, loss, accuracy |
| Testing | Test pass rate + coverage | jest, pytest, cargo test |
| Code quality | Custom scenarios | Security patterns, lint rules |
| Strategy | Backtest results | Sharpe ratio, max drawdown |

## Installation

```bash
claude plugin add /path/to/deep-evolve
```

## License

MIT
