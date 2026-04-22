# Dogfood Target Fixture (Task 28)

Self-dogfooding target for the v3.0.0 validation session. `toy.py` ships with
deliberate bugs in `fizzbuzz` (missing FizzBuzz + wrong divisor) and `factorial`
(off-by-one base case). The agent fixes these bugs experiment-by-experiment to
improve the pytest pass rate in `test_toy.py`.

Note: `session-helper.sh` is intentionally NOT in scope for this fixture — only
the pytest pass rate on `toy.py` is the scoring signal.
