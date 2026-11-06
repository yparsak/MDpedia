# Introduction to Limits

A limit describes the value a function approaches as its input approaches some
point. It is the foundation of both the derivative and the integral.

## Why limits matter

Before limits, calculus rested on "infinitely small" quantities that nobody
could define precisely. Limits replaced that intuition with something you can
actually check.[^weierstrass]

## Common limit forms

| Expression | Limit as x approaches 0 | Notes |
|---|---|---|
| sin(x)/x | 1 | The standard trigonometric limit |
| (1 - cos x)/x | 0 | Follows from the half-angle identity |
| 1/x | does not exist | Left and right limits disagree |

## Checking a limit numerically

```python
def approach(f, target, steps=6):
    for i in range(1, steps + 1):
        h = 10 ** -i
        print(h, f(target + h))

approach(lambda x: (x**2 - 1) / (x - 1), 1.0)
```

The printed values close in on 2, which is the limit.

## Things to remember

- [x] A limit can exist where the function itself is undefined.
- [x] One-sided limits must agree for a two-sided limit to exist.
- [ ] Review the formal epsilon-delta definition.

See also <https://en.wikipedia.org/wiki/Limit_of_a_function> for a longer
treatment.

[^weierstrass]: The modern definition is usually credited to Karl Weierstrass.
