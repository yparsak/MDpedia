---
id: 99999
slug: replace-target
---

# Replace Target

This file carries an `id` that belongs to a different document (or to no
document at all), while claiming the slug of the replace target.

Using this file with the Replace action on `replace-target` must be rejected
before anything is staged: the front matter `id` must match the doc being
replaced, or be absent entirely.

Set `id` to a real id belonging to some other doc for the sharpest version of
this test.
