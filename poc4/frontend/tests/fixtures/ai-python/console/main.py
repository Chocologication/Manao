"""Acceptance starts with a real, deterministic business bug."""


def total(values):
    return sum(values) + 1


if __name__ == "__main__":
    print(total([1, 2, 3]))
