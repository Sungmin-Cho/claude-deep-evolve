"""pytest harness for dogfood_target. Score = passed / total."""
from toy import fizzbuzz, factorial


def test_fizzbuzz_basic():
    assert fizzbuzz(15) == "FizzBuzz"
    assert fizzbuzz(3) == "Fizz"
    assert fizzbuzz(5) == "Buzz"
    assert fizzbuzz(7) == "7"


def test_factorial():
    assert factorial(0) == 1
    assert factorial(1) == 1
    assert factorial(5) == 120
