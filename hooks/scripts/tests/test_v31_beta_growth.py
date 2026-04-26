"""Growth β: inherit § 5.1 gate but check against existing seeds' directions."""
import json, subprocess
from pathlib import Path

GEN = Path(__file__).parents[3] / "hooks/scripts/generate-beta-directions.py"


def run(*args):
    r = subprocess.run(["python3", str(GEN), *args], capture_output=True, text=True)
    return r.stdout, r.stderr, r.returncode


def test_growth_mode_accepts_non_overlapping_new_direction():
    existing = [
        {"seed_id": 1, "direction": "피처 엔지니어링"},
        {"seed_id": 2, "direction": "노이즈 필터링"},
    ]
    fixture = {
        "attempts": [{
            "direction": {"seed_id": 3, "direction": "앙상블 가중치",
                          "hypothesis": "h3", "rationale": "r3"},
            "max_similarity_to_existing": 0.45,
            "closest_existing_seed_id": 2,
        }]
    }
    out, err, rc = run("--mode", "growth",
                       "--existing-seeds", json.dumps(existing),
                       "--input", json.dumps(fixture))
    assert rc == 0, err
    data = json.loads(out)
    assert data["direction"]["seed_id"] == 3
    assert data["retries_used"] == 0

    # Additional path: --input may also be a file path
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(fixture, f)
        path = f.name
    out, err, rc = run("--mode", "growth",
                       "--existing-seeds", json.dumps(existing),
                       "--input", path)
    assert rc == 0, err


def test_growth_mode_retries_on_high_similarity():
    existing = [{"seed_id": 1, "direction": "이동평균 피처"}]
    fixture = {
        "attempts": [
            {"direction": {"seed_id": 2, "direction": "이동평균 변형",
                           "hypothesis": "h", "rationale": "r"},
             "max_similarity_to_existing": 0.85,
             "closest_existing_seed_id": 1},
            {"direction": {"seed_id": 2, "direction": "거래량 분석",
                           "hypothesis": "h", "rationale": "r"},
             "max_similarity_to_existing": 0.40,
             "closest_existing_seed_id": 1},
        ]
    }
    out, err, rc = run("--mode", "growth",
                       "--existing-seeds", json.dumps(existing),
                       "--input", json.dumps(fixture))
    assert rc == 0
    data = json.loads(out)
    assert data["retries_used"] == 1
    assert data["direction"]["direction"] == "거래량 분석"


def test_growth_mode_exhaustion_emits_warning():
    existing = [{"seed_id": 1, "direction": "이동평균"}]
    # All 3 attempts collide
    fixture = {
        "attempts": [
            {"direction": {"seed_id": 2, "direction": f"이동평균-{i}",
                           "hypothesis": "h", "rationale": "r"},
             "max_similarity_to_existing": 0.80 - i*0.01,
             "closest_existing_seed_id": 1}
            for i in range(3)
        ]
    }
    out, err, rc = run("--mode", "growth",
                       "--existing-seeds", json.dumps(existing),
                       "--input", json.dumps(fixture))
    assert rc == 0
    data = json.loads(out)
    assert data["retries_used"] == 2
    assert data["warning_emitted"] == "beta_diversity_warning"
    assert data["warning_context"] == "epoch_growth"
