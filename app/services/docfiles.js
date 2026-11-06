// Document files in DOCS_DIR, one `<slug>.md` per doc (roadmap Phase 2). The
// file name comes from the validated slug, never from an upload's file name.
//
// Every write goes through the staging directory: write a temp file, read it
// back, check the body hash is unchanged, then move it into place. Staging is on
// the same filesystem as the docs directory, so the move is atomic and a reader
// of the file sees either the old version or the new one, never half of one.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SLUG_PATTERN } from '../public/js/slug.js';
import { bodyHash, parseFrontMatter, serializeFrontMatter } from './frontmatter.js';

// A problem with the file itself, with a sentence safe to show the admin.
export class DocFileError extends Error {}

function docPath(config, slug) {
  // The slug is validated on the way in; this is the last line of defence
  // against a path that escapes the docs directory.
  if (!SLUG_PATTERN.test(slug)) throw new DocFileError('Invalid slug.');
  return path.join(config.paths.docs, `${slug}.md`);
}

// Writes the text to staging and proves its body is the one expected.
async function stage(config, slug, text, expectedHash) {
  const tempPath = path.join(config.paths.staging, `${slug}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tempPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o640 });
    const written = parseFrontMatter(await fs.readFile(tempPath, 'utf8'));
    if (!written.ok || bodyHash(written.body) !== expectedHash) {
      throw new DocFileError('The document body changed while the front matter was written, so nothing was saved.');
    }
    return tempPath;
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    throw err;
  }
}

// A new file. Fails with code EEXIST rather than replacing a file that is
// already there: link() refuses to overwrite, where rename() would not.
export async function createDocFile(config, { slug, text, expectedHash }) {
  const target = docPath(config, slug);
  const tempPath = await stage(config, slug, text, expectedHash);
  try {
    await fs.link(tempPath, target);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

export async function removeDocFile(config, slug) {
  await fs.rm(docPath(config, slug), { force: true });
}

// Rewrites an existing file with new front matter and the same body.
// mutate(data) returns the new front matter. Resolves to { data, body }.
// Throws ENOENT if the file is gone and DocFileError if it cannot be parsed.
export async function updateDocFile(config, slug, mutate) {
  const target = docPath(config, slug);
  const parsed = parseFrontMatter(await fs.readFile(target, 'utf8'));
  if (!parsed.ok) throw new DocFileError(`The file cannot be updated. ${parsed.error}`);

  const data = mutate(parsed.data);
  const tempPath = await stage(config, slug, serializeFrontMatter(data, parsed.body), bodyHash(parsed.body));
  try {
    await fs.rename(tempPath, target);
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    throw err;
  }
  return { data, body: parsed.body };
}
