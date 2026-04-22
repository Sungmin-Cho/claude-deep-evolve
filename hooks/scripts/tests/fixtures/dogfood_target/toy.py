"""Toy module for v3.0.0 self-dogfooding session.
Has buggy implementations; agent improves them experiment-by-experiment.
"""


def fizzbuzz(n: int) -> str:
    # Deliberate bugs: precedence + wrong divisor.
    if n % 3 == 0:
        return "Fizz"
    if n % 5 == 0:
        return "Buzz"
    return str(n)


def factorial(n: int) -> int:
    # Bug: off-by-one on base case.
    if n <= 1:
        return 0
    return n * factorial(n - 1)
