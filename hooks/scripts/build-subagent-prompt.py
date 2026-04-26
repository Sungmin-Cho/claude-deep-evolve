#!/usr/bin/env python3
"""Build the prose-contract subagent prompt (spec § 4.1).

Generates the mandatory leading-lines prompt that pins a subagent's CWD to
its seed's worktree, names the target branch and session-state paths, and
lists the per-experiment contract (Step 0.5/1/5.f).

Called by coordinator before every Task tool dispatch. All paths in --args
must be absolute (C-4 fix): coordinator resolves helper_path via
`session-helper.sh resolve_helper_path` (T15c) at session start.
"""
import argparse
import json
import sys


TEMPLATE = """You are running as seed_{seed_id}. Your first two actions MUST be:
1. `cd {worktree_path}`
2. Verify CWD with `pwd`; the output must equal exactly: {worktree_path}
Failure to remain in this CWD during your block is a contract violation that
will be detected by post-dispatch git-state validation.

All git commands must target this worktree's branch: {branch}
Session state is at {session_root} — reference via absolute paths only.

Your assignment: run exactly {n_block} experiments (Inner Loop Step 1-6, seed-aware).

For each experiment:
  - Step 0.5 (new): read your seed's program.md (already in your worktree).
  - Step 1: before idea selection, run `bash {helper_path} tail_forum 20` to see other seeds' recent activity. Avoid ideas that duplicate another seed's recent keep.
  - Step 2-5: standard v3.0 Inner Loop (see skills/deep-evolve-workflow/protocols/inner-loop.md) — commit first, then journal append (git-log-is-truth invariant, § 11.3).
  - Step 5.f (new, keep branch only): if this experiment kept, evaluate whether any other seed's recent non-flagged keep is semantically relevant to your direction. If so, plan a semantic_borrow for the NEXT experiment by writing `borrow_planned` event to journal; execute the re-implementation in the next Step 2.

Use absolute paths to read/write session state:
  - journal: {session_root}/journal.jsonl
  - forum: {session_root}/forum.jsonl
  - session.yaml: {session_root}/session.yaml

When the block is complete, return a JSON summary on your FINAL message:
```
{{"experiments_executed": <int>, "commits": ["<sha>", ...],
  "final_q": <float>, "forum_events_appended": <int>,
  "borrows_planned": <int>, "borrows_executed": <int>,
  "status": "completed" | "interrupted" | "failed", "notes": "..."}}
```
"""

REQUIRED_ARGS = {"seed_id", "worktree_path", "session_root", "branch",
                 "n_block", "helper_path"}
ABSOLUTE_PATH_ARGS = ("worktree_path", "session_root", "helper_path")


def _die(msg, rc=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--args", required=True,
                    help="JSON {seed_id, worktree_path, session_root, branch, "
                         "n_block, helper_path}. All *_path args must be absolute.")
    args = ap.parse_args()

    try:
        a = json.loads(args.args)
    except json.JSONDecodeError as e:
        _die(f"--args is not valid JSON: {e}")

    if not isinstance(a, dict):
        _die("--args must be a JSON object")

    missing = REQUIRED_ARGS - set(a.keys())
    if missing:
        _die(f"missing required args: {sorted(missing)}")

    # All paths must be absolute so the subagent can reach them from any CWD
    for key in ABSOLUTE_PATH_ARGS:
        val = a[key]
        if not isinstance(val, str) or not val.startswith("/"):
            _die(f"{key} must be absolute path, got: {val!r}")

    prompt = TEMPLATE.format(
        seed_id=a["seed_id"],
        worktree_path=a["worktree_path"],
        session_root=a["session_root"],
        helper_path=a["helper_path"],
        branch=a["branch"],
        n_block=a["n_block"],
    )
    print(prompt)


if __name__ == "__main__":
    main()
