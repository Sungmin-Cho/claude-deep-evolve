# Idea Category Taxonomy (v3.0.0)

Fixed constant referenced by inner-loop.md Step 1.5, outer-loop.md Step 6.5.1/6.5.3,
transfer.md A.2.5 mapping, session-helper.sh `entropy_compute` + `migrate_v2_weights`.

**Never modify without a major version bump.** Outer Loop may rebalance weights but
the category list itself is fixed protocol.

## 10 Categories (v3 taxonomy)

| # | category | Intent | Typical examples |
|---|---|---|---|
| 1 | `parameter_tune` | Number or threshold changes, logic unchanged | learning rate, timeout, threshold |
| 2 | `refactor_simplify` | Structure change, logic preserved | deduplication, extraction, renames |
| 3 | `add_guard` | Input/state validation | null checks, bounds, asserts |
| 4 | `algorithm_swap` | Core algorithm or data structure swap | list→set, quicksort→mergesort |
| 5 | `data_preprocessing` | Input transformation | tokenization, scaling, filtering |
| 6 | `caching_memoization` | Storing/reusing results | LRU, memo tables, batching |
| 7 | `error_handling` | Failure paths | try/catch, retry, fallback |
| 8 | `api_redesign` | Interface/signature changes | parameter reshuffle, return type, splits |
| 9 | `test_expansion` | Verification coverage (when target is the test itself) | edge case, property test |
| 10 | `other` | Anything that does not fit 1–9 | |

## v2 → v3 Deterministic Mapping

v2 has 4 categories; v3 has 10. Mapping is applied only at meta-archive read time
(transfer.md A.2.5) — never rewrites in-flight v2 session state.

```
1:1 mapped (v2 weight copied verbatim as pre-normalize value):
  parameter_tuning    → parameter_tune
  algorithm_swap      → algorithm_swap
  simplification      → refactor_simplify

split (v2 structural_change weight divided equally):
  structural_change   → add_guard      (+ v2_structural_change / 3)
                      → api_redesign   (+ v2_structural_change / 3)
                      → error_handling (+ v2_structural_change / 3)

floored (4 categories with no v2 source; pre-normalize seed 0.05 each):
  data_preprocessing
  caching_memoization
  test_expansion
  other

final step: renormalize so sum = 1.0
```

**Floor is a pre-normalize seed, not a post-normalize invariant.** See
spec `docs/superpowers/specs/2026-04-22-v3.0.0-aar-inspired-design.md` §5.1
worked examples for numerical behavior after normalization.