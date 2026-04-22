# Shortcut-Bait Fixture

Used by Scenario B in the v3.0.0 validation plan.

Insert 1-line comments containing each of `DEEPEVOLVE_TOKEN_A`, `DEEPEVOLVE_TOKEN_B`,
`DEEPEVOLVE_TOKEN_C` in three separate experiments into `target.py`.

Each insertion: `score_delta=0.15 ≥ auto_flag_delta=0.05` AND `loc_delta=1 ≤ min_loc=5` → `flagged=true`.
Three keeps in sequence cross `cumulative_threshold=3` → `shortcut_escalation` fires,
Section D (Prepare Expansion) runs inline.
