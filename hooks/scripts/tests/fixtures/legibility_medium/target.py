"""Minimal Scenario A target: broken implementation."""


def add(a, b):
    # Deliberate bug: returns a - b instead of a + b.
    # Fixing this produces a reproducible improvement path.
    return a - b
