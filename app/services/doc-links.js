// Link data for a list of docs (home, category and search pages): the
// canonical URL through the primary category (brainstorm 5.4), the title, the
// summary and the primary category's label for the breadcrumb line.

import { docPath, pathLabel } from './categories.js';
import { categoryIdsForDocs } from './doc-categories.js';

// rows: { id, slug, title, summary }. tree comes from loadTree.
export async function docLinks(pool, tree, rows) {
  const categoryIds = await categoryIdsForDocs(pool, rows.map((d) => d.id));
  return rows.map((d) => {
    const primary = tree.byId.get(categoryIds.get(d.id)[0]) ?? null;
    return {
      id: d.id,
      url: `/wiki/${docPath(primary, d.slug)}`,
      title: d.title,
      summary: d.summary ?? '',
      categoryLabel: primary ? pathLabel(primary) : '',
    };
  });
}
