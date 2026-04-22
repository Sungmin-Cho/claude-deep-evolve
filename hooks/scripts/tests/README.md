# session-helper.sh v3 test suite

Pytest suite for the v3 subcommands added to `hooks/scripts/session-helper.sh`.

## Setup

The system Python on this machine is PEP 668 / externally-managed, so we use a
venv at `.v3-venv/` in the repository root.

```bash
# one-time
python3 -m venv .v3-venv
source .v3-venv/bin/activate
pip install pytest pyyaml

# each shell
source .v3-venv/bin/activate
```

`.v3-venv/` is gitignored.

## Running

```bash
source .v3-venv/bin/activate
python -m pytest hooks/scripts/tests/ -v
```

## Layout

- `conftest.py` — shared fixtures: `run_helper`, `make_journal`, `make_session_yaml`.
- `test_session_helper_v3.py` — test module for the v3 subcommands.
- `fixtures/` — reserved for static test data.
