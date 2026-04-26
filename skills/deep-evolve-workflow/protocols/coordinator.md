# Coordinator Loop (v3.1.0 Only)

> This protocol file is used **only** when `session.yaml.deep_evolve_version`
> is "3.1.x". For v3.0.x and v2.x sessions, coordinator logic is inlined in the
> existing inner-loop.md / outer-loop.md and this file is NOT entered. See
> § 10.1 Version Gate in the v3.1.0 spec.

## Version Gate

> **T37 + T38 (W2 G11 fold-in)**: This file is for v3.1+ sessions only.
> The 4-arm `case "$VERSION" in` pattern below mirrors inner-loop.md /
> outer-loop.md / synthesis.md so all 4 v3.1 protocol files share a single
> VERSION_TIER source-of-truth. Coordinator-specific addition: after computing
> VERSION_TIER, exit unless tier == `v3_1_plus`. Forward-compat: v3.2.x and
> v4.x sessions route through coordinator unchanged. Defense-in-depth:
> v3.0.x / v2.x / pre-v3 sessions are rejected at coordinator-gate level even
> if dispatcher routing breaks (dispatcher should route them through
> inner-loop.md + outer-loop.md directly without invoking coordinator.md).

```bash
VERSION=$(grep '^deep_evolve_version:' "$SESSION_ROOT/session.yaml" | sed 's/.*"\(.*\)".*/\1/')

# Compute VERSION_TIER (4-arm pattern uniform with inner-loop / outer-loop / synthesis)
case "$VERSION" in
  2.*)
    VERSION_TIER="pre_v3"
    ;;
  3.0|3.0.*)
    VERSION_TIER="v3_0"
    ;;
  3.*|4.*)
    VERSION_TIER="v3_1_plus"
    ;;
  *)
    echo "warn: unrecognized VERSION='${VERSION:-<unset>}' — treating as pre_v3" >&2
    VERSION_TIER="pre_v3"
    ;;
esac
export VERSION_TIER

# Coordinator-only gate: tier must be v3_1_plus
if [ "$VERSION_TIER" != "v3_1_plus" ]; then
  echo "error: coordinator.md requires v3.1+ session (VERSION='${VERSION:-<unset>}', VERSION_TIER='$VERSION_TIER')" >&2
  echo "error: dispatcher should route v3.0.x / v2.x sessions through inner-loop.md + outer-loop.md directly" >&2
  exit 1
fi
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
  # G12 final review F2 fix (2026-04-26): scheduler-decide.py emits
  # rc=1 on business rejection (accepted: false) per the rc=0=accepted
  # contract. Capture rc to distinguish:
  #   rc=0  → decision accepted, validated.accepted = true, proceed to case
  #   rc=1  → decision rejected (validated.accepted = false), log + continue
  #   rc=2  → operator error (malformed input), abort coordinator
  validated=$(hooks/scripts/scheduler-decide.py \
    --decision "$decision" \
    --signals "$signals")
  rc=$?
  if [ $rc -eq 1 ]; then
    # Business rejection (e.g., kill_target == chosen_seed_id, allocation
    # below P3 floor). Log and continue to next iteration; AI scheduler
    # will propose a different decision next turn.
    log "scheduler_decision_rejected: $(echo "$validated" | jq -r .reason)"
    continue
  elif [ $rc -ne 0 ]; then
    echo "error: scheduler-decide.py operator error (rc=$rc)" >&2
    exit 1
  fi

  # Defense-in-depth: assert validated.accepted == true before applying.
  # F2 fix: even if scheduler-decide.py somehow emits rc=0 with
  # accepted:false (regression), the case statement should NOT route a
  # rejected decision as executable.
  if [ "$(echo "$validated" | jq -r .accepted)" != "true" ]; then
    log "scheduler_decision_rejected_via_accepted_flag: $(echo "$validated" | jq -r .reason)"
    continue
  fi

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
