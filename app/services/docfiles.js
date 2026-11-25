// Document files in DOCS_DIR, one `<slug>.md` per doc. The
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

// Writes the text to staging and proves its body is the one expected. `name`
// only names the temp file.
async function stage(config, name, text, expectedHash) {
  const tempPath = path.join(config.paths.staging, `${name}.${crypto.randomBytes(6).toString('hex')}.tmp`);
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

// Reads an existing file. Resolves to { data, body }.
// Throws ENOENT if the file is gone and DocFileError if it cannot be parsed.
export async function readDocFile(config, slug) {
  const parsed = parseFrontMatter(await fs.readFile(docPath(config, slug), 'utf8'));
  if (!parsed.ok) throw new DocFileError(`The file cannot be read. ${parsed.error}`);
  return { data: parsed.data, body: parsed.body };
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

// ------------------------------------------------- staged replacements (Phase 8)

// One staged version per doc, at STAGING_DIR/replace-<id>.md. The reconciliation
// scan reads only the docs directory, so a staged file is never picked up as a doc.
const STAGED_PATTERN = /^replace-(\d+)\.md$/;

function stagedPath(config, docId) {
  if (!Number.isInteger(docId) || docId <= 0) throw new DocFileError('Invalid document id.');
  return path.join(config.paths.staging, `replace-${docId}.md`);
}

// Writes (or overwrites: one staged version per doc) the staged file, atomically.
export async function writeStagedFile(config, docId, text, expectedHash) {
  const target = stagedPath(config, docId);
  const tempPath = await stage(config, `replace-${docId}`, text, expectedHash);
  try {
    await fs.rename(tempPath, target);
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    throw err;
  }
}

// Resolves to { data, body }. Throws ENOENT if there is no staged file and DocFileError if it cannot be parsed.
export async function readStagedFile(config, docId) {
  const parsed = parseFrontMatter(await fs.readFile(stagedPath(config, docId), 'utf8'));
  if (!parsed.ok) throw new DocFileError(`The staged file cannot be read. ${parsed.error}`);
  return { data: parsed.data, body: parsed.body };
}

export async function removeStagedFile(config, docId) {
  await fs.rm(stagedPath(config, docId), { force: true });
}

// The swap: the new text is written to staging and checked, then
// renamed over the live file, so a reader of the file sees the old version or the new one.
export async function swapIntoPlace(config, slug, text, expectedHash) {
  const target = docPath(config, slug);
  const tempPath = await stage(config, slug, text, expectedHash);
  try {
    await fs.rename(tempPath, target);
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    throw err;
  }
}

// Removes what nobody will claim: staged files whose doc has no staged version
// (keepIds holds the ids that do) and temp files left by a crash over a day ago.
// Resolves to how many files were removed.
export async function cleanStagingDir(config, keepIds) {
  let removed = 0;
  for (const entry of await fs.readdir(config.paths.staging, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = STAGED_PATTERN.exec(entry.name);
    const full = path.join(config.paths.staging, entry.name);
    const orphanStaged = match !== null && !keepIds.has(Number(match[1]));
    const staleTemp = match === null && entry.name.endsWith('.tmp') && Date.now() - (await fs.stat(full)).mtimeMs > 24 * 60 * 60 * 1000;
    if (!orphanStaged && !staleTemp) continue;
    await fs.rm(full, { force: true });
    removed += 1;
  }
  return removed;
}

// ------------------------------------------------- reconciliation (Phase 8)

// Every `*.md` file in the docs directory with its size and modified time.
// slug is the file name without `.md`; it is not checked here.
export async function listDocFiles(config) {
  const files = [];
  for (const entry of await fs.readdir(config.paths.docs, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
    const stat = await fs.stat(path.join(config.paths.docs, entry.name));
    files.push({ fileName: entry.name, slug: entry.name.slice(0, -3), size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
  }
  return files;
}

// The text of a file found by listDocFiles (the name came from the directory listing, not from a request).
export const readDocFileText = (config, fileName) => fs.readFile(path.join(config.paths.docs, path.basename(fileName)), 'utf8');

// { size, mtimeMs } of a doc's file, or null when it is not there.
export async function statDocFile(config, slug) {
  try {
    const stat = await fs.stat(docPath(config, slug));
    return { size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
