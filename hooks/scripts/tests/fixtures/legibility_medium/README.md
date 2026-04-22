# Legibility Medium Fixture (Scenario A)

Broken `add()` returning `a - b`. Fix flips score 0.0 → 1.0. Use this to
trigger a deterministic `kept` event on which to observe the Medium legibility
flow (rationale-missing → rationale_missing event + counter increment).
