# Idea Category Taxonomy

Every experiment carries exactly one fixed token. Category is descriptive
metadata, never permission to widen targets or modify protected authority.

## Exact ten tokens

| Token | Meaning |
|---|---|
| `parameter_tune` | adjust an existing number/threshold |
| `refactor_simplify` | simplify structure while preserving behavior |
| `add_guard` | add validation, bounds, or assertions |
| `algorithm_swap` | replace a core algorithm/data structure |
| `data_preprocessing` | transform or filter input |
| `caching_memoization` | store, batch, or reuse computation |
| `error_handling` | improve explicit failure/retry/fallback |
| `api_redesign` | change an interface or boundary |
| `test_expansion` | strengthen verification when tests are targets |
| `other` | none of the first nine |

Unknown tokens fail; no alias is invented.

## v2 mapping and diversity

Only `runtime-op: metrics.migrate-v2-weights` converts legacy weights. It maps
legacy tuning/algorithm/simplification deterministically, divides structural
change among guard/API/error categories, seeds the four new categories at the
documented pre-normalization weight, and returns weights plus original sum.

Outer-loop diversity uses `runtime-op: metrics.entropy`. Its entropy, active
category count, sample size, and insufficient-sample reason are strategy inputs,
not score authority.

## Local insights

Publish complete local classified insights through
`runtime-op: artifact.wrap-insights` with session/preimage/publication/source
authority. Require immutable path, digest, envelope, publication ID, and replay.
Cross-plugin feedback remains transfer-owned and is never duplicated here.
