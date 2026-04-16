# History Protocol (v2.2.0)

Displays session history for the current project.

## Step 0 — Parse args

Arguments from dispatcher (HISTORY_ARGS):
- no args / "list" → MODE=list
- `<session-id>` → MODE=detail, TARGET=<id>
- `--lineage` → MODE=list, LINEAGE_VIEW=true
- `--export=md` or `--export=json` → MODE=list, EXPORT=<fmt>

## Step 1 — Load data

Primary source: `sessions.jsonl` (via `session-helper.sh list_sessions`)
- Includes active/paused sessions (X10)

For detail mode: also read `$EVOLVE_DIR/<TARGET>/evolve-receipt.json`
- Check `receipt_schema_version` (X14): if unknown version, warn and proceed best-effort

## Step 2 — Render

### MODE=list

```
deep-evolve Session History (this project)

┌────┬────────────────────────┬────────────┬────────┬───────┬─────────┬──────────┬──────────┐
│ #  │ Session / Goal         │ Date       │ Exps   │ Keep  │ Q Δ     │ Score Δ% │ Outcome  │
├────┼────────────────────────┼────────────┼────────┼───────┼─────────┼──────────┼──────────┤
│ 1  │ <session> [⚠]          │ <date>     │ N/?    │ N%    │ <val>   │ <val>%   │ <status> │
└────┴────────────────────────┴────────────┴────────┴───────┴─────────┴──────────┴──────────┘
```

⚠ = runtime_warnings가 있는 세션

If LINEAGE_VIEW:
  Run `session-helper.sh lineage_tree` → append lineage chain

Aggregate (완료 세션 기준):
  총 세션, 누적 실험, 평균 keep rate, Q 개선 추이

### MODE=detail

Read receipt. Display sections:
- Header (goal, dates, outcome)
- Experiments table (top-10 + bottom-5 by default; `--full` for all)
- Generation snapshots (each with Q, trigger, summary)
- Notable keeps
- Runtime warnings (if any)
- Parent session info

### EXPORT

- `--export=md`: Write history table + aggregate to `$EVOLVE_DIR/history-<ISO>.md`
- `--export=json`: Write sessions array + receipts to `$EVOLVE_DIR/history-<ISO>.json`
