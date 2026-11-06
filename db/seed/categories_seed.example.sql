-- Starting category tree (roadmap Phase 3). Copy this file to
-- db/seed/categories_seed.sql, edit it to your taste, then run
-- `make seed-categories`. It can be run again: a category that already exists
-- (same slug under the same parent) is skipped.
--
-- Keep math/calculus and math/analysis, and do not add physics/quantum-mechanics:
-- the Phase 7 bulk fixtures in samples/20-bulk/ assume exactly that.
-- Three levels at most. Slugs: lowercase letters, digits and hyphens.
--
-- After seeding, open /admin/categories. categories.yaml in the data directory
-- is rewritten by the next change in the editor, or when the app starts.

-- Top level. The NOT EXISTS guard stands in for the unique key, which does not
-- cover the top level (NULL parent).
INSERT INTO categories (parent_id, name, slug, sort_order)
SELECT NULL, 'Math', 'math', 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE parent_id IS NULL AND slug = 'math');

INSERT INTO categories (parent_id, name, slug, sort_order)
SELECT NULL, 'Physics', 'physics', 2 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE parent_id IS NULL AND slug = 'physics');

-- Second level. INSERT IGNORE plus the (parent_id, slug) unique key skips repeats.
INSERT IGNORE INTO categories (parent_id, name, slug, sort_order)
SELECT id, 'Calculus', 'calculus', 1 FROM categories WHERE parent_id IS NULL AND slug = 'math';

INSERT IGNORE INTO categories (parent_id, name, slug, sort_order)
SELECT id, 'Analysis', 'analysis', 2 FROM categories WHERE parent_id IS NULL AND slug = 'math';

INSERT IGNORE INTO categories (parent_id, name, slug, sort_order)
SELECT id, 'Linear Algebra', 'linear-algebra', 3 FROM categories WHERE parent_id IS NULL AND slug = 'math';

INSERT IGNORE INTO categories (parent_id, name, slug, sort_order)
SELECT id, 'Probability', 'probability', 4 FROM categories WHERE parent_id IS NULL AND slug = 'math';

INSERT IGNORE INTO categories (parent_id, name, slug, sort_order)
SELECT id, 'Logic and Sets', 'logic-and-sets', 5 FROM categories WHERE parent_id IS NULL AND slug = 'math';

INSERT IGNORE INTO categories (parent_id, name, slug, sort_order)
SELECT id, 'Classical Mechanics', 'classical-mechanics', 1 FROM categories WHERE parent_id IS NULL AND slug = 'physics';

INSERT IGNORE INTO categories (parent_id, name, slug, sort_order)
SELECT id, 'Thermodynamics', 'thermodynamics', 2 FROM categories WHERE parent_id IS NULL AND slug = 'physics';
