"""β direction generator: iterative similarity gate for N>=5, single-turn N<=4, skip N=1."""
import json, subprocess, sys
from pathlib import Path

GEN = Path(__file__).parents[3] / "hooks/scripts/generate-beta-directions.py"


def run_gen(*args, input_data=None):
    r = subprocess.run(
        ["python3", str(GEN), *args],
        input=input_data, capture_output=True, text=True,
    )
    return r.stdout, r.stderr, r.returncode


def test_n1_skips_generation():
    """N=1 must emit the explicit N=1 short-circuit marker per § 5.1a."""
    out, err, rc = run_gen("--n", "1", "--project-analysis", '{"goal":"test"}',
                           "--input", "skip")
    assert rc == 0
    data = json.loads(out)
    assert data["skipped"] is True
    assert data["reason"] == "N=1 short-circuit (§ 5.1a)"
    assert data["directions"] == []


def test_n3_single_turn_accepts_output():
    """N<=4 accepts the AI's single-turn output without similarity checks."""
    fixture = {
        "directions": [
            {"seed_id": 1, "direction": "피처 엔지니어링", "hypothesis": "h1", "rationale": "r1"},
            {"seed_id": 2, "direction": "노이즈 필터링", "hypothesis": "h2", "rationale": "r2"},
            {"seed_id": 3, "direction": "앙상블 가중치", "hypothesis": "h3", "rationale": "r3"},
        ]
    }
    out, err, rc = run_gen("--n", "3", "--project-analysis", '{"goal":"test"}',
                           "--input", json.dumps(fixture))
    assert rc == 0
    data = json.loads(out)
    assert data["skipped"] is False
    assert len(data["directions"]) == 3
    assert data["retries_used"] == 0


def test_n6_iterative_reprompts_on_high_similarity():
    """N>=5 with high-similarity initial batch must re-prompt and succeed on retry."""
    fixture = {
        "attempts": [
            {"directions": [
                {"seed_id": 1, "direction": "이동평균 피처", "hypothesis": "h1", "rationale": "r1"},
                {"seed_id": 2, "direction": "이동평균 변형",  "hypothesis": "h2", "rationale": "r2"},
                {"seed_id": 3, "direction": "RSI 조정",     "hypothesis": "h3", "rationale": "r3"},
                {"seed_id": 4, "direction": "볼륨 지표",     "hypothesis": "h4", "rationale": "r4"},
                {"seed_id": 5, "direction": "VIX 연계",     "hypothesis": "h5", "rationale": "r5"},
            ],
             "max_similarity": 0.85,
             "collision_pair": [1, 2]},
            {"directions": [
                {"seed_id": 1, "direction": "이동평균 피처",  "hypothesis": "h1", "rationale": "r1"},
                {"seed_id": 2, "direction": "거래량 분석",    "hypothesis": "h2", "rationale": "r2"},
                {"seed_id": 3, "direction": "RSI 조정",      "hypothesis": "h3", "rationale": "r3"},
                {"seed_id": 4, "direction": "시간대별 패턴", "hypothesis": "h4", "rationale": "r4"},
                {"seed_id": 5, "direction": "VIX 연계",      "hypothesis": "h5", "rationale": "r5"},
            ],
             "max_similarity": 0.55,
             "collision_pair": None},
        ]
    }
    out, err, rc = run_gen("--n", "5", "--project-analysis", '{"goal":"test"}',
                           "--input", json.dumps(fixture))
    assert rc == 0
    data = json.loads(out)
    assert data["retries_used"] == 1
    assert len(data["directions"]) == 5
    assert data["max_similarity_observed"] <= 0.70


def test_n6_persistent_collision_emits_warning_and_accepts_best():
    """N>=5 with 2 retry exhaustion: accept best-of-3 + beta_diversity_warning."""
    fixture = {
        "attempts": [
            {"directions": [{"seed_id": i+1, "direction": f"dir-A-{i}", "hypothesis": "h", "rationale": "r"} for i in range(5)],
             "max_similarity": 0.85, "collision_pair": [1, 2]},
            {"directions": [{"seed_id": i+1, "direction": f"dir-B-{i}", "hypothesis": "h", "rationale": "r"} for i in range(5)],
             "max_similarity": 0.75, "collision_pair": [3, 4]},
            {"directions": [{"seed_id": i+1, "direction": f"dir-C-{i}", "hypothesis": "h", "rationale": "r"} for i in range(5)],
             "max_similarity": 0.72, "collision_pair": [1, 5]},
        ]
    }
    out, err, rc = run_gen("--n", "5", "--project-analysis", '{"goal":"test"}',
                           "--input", json.dumps(fixture))
    assert rc == 0
    data = json.loads(out)
    assert data["retries_used"] == 2
    assert data["warning_emitted"] == "beta_diversity_warning"
    assert data["max_similarity_observed"] == 0.72
    assert len(data["directions"]) == 5
