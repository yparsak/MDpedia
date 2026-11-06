// categories.yaml in the data directory (brainstorm 5.4): the tree lives only in
// the database, so every change writes a copy with the ids, which is what the
// doc front matter refers to. It goes into every backup.
//
// Written to a temp file in the same directory and renamed, so a copy of the
// file never sees half of one. A failed export is logged and reported to the
// caller as false; it never undoes the change that triggered it.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { log, errorFields } from '../logger.js';
import { loadTree } from './categories.js';

export const EXPORT_FILE = 'categories.yaml';

// The flat list, parents before children, each with its derived path.
export function exportText(tree) {
  const categories = tree.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    slug: n.slug,
    parent_id: n.parentId,
    sort_order: n.sortOrder,
    path: n.path,
  }));
  return `# Written by MDpedia on every category change. Doc front matter refers to these ids.\n${stringify({ categories }, { lineWidth: 0 })}`;
}

// Resolves to true when the file was written.
export async function exportCategories(pool, config) {
  const target = path.join(config.paths.data, EXPORT_FILE);
  const tempPath = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tempPath, exportText(await loadTree(pool)), { encoding: 'utf8', flag: 'wx', mode: 0o640 });
    await fs.rename(tempPath, target);
    return true;
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    log.error('categories.yaml export failed', errorFields(err));
    return false;
  }
}
