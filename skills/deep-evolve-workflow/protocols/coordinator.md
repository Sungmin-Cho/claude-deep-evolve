# Coordinator Loop (v3.1.0 Only)

> This protocol file is used **only** when `session.yaml.deep_evolve_version`
> is "3.1.x". For v3.0.x and v2.x sessions, coordinator logic is inlined in the
> existing inner-loop.md / outer-loop.md and this file is NOT entered. See
> § 10.1 Version Gate in the v3.1.0 spec.

## Version Gate

> **T37 annotation**: This file is v3.1+ only. v3.0.x sessions never
> enter coordinator.md — their inner-loop.md / outer-loop.md handle the
> non-virtual-parallel single-seed flow inline. The strict
> `case "$VERSION" in 3.1.*) ;; *) exit 1 ;; esac` below is intentional;
> see synthesis.md for the W-1 4-arm pattern that does support pre-v3.1
> graceful exit. Coordinator's caller (the dispatcher) routes pre-v3.1
> sessions away from this file before invoking it.

```bash
VERSION=$(grep '^deep_evolve_version:' "$SESSION_ROOT/session.yaml" | sed 's/.*"\(.*\)".*/\1/')
case "$VERSION" in
  3.1.*) ;;
  *)
    echo "coordinator.md entered with non-v3.1 session — this is a bug" >&2
    exit 1
    ;;
esac
```

## Session Setup (once per coordinator start / resume)

Before entering the main loop, resolve and export the helper path so all
subagent dispatches receive a stable absolute path (T15c + C-4 fix):

```bash
# Resolve once; subagents inherit via prompt-passed arg (T13 helper_path)
export DEEP_EVOLVE_HELPER_PATH="$(bash hooks/scripts/session-helper.sh resolve_helper_path)"
[ -x "$DEEP_EVOLVE_HELPER_PATH" ] || { echo "helper not executable" >&2; exit 1; }
```

In plugin-cache install this resolves to
`~/.claude/plugins/cache/deep-evolve/hooks/scripts/session-helper.sh`; in
dev-repo dogfood it resolves to `<repo>/hooks/scripts/session-helper.sh`.

## Main Loop

Coordinator runs in the main Claude Code session. Per-dispatch pseudocode:

```
while session_active:
  # 1. Collect signals
  signals = $(hooks/scripts/scheduler-signals.py \
    --session-yaml "$SESSION_ROOT/session.yaml" \
    --journal "$SESSION_ROOT/journal.jsonl" \
    --forum "$SESSION_ROOT/forum.jsonl")

  # 2. Check for pending kill requests from user
  if kill_requests.jsonl has pending entry:
    AskUserQuestion "Confirm kill seed_k?"
    if confirmed: apply kill (write seed_killed event, rename branch, skip to next iter)

  # 3. Drain kill_queue.jsonl: apply any kills whose target is no longer in-flight
  for each queued kill:
    if target_seed.in_flight_block is False: apply kill

  # 4. Ask AI for decision (Task tool dispatch — NOT a subagent, just an AI query)
  decision = invoke_AI_for_decision(signals, structured_prompt_per_§6.2)

  # 5. Validate + clamp
  validated = $(hooks/scripts/scheduler-decide.py \
    --decision "$decision" \
    --signals "$signals")

  # 6. Apply decision_type
  case validated.decision in
    schedule)          dispatch_seed(validated.chosen_seed_id, validated.block_size) ;;
    kill_then_schedule)
      if validated.kill_deferred:
        append_kill_queue_entry(validated.kill_target, reasoning)
      else:
        apply_kill(validated.kill_target)
      dispatch_seed(validated.chosen_seed_id, validated.block_size) ;;
    grow_then_schedule)
      alloc = $(session-helper.sh compute_grow_allocation $pool $current_N)
      if alloc succeeded:
        create new seed via β growth + session-helper.sh create_seed_worktree
        dispatch_seed(new_seed_id, validated.block_size)
      else:
        # insufficient pool; scheduler must chain kill_then_schedule next turn
        log "grow_rejected_insufficient_pool"
        continue ;;
  esac

  # 7. Post-dispatch: validate worktree (see § Subagent Dispatch below)
  session-helper.sh validate_seed_worktree $chosen_seed_id $pre_dispatch_head

  # 7.5. Scan for stale borrow_planned events (spec § 7.4 P1, T15b wiring)
  scan_result=$(python3 hooks/scripts/borrow-abandoned-scan.py \
    --journal-path "$SESSION_ROOT/journal.jsonl" \
    --current-block-id "$current_block_id" \
    --staleness-blocks 2)
  for event in $(echo "$scan_result" | jq -c '.abandoned_events[]'); do
    bash hooks/scripts/session-helper.sh append_journal_event "$event"
  done

  # 8. Check for termination triggers (§ 8.1)
  if termination_trigger: break

  # 9. At epoch boundary: run Outer Loop Step 6.5.0 (forum summary + convergence detection)
  if epoch_boundary: run_outer_loop_step_6_5_0()

# Session end — invoke synthesis.md protocol
bash skills/deep-evolve-workflow/protocols/synthesis.md
```

## Subagent Dispatch

### Prompt construction (prose-contract, § 4.1)

Every Task tool dispatch must include these mandatory leading lines in the prompt:

```
You are running as seed_<k>. Your first two actions MUST be:
1. `cd <absolute_path_to_seed_k_worktree>`
2. Verify CWD with `pwd`; the output must equal the absolute path above.
Failure to remain in this CWD during your block is a contract violation.
All git commands must target this worktree's branch: evolve/<sid>/seed-<k>.
Session state is at <absolute_path_to_.deep-evolve/<sid>/> — reference via absolute paths only.

Your assignment:
- Run exactly <N_block> experiments (Inner Loop Step 1-6, seed-aware)
- Consult forum via `tail_forum 20` before each Step 1 (Idea Selection)
- On Step 5.f (after any keep), evaluate cross-seed borrow per § 7.3
- Return a summary JSON with experiments executed, commits, final_q
```

### Pre-dispatch bookkeeping

```bash
pre_head=$(git -C "$SESSION_ROOT/worktrees/seed_$k" rev-parse HEAD)
append journal "seed_scheduled" event (per § 6.5)
```

### Dispatch (Claude Code Task tool — see subagent-driven-development skill)

The coordinator uses the `Task` tool invocation (NOT `isolation: "worktree"` —
that primitive creates ephemeral worktrees incompatible with our persistent
per-seed model; see § 4.1 for rationale). The coordinator relies on the prose
contract + post-dispatch validation below.

### Post-dispatch validation

```bash
bash hooks/scripts/session-helper.sh validate_seed_worktree $k $pre_head
if [ $? -ne 0 ]; then
  append journal "worktree_contaminated" event
  set seed.status = "quarantined"
  AskUserQuestion "seed_$k contamination detected; options: (1) investigate (2) restore (3) kill (4) abort session"
fi
```

### Post-dispatch: drain subagent's output

The subagent returns a JSON summary via its final message. Coordinator parses:
- `experiments_executed`: N_block or less (if interrupted)
- `commits`: list of SHAs added to the branch
- `final_q`: current Q value after block
- `forum_events_appended`: count (sanity check vs forum.jsonl tail)

Append `seed_block_completed` event with these fields (§ 9.2 event catalog).

## Error Handling

Per § 6.7 and § 11.1:

| Failure | Response |
|---|---|
| Subagent timeout (Task tool) | Use validate_seed_worktree to find partial progress; re-dispatch remainder |
| Subagent non-zero exit | Journal `seed_block_failed`; crash_give_up counter +1 |
| Worktree contamination | See validation flow above; seed → quarantined |
| API rate limit | Exponential backoff, 3 tries; persistent fail → abort block, user notify |

## Exit Back to Caller

When termination triggers (§ 8.1) or user `--finish`: invoke
`skills/deep-evolve-workflow/protocols/synthesis.md` (Task 25+).
