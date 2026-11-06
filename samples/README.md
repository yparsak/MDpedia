# Test fixtures

Every file here exists to make one checklist item in `roadmap.md` provable.
They are inputs for manual UI testing, not an automated suite: you upload them
through the admin pages in the phase that names them.

`make samples-verify` re-checks the invariants these files depend on (sizes
against the upload cap, the deliberately broken encoding, the shared title in
the bulk set). Run it after editing anything here — a fixture that quietly
stops being broken turns its phase test into a test of nothing.

## Phase 2: Documents

| File | What it proves |
|---|---|
| `01-plain.md` | Title from the first heading, table, highlighted code, footnote, task list, autolink. The front matter the app writes must not disturb the body. |
| `02-math.md` | Inline and display KaTeX, math in lists and blockquotes, escaped `\$5` currency, and a malformed expression that must not take the page down (`throwOnError: false`). |
| `03-hostile.md` | The sanitizer. Script tags, event handlers, `javascript:`/`data:`/`vbscript:` links, images, iframes, forms, style injection, KaTeX expansion abuse, and a prompt-injection paragraph aimed at the Phase 6 extractor. Nothing may execute; the doc must be flagged as containing raw HTML. |
| `04-bad-encoding.md` | Rejected as invalid UTF-8. Contains lone continuation bytes, a truncated sequence, an overlong encoding. |
| `04b-null-byte.md` | Rejected for a NUL byte. Not named in the roadmap; split out because "invalid UTF-8" and "contains a null byte" are two separate checks in the upload validator. |
| `05-oversize.md` | Rejected for exceeding `MAX_UPLOAD_BYTES`. |
| `06-duplicate-slug.md` | Rejected as a taken slug. Upload **after** `01-plain.md` — it carries the same title and the same explicit slug. |

## Phase 5: Wiki links

| File | What it proves |
|---|---|
| `10-links-a.md` | `[[slug]]` and `[[slug\|display text]]`, a self-link, a typo'd target, target normalization (case and whitespace), and that `[[links]]` inside code spans and fenced blocks are **not** parsed. |
| `11-links-b.md` | Backlinks in both directions, so "what links here" has entries. |
| `12-links-c.md` | A forward reference to a doc that does not exist yet, plus a permanently broken link. |
| `13-links-d.md` | Not in the original roadmap list. The target of C's forward reference, so the "starts working when its target is published" test has a concrete file. Upload it only after confirming C's link renders as broken. |

## Phase 7: Review and bulk import

`20-bulk/` holds the 12 documents the roadmap calls for:

- `01-derivatives.md` — `categories: [math/calculus]`, matches the seeded tree. Files directly; AI category assignment is skipped, keyword extraction still runs.
- `02-integrals.md` — two matching categories, so primary and "also in" are both exercised.
- `03-quantum-entanglement.md` — `categories: [physics/quantum-mechanics]`, **not** in the tree. Must become a proposal, never auto-created.
- `04-matrices.md` through `09-set-theory.md` — no categories; the AI assigns them.
- `05-eigenvalues.md` also carries math, so the bulk path exercises KaTeX.
- `06-series-convergence.md` also carries a `[[derivatives]]` link to another file in the same batch.
- `10-logic-first.md` and `11-logic-second.md` — the same title. The second must import as `mathematical-logic-2` and the report must say so.
- `12-oversize-in-bulk.md` — over the cap. Must be skipped and listed, without aborting the batch.

These assume a seeded tree containing `math/calculus` and `math/analysis`, and
**not** containing `physics/quantum-mechanics`. Adjust the front matter if your
tree differs.

## Phase 8: Replace and reconcile

| File | What it proves |
|---|---|
| `30-replace-v1.md` | The doc to publish first. |
| `30-replace-v2.md` | The replacement. Matching `slug`, no `id` (allowed). Readers see v1 until you approve; a hand-edited summary survives the swap. |
| `31-bad-yaml.md` | Unparseable front matter: unterminated quote, unclosed flow sequence, tab indentation. Copy this front matter over a published doc via SSH, rescan, and the doc goes to the Attention page while readers keep the last good version. |
| `32-duplicate-id.md` | Two files claiming one `id`. The newer is flagged and rejected. Edit the `id` if 1 is not in use. |
| `33-wrong-id.md` | A replacement whose `id` belongs to a different doc. Rejected before staging. |

`31`, `32` and `33` are placed in the docs directory over SSH rather than
uploaded, since they test reconciliation, not the upload path.

## Not generated yet

`db/seed/search_test_set.example.json` (Phase 4) is the other fixture the
roadmap names. It needs the 30 to 50 real queries you write against your own
content, so it is not something to invent here.
