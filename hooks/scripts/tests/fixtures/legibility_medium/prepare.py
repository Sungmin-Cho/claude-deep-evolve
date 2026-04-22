"""Scenario A harness: scores target.add() on three cases."""
from target import add


def main():
    cases = [(1, 1, 2), (5, 3, 8), (10, 10, 20)]
    passed = sum(1 for a, b, expected in cases if add(a, b) == expected)
    score = passed / len(cases)
    print(f"score: {score:.6f}")


if __name__ == "__main__":
    main()
