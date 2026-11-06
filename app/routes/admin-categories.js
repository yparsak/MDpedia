import { Router } from 'express';
import { verifyCsrf } from '../middleware/admin-session.js';
import { recordAudit } from '../services/audit.js';
import {
  NAME_MAX,
  checkName,
  checkSlug,
  createCategory,
  deleteCategory,
  directDocCounts,
  loadTree,
  moveCategory,
  pathLabel,
  reorderCategory,
  subtreeOf,
  updateCategory,
} from '../services/categories.js';
import { exportCategories } from '../services/categories-export.js';
import { noticeFrom } from '../services/notices.js';
import { SLUG_MAX } from '../public/js/slug.js';

const NOTICES = {
  created: { kind: 'ok', text: 'Category created.' },
  saved: { kind: 'ok', text: 'Saved. Document links through this category keep working: old paths redirect to the new one.' },
  moved: { kind: 'ok', text: 'Category moved. Document links through the old path redirect to the new one.' },
  reordered: { kind: 'ok', text: 'Order changed.' },
  deleted: { kind: 'ok', text: 'Category deleted.' },
  unchanged: { kind: 'warn', text: 'Nothing changed.' },
  'export-failed': { kind: 'warn', text: 'The change was saved, but categories.yaml could not be written. See the log.' },
};

const parseId = (value) => (/^\d{1,10}$/.test(String(value)) ? Number(value) : null);
const str = (value) => (typeof value === 'string' ? value : '');

export function adminCategoriesRouter({ pool, config, needAdmin }) {
  const router = Router();

  const notFound = (res) => res.status(404).render('404', { title: 'Page not found' });

  async function loadCategory(req, res, next) {
    const id = parseId(req.params.id);
    req.tree = await loadTree(pool);
    req.category = id === null ? null : (req.tree.byId.get(id) ?? null);
    if (!req.category) return notFound(res);
    next();
  }

  // Parent choices as an indented list. `exclude` removes a category and
  // everything under it, for the move form.
  const parentOptions = (tree, exclude = null) => {
    const skipped = new Set(exclude ? subtreeOf(exclude).map((n) => n.id) : []);
    return tree.nodes
      .filter((n) => !skipped.has(n.id))
      .map((n) => ({ id: n.id, label: `${'— '.repeat(n.depth - 1)}${n.name}`, depth: n.depth }));
  };

  async function renderIndex(res, status, { errors = [], notice = null, form = {} } = {}) {
    const tree = await loadTree(pool);
    const counts = await directDocCounts(pool);
    res.status(status).render('admin/categories', {
      title: 'Categories',
      errors,
      notice,
      form: { name: form.name ?? '', slug: form.slug ?? '', parentId: form.parentId ?? '' },
      rows: tree.nodes.map((n, index) => ({
        id: n.id,
        name: n.name,
        slug: n.slug,
        depth: n.depth,
        path: n.path,
        docCount: counts.get(n.id) ?? 0,
        canUp: tree.nodes.slice(0, index).some((o) => o.parentId === n.parentId),
        canDown: tree.nodes.slice(index + 1).some((o) => o.parentId === n.parentId),
      })),
      parents: parentOptions(tree),
      nameMax: NAME_MAX,
      slugMax: SLUG_MAX,
    });
  }

  async function renderDetail(res, status, tree, category, { errors = [], notice = null, form = {} } = {}) {
    const counts = await directDocCounts(pool);
    res.status(status).render('admin/category-detail', {
      title: category.name,
      errors,
      notice,
      category: {
        id: category.id,
        name: category.name,
        slug: category.slug,
        path: category.path,
        parentId: category.parentId ?? '',
        label: pathLabel(category),
        subcategoryCount: category.children.length,
        docCount: counts.get(category.id) ?? 0,
      },
      form: { name: form.name ?? category.name, slug: form.slug ?? category.slug },
      parents: parentOptions(tree, category),
      nameMax: NAME_MAX,
      slugMax: SLUG_MAX,
    });
  }

  // A change is saved first; the export and the audit entry follow it. A failed
  // export is reported but does not undo the change.
  async function finish(req, res, { action, summary, targetId, done, redirectTo }) {
    await recordAudit(pool, {
      actor: req.session.username,
      action,
      targetType: 'category',
      targetId,
      summary,
      ip: req.ip,
    });
    const exported = await exportCategories(pool, config);
    res.redirect(303, `${redirectTo}?msg=${exported ? done : 'export-failed'}`);
  }

  // -------------------------------------------------------------------- tree

  router.get('/', needAdmin, (req, res) => renderIndex(res, 200, { notice: noticeFrom(NOTICES, req) }));

  router.post('/', needAdmin, verifyCsrf, async (req, res) => {
    const rawParent = str(req.body.parent_id);
    const parentId = rawParent === '' ? null : parseId(rawParent);
    const form = { name: str(req.body.name), slug: str(req.body.slug), parentId: rawParent };

    const name = checkName(form.name);
    if (!name.ok) return renderIndex(res, 400, { errors: name.errors, form });
    const slug = checkSlug(form.slug, name.name);
    if (!slug.ok) return renderIndex(res, 400, { errors: slug.errors, form });
    if (rawParent !== '' && parentId === null) return renderIndex(res, 400, { errors: ['The parent category is not valid.'], form });

    const result = await createCategory(pool, { name: name.name, slug: slug.slug, parentId });
    if (!result.ok) return renderIndex(res, 400, { errors: result.errors, form });

    return finish(req, res, {
      action: 'category.create',
      summary: `Created category "${slug.slug}".`,
      targetId: result.id,
      done: 'created',
      redirectTo: '/admin/categories',
    });
  });

  router.post('/:id/reorder', needAdmin, verifyCsrf, loadCategory, async (req, res) => {
    const direction = str(req.body.direction);
    if (direction !== 'up' && direction !== 'down') return res.redirect(303, '/admin/categories?msg=unchanged');

    const result = await reorderCategory(pool, req.category.id, direction);
    if (!result.ok) return renderIndex(res, 400, { errors: result.errors });
    if (!result.changed) return res.redirect(303, '/admin/categories?msg=unchanged');

    return finish(req, res, {
      action: 'category.reorder',
      summary: `Moved category "${req.category.slug}" ${direction}.`,
      targetId: req.category.id,
      done: 'reordered',
      redirectTo: '/admin/categories',
    });
  });

  // ------------------------------------------------------------------ detail

  router.get('/:id', needAdmin, loadCategory, (req, res) =>
    renderDetail(res, 200, req.tree, req.category, { notice: noticeFrom(NOTICES, req) }),
  );

  const detailUrl = (category) => `/admin/categories/${category.id}`;

  router.post('/:id/edit', needAdmin, verifyCsrf, loadCategory, async (req, res) => {
    const form = { name: str(req.body.name), slug: str(req.body.slug) };
    const name = checkName(form.name);
    if (!name.ok) return renderDetail(res, 400, req.tree, req.category, { errors: name.errors, form });
    const slug = checkSlug(form.slug, name.name);
    if (!slug.ok) return renderDetail(res, 400, req.tree, req.category, { errors: slug.errors, form });

    const result = await updateCategory(pool, req.category.id, { name: name.name, slug: slug.slug });
    if (!result.ok) return renderDetail(res, 400, req.tree, req.category, { errors: result.errors, form });
    if (!result.changed) return res.redirect(303, `${detailUrl(req.category)}?msg=unchanged`);

    return finish(req, res, {
      action: 'category.edit',
      summary: result.slugChanged
        ? `Edited category "${req.category.slug}": name, slug now "${slug.slug}".`
        : `Renamed category "${req.category.slug}".`,
      targetId: req.category.id,
      done: 'saved',
      redirectTo: detailUrl(req.category),
    });
  });

  router.post('/:id/move', needAdmin, verifyCsrf, loadCategory, async (req, res) => {
    const rawParent = str(req.body.parent_id);
    const parentId = rawParent === '' ? null : parseId(rawParent);
    if (rawParent !== '' && parentId === null) {
      return renderDetail(res, 400, req.tree, req.category, { errors: ['The new parent category is not valid.'] });
    }

    const result = await moveCategory(pool, req.category.id, parentId);
    if (!result.ok) return renderDetail(res, 400, req.tree, req.category, { errors: result.errors });
    if (!result.changed) return res.redirect(303, `${detailUrl(req.category)}?msg=unchanged`);

    return finish(req, res, {
      action: 'category.move',
      summary: `Moved category "${req.category.slug}" ${parentId === null ? 'to the top level' : `under category ${parentId}`}.`,
      targetId: req.category.id,
      done: 'moved',
      redirectTo: detailUrl(req.category),
    });
  });

  router.post('/:id/delete', needAdmin, verifyCsrf, loadCategory, async (req, res) => {
    const result = await deleteCategory(pool, req.category.id);
    if (!result.ok) return renderDetail(res, 409, req.tree, req.category, { errors: result.errors });

    return finish(req, res, {
      action: 'category.delete',
      summary: `Deleted category "${result.slug}".`,
      targetId: req.category.id,
      done: 'deleted',
      redirectTo: '/admin/categories',
    });
  });

  return router;
}
