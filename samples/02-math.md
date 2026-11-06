# The Fundamental Theorem of Calculus

The theorem ties differentiation and integration together as inverse
operations.

## First part

If $f$ is continuous on $[a, b]$ and $F$ is defined by $F(x) = \int_a^x f(t)\,dt$,
then $F$ is differentiable and $F'(x) = f(x)$.

$$
\frac{d}{dx} \int_a^x f(t)\,dt = f(x)
$$

## Second part

If $F$ is any antiderivative of $f$ on $[a, b]$, then

$$
\int_a^b f(x)\,dx = F(b) - F(a).
$$

## A worked example

To evaluate $\int_0^{\pi} \sin x \, dx$, take $F(x) = -\cos x$:

$$
\int_0^{\pi} \sin x \, dx = \left[ -\cos x \right]_0^{\pi} = -(-1) - (-1) = 2
$$

## Related series

The exponential function has the expansion

$$
e^x = \sum_{n=0}^{\infty} \frac{x^n}{n!}
     = 1 + x + \frac{x^2}{2!} + \frac{x^3}{3!} + \cdots
$$

and for a matrix $A$ the same series defines $e^{A}$.

## A note on currency

Textbook problems often price things. A calculus text that costs \$5 and a
solutions manual that costs \$10 come to \$15 together. The backslashes keep
those dollar signs out of the math parser.

## Edge cases for the renderer

Inline math inside a list:

- The derivative $\frac{d}{dx} x^n = n x^{n-1}$ holds for all real $n$.
- Euler's identity, $e^{i\pi} + 1 = 0$, links five constants.

Display math inside a blockquote:

> $$
> \lim_{h \to 0} \frac{f(x+h) - f(x)}{h} = f'(x)
> $$

A deliberately malformed expression, to confirm the page still renders:

$\frac{1}{$
