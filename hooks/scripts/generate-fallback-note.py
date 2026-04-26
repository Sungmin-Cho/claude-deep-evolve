#!/usr/bin/env python3
"""generate-fallback-note.py — § 8.2 Step 6 fallback explanation generator.

Invoked by synthesis.md Step 6 fallback branch (Branch B options 2/3 +
Branch C). Reads session.yaml for the per-seed snapshot, accepts the
baseline-select.py reasoning + Q values + user choice via CLI args, and
writes structured completion/fallback_note.md.

Exit codes:
  0 — note written
  2 — schema/operator error (missing required arg, invalid baseline-
      reasoning JSON, missing session.yaml)
"""
import argparse
import json
import sys
from pathlib import Path


def _die(msg, rc=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


def _load_session_yaml(path):
    if not path.is_file():
        _die(f"session.yaml not found: {path}")
    try:
        import yaml
    except ImportError:
        _die("PyYAML required (pip install pyyaml)")
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        _die(f"session.yaml parse error: {e}")


def _format_per_seed_table(seeds):
    if not seeds:
        return "_No seeds in session.yaml._\n"
    lines = ["| seed | status | final_q |", "|---|---|---|"]
    for s in sorted(seeds, key=lambda x: x.get("id", 0)):
        sid = s.get("id", "?")
        status = s.get("status", "unknown")
        fq = s.get("final_q", 0.0)
        lines.append(f"| Seed {sid} | {status} | {fq} |")
    return "\n".join(lines) + "\n"


def _format_user_choice(uc):
    """Decode the user choice number into spec § 8.2 Step 6 wording."""
    mapping = {
        "1": "(1) 합성 채택 — accepted_with_regression",
        "2": "(2) 최고 seed 채택 — fallback to winner seed (user choice)",
        "3": "(3) 합성 폐기 + 원래 main 유지 — fallback to main (user choice)",
        "none": None,
    }
    return mapping.get(uc, f"unknown choice: {uc}")


def main():
    ap = argparse.ArgumentParser(
        description="§ 8.2 Step 6 fallback note generator"
    )
    ap.add_argument("--session-yaml", required=True, type=Path)
    ap.add_argument("--baseline-reasoning", required=True,
                    help="JSON {chosen_seed_id, tier, ties_broken_on}")
    ap.add_argument("--synthesis-q", required=True, type=float)
    ap.add_argument("--baseline-q", required=True, type=float)
    ap.add_argument("--user-choice", required=True,
                    choices=["1", "2", "3", "none"])
    ap.add_argument("--output", required=True, type=Path)
    args = ap.parse_args()

    try:
        reasoning = json.loads(args.baseline_reasoning)
    except json.JSONDecodeError as e:
        _die(f"--baseline-reasoning is not valid JSON: {e}")

    if not isinstance(reasoning, dict):
        _die("--baseline-reasoning must be a JSON object")

    # I-1 + I-2 fix: ties_broken_on must be a list of strings (T25 contract).
    # Without this guard:
    #   - null  → ', '.join(None)        → TypeError, rc=1, no "error:" prefix
    #   - "str" → ', '.join("final_q")   → "f, i, n, a, l, _, q" (silent corruption)
    tbo = reasoning.get("ties_broken_on")
    if tbo is not None and not isinstance(tbo, list):
        _die(f"--baseline-reasoning 'ties_broken_on' must be a list, "
             f"got {type(tbo).__name__}: {tbo!r}")

    session = _load_session_yaml(args.session_yaml)
    seeds = (session.get("virtual_parallel", {}) or {}).get("seeds", []) or []

    delta = args.synthesis_q - args.baseline_q
    user_choice_text = _format_user_choice(args.user_choice)

    if args.user_choice == "none":
        scenario_label = (
            "**Branch C — automatic regression fallback** "
            "(synthesis_Q dropped below baseline_Q − regression_tolerance "
            "without entering the user-prompt window)"
        )
    elif args.user_choice == "1":
        scenario_label = (
            "**Branch B option 1 — user accepted synthesis with regression** "
            "(synthesis_Q within regression_tolerance, but user chose to keep "
            "the synthesis result anyway)"
        )
    else:
        scenario_label = (
            "**Branch B option {} — user-driven fallback**".format(args.user_choice)
        )

    body_parts = [
        "# Fallback Note\n",
        scenario_label + "\n",
        "## Q Delta\n",
        f"- **synthesis_Q**: {args.synthesis_q:.4f}",
        f"- **baseline_Q**: {args.baseline_q:.4f}",
        f"- **delta**: {delta:+.4f}\n",
        "## Baseline Selection Reasoning\n",
        f"- **chosen_seed_id**: {reasoning.get('chosen_seed_id')}",
        f"- **tier**: {reasoning.get('tier')}",
        f"- **ties_broken_on**: {', '.join(reasoning.get('ties_broken_on') or []) or '(none)'}\n",
    ]

    if user_choice_text is not None:
        body_parts.extend([
            "## User Choice\n",
            f"- **selection**: {user_choice_text}\n",
        ])

    body_parts.extend([
        "## Per-Seed Snapshot\n",
        _format_per_seed_table(seeds),
        "\n_See also_: `synthesis.md` (AI integration narrative), "
        "`cross_seed_audit.md` (forum activity), `seed_reports/` (per-seed journeys).\n",
    ])

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(body_parts), encoding="utf-8")


if __name__ == "__main__":
    main()
