#!/usr/bin/env python3
"""Write per-seed program.md = [β prefix] + base program.md (spec § 5.1 Step 5).

For N>=2 seeds, each seed's worktree gets a program.md prefixed with its
β direction ('intentionally ambiguous' per AAR methodology) followed by
the original base program.md content.

For N=1 (short-circuit per § 5.1a), caller passes --beta "null" and the
worktree's program.md is a verbatim copy of base.
"""
import argparse
import json
import sys
from pathlib import Path


REQUIRED_BETA_FIELDS = ("seed_id", "direction", "hypothesis", "rationale")


def _die(msg, rc=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


def build_prefix(beta):
    """Render the β-direction prefix markdown block."""
    missing = [f for f in REQUIRED_BETA_FIELDS if f not in beta]
    if missing:
        _die(f"--beta missing required fields: {missing}")
    return (
        f"## Initial Research Direction (seed-specific)\n"
        f"\n"
        f"**Seed ID**: {beta['seed_id']}\n"
        f"**Direction**: {beta['direction']}\n"
        f"**Hypothesis**: {beta['hypothesis']}\n"
        f"**Rationale**: {beta['rationale']}\n"
        f"\n"
        f"This direction is 'intentionally ambiguous' (AAR methodology):\n"
        f"use it to bias exploration, not as a rigid constraint. Other seeds\n"
        f"explore different directions in parallel; see forum.jsonl for cross-seed context.\n"
        f"\n"
        f"---\n"
        f"\n"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-program", required=True, type=Path,
                    help="Path to the base program.md")
    ap.add_argument("--worktree", required=True, type=Path,
                    help="Path to the seed's worktree (where program.md is written)")
    ap.add_argument("--beta", required=True,
                    help='JSON {seed_id, direction, hypothesis, rationale} '
                         'or literal "null" for N=1 short-circuit')
    args = ap.parse_args()

    if not args.base_program.exists():
        _die(f"base program not found: {args.base_program}")
    if not args.worktree.is_dir():
        _die(f"worktree is not a directory: {args.worktree}")

    try:
        base_text = args.base_program.read_text()
    except UnicodeDecodeError as e:
        _die(f"base program is not UTF-8 text: {e}")

    if args.beta == "null":
        # N=1 short-circuit — copy base verbatim
        (args.worktree / "program.md").write_text(base_text)
        return

    try:
        beta = json.loads(args.beta)
    except json.JSONDecodeError as e:
        _die(f"--beta is not valid JSON (or literal 'null'): {e}")
    if not isinstance(beta, dict):
        _die("--beta must be a JSON object (or literal 'null')")

    prefix = build_prefix(beta)
    (args.worktree / "program.md").write_text(prefix + base_text)


if __name__ == "__main__":
    main()
