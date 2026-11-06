---
id: 42
slug: bad-yaml-fixture
title: "Unterminated quote
published: [true
  categories:
	- math/calculus
---

# Bad YAML Fixture

The front matter above is not parseable: an unterminated quoted string, an
unclosed flow sequence, a tab used for indentation, and a misplaced key.

Use this as the model for the reconciliation test. Copy this front matter over
a published doc's front matter via SSH, then press "Rescan now". The doc must
appear on the Attention page as "needs attention", and readers must continue to
see the last good version.
