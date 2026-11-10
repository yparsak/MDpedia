import { Router } from 'express';
import { pageCount, parsePage } from '../services/pagination.js';
import { listUnresolved } from '../services/wiki-links.js';

const LINK_PAGE_SIZE = 50;

// The unresolved-links report (roadmap Phase 5): every [[link]] in any doc whose
// target is not a published doc, so a typo in a slug is caught after an upload.
export function adminLinksRouter({ pool, needAdmin }) {
  const router = Router();

  router.get('/', needAdmin, async (req, res) => {
    const page = parsePage(req.query.page);
    const { total, rows } = await listUnresolved(pool, { limit: LINK_PAGE_SIZE, offset: (page - 1) * LINK_PAGE_SIZE });
    res.render('admin/links', {
      title: 'Unresolved links',
      rows,
      page,
      pages: pageCount(total, LINK_PAGE_SIZE),
      total,
    });
  });

  return router;
}
