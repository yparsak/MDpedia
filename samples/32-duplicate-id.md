---
id: 1
slug: duplicate-id-fixture
---

# Duplicate ID Fixture

This file claims `id: 1`, which already belongs to another document on disk.

Place this in the docs directory over SSH alongside the real doc that holds
id 1, then rescan. Two files sharing an id must be detected: the newer file is
flagged and rejected, and the original doc keeps its row and stays live.

Change the `id` above if id 1 is not in use in your database.
