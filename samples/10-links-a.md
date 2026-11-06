---
slug: links-a
---

# Links A

This document links to B in both forms.

A bare link: [[links-b]]

A link with display text: [[links-b|the second document]]

A link to itself, which should resolve normally: [[links-a]]

A link whose target has a typo and must show as broken: [[links-bb]]

Link targets are normalized before lookup, so these three point at the same
doc: [[Links-B]], [[  links-b  ]], and [[links-b]].

A link inside a code span must not be parsed: `[[links-b]]`

A link inside a fenced block must not be parsed either:

```
[[links-b]]
```
