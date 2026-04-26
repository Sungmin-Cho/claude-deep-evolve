#!/usr/bin/env python3
"""convergence-detect.py — 3-class convergence classifier (spec § 7.5).

Pure function: no git, no LLM, no session.yaml access. Caller pre-computes
AI similarities + inspired_by map + cross_seed_borrow forum slice and passes
them via --args. Deterministic and unit-testable.

Contract (single JSON object via --args):
  keeps:          list of {commit, seed_id, ts, experiments_used_before_keep,
                           description, rationale}
  similarities:   list of {commit_a, commit_b, score}
  inspired_by_map: dict commit → parent_source_commit or null
  cross_seed_borrow_events: list of forum events (fallback ancestry path)
  threshold:      float in [0, 1], default 0.85 (§ 7.5 step 3)
  p3_floor:       int, default 3 (§ 7.5 classification gate)
  epoch:          int, echoed into output events

Output (stdout): {"convergence_events": [{...}]}.

Exit codes:
  0 — success (empty list valid)
  2 — schema error

Defensive patterns (T3/T5/T15/T17 lessons):
  - rc=2 for operator/schema via _die
  - stderr messages prefixed with 'error:'
  - .get() with fallbacks
  - bool-excluded isinstance checks (matches T17 BLOCKER fix)
  - No filesystem mutation; stdin-to-stdout only
"""
import argparse
import json
import sys


def _die(msg, rc=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(rc)


REQUIRED_KEYS = {"keeps", "similarities", "inspired_by_map",
                 "cross_seed_borrow_events"}


class UnionFind:
    def __init__(self):
        self.parent = {}

    def _add(self, x):
        if x not in self.parent:
            self.parent[x] = x

    def find(self, x):
        self._add(x)
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, x, y):
        rx, ry = self.find(x), self.find(y)
        if rx != ry:
            self.parent[rx] = ry

    def groups(self):
        gs = {}
        for node in list(self.parent.keys()):
            r = self.find(node)
            gs.setdefault(r, []).append(node)
        return list(gs.values())


def ancestry_set(commit, inspired_by_map, cross_seed_borrow_events):
    """Transitive closure via inspired_by + cross_seed_borrow target→source."""
    visited = {commit}
    frontier = [commit]
    forum_edge = {}
    for ev in cross_seed_borrow_events or []:
        tgt = ev.get("target_commit")
        src = ev.get("source_commit")
        if tgt and src:
            forum_edge[tgt] = src
    while frontier:
        c = frontier.pop()
        parent = (inspired_by_map or {}).get(c)
        if parent and parent not in visited:
            visited.add(parent)
            frontier.append(parent)
        fparent = forum_edge.get(c)
        if fparent and fparent not in visited:
            visited.add(fparent)
            frontier.append(fparent)
    return visited


def classify_cluster(cluster_keeps, inspired_by_map,
                     cross_seed_borrow_events, p3_floor):
    """Return (judged_as, shared_ancestors_list)."""
    per_keep_ancestries = []
    for k in cluster_keeps:
        anc = ancestry_set(k["commit"], inspired_by_map, cross_seed_borrow_events)
        per_keep_ancestries.append(anc)

    if per_keep_ancestries:
        shared = set.intersection(*per_keep_ancestries)
    else:
        shared = set()
    # Note: a cluster keep commit itself can legitimately be a "shared ancestor"
    # (e.g. when keep B was inspired_by keep A within the same cluster). We do
    # NOT discard self commits — the intersection semantics already excludes
    # independent keeps (each keep's ancestry includes only itself plus its
    # ancestry chain, so two disjoint-ancestry keeps yield an empty set).

    all_p3_clear = all(
        k.get("experiments_used_before_keep", 0) >= p3_floor
        for k in cluster_keeps
    )

    if not all_p3_clear:
        return "contagion_suspected", sorted(shared)
    if shared:
        return "borrow_chain_convergence", sorted(shared)
    return "evidence_based", []


def build_clusters(keeps, similarities, threshold):
    uf = UnionFind()
    by_commit = {k["commit"]: k for k in keeps}
    for c in by_commit:
        uf._add(c)
    for s in similarities or []:
        a, b, score = s.get("commit_a"), s.get("commit_b"), s.get("score", 0.0)
        if a not in by_commit or b not in by_commit:
            continue
        if by_commit[a].get("seed_id") == by_commit[b].get("seed_id"):
            continue
        if score >= threshold:
            uf.union(a, b)
    clusters = []
    for group in uf.groups():
        seed_ids = {by_commit[c].get("seed_id") for c in group
                    if c in by_commit}
        if len(seed_ids) >= 2:
            clusters.append([by_commit[c] for c in group if c in by_commit])
    return clusters


def main():
    ap = argparse.ArgumentParser(description="3-class convergence classifier")
    ap.add_argument("--args", required=True,
                    help="JSON payload — see module docstring")
    args = ap.parse_args()

    try:
        payload = json.loads(args.args)
    except json.JSONDecodeError as e:
        _die(f"--args is not valid JSON: {e}")

    if not isinstance(payload, dict):
        _die("--args must be a JSON object")

    missing = REQUIRED_KEYS - set(payload.keys())
    if missing:
        _die(f"missing required fields: {sorted(missing)}")

    keeps = payload["keeps"]
    if not isinstance(keeps, list):
        _die("keeps must be a list")
    for i, k in enumerate(keeps):
        if not isinstance(k, dict):
            _die(f"keeps[{i}] must be a dict, got {type(k).__name__}")
        sid = k.get("seed_id")
        if isinstance(sid, bool) or not isinstance(sid, int):
            _die(f"keeps[{i}].seed_id must be int (not bool), got {type(sid).__name__}")
        commit = k.get("commit")
        if not isinstance(commit, str) or not commit:
            _die(f"keeps[{i}].commit must be non-empty str, got {type(commit).__name__}")
    similarities = payload["similarities"]
    if not isinstance(similarities, list):
        _die("similarities must be a list")
    inspired_by_map = payload["inspired_by_map"]
    if not isinstance(inspired_by_map, dict):
        _die("inspired_by_map must be a dict")
    cross_seed = payload["cross_seed_borrow_events"]
    if not isinstance(cross_seed, list):
        _die("cross_seed_borrow_events must be a list")

    # Numeric fields reject bool (W-2 fix — T17 BLOCKER pattern)
    raw_threshold = payload.get("threshold", 0.85)
    if isinstance(raw_threshold, bool) or not isinstance(raw_threshold, (int, float)):
        _die(f"threshold must be number (not bool), got {type(raw_threshold).__name__}")
    threshold = float(raw_threshold)

    raw_p3 = payload.get("p3_floor", 3)
    if isinstance(raw_p3, bool) or not isinstance(raw_p3, int):
        _die(f"p3_floor must be int (not bool), got {type(raw_p3).__name__}")
    p3_floor = raw_p3

    raw_epoch = payload.get("epoch", 0)
    if isinstance(raw_epoch, bool) or not isinstance(raw_epoch, int):
        _die(f"epoch must be int (not bool), got {type(raw_epoch).__name__}")
    epoch = raw_epoch

    clusters = build_clusters(keeps, similarities, threshold)

    events = []
    for cluster in clusters:
        judged_as, shared = classify_cluster(
            cluster, inspired_by_map, cross_seed, p3_floor
        )
        direction = (cluster[0].get("description") or "").strip() or None
        events.append({
            "event": "convergence_event",
            "seed_ids": sorted({k.get("seed_id") for k in cluster}),
            "cluster_commits": [k["commit"] for k in cluster],
            "direction": direction,
            "trigger": f"semantic similarity >= {threshold}",
            "judged_as": judged_as,
            "shared_ancestors": shared,
            "epoch": epoch,
        })

    print(json.dumps({"convergence_events": events}, ensure_ascii=False))


if __name__ == "__main__":
    main()
