// Runs the AI over one doc and stores the result (roadmap Phase 6). The file is
// canonical, so the front matter is written first (search terms, the summary
// unless the admin edited it, and the `ai:` provenance block) and then the
// database follows in one transaction. The title, slug, id and published flag are
// never touched, and nothing here publishes: the doc ends up "Ready for review".
//
// The AI replaces the doc's search terms. That is what "extraction" means; terms
// an author put in the upload are overwritten, hand edits come after.

import { DocFileError, readDocFile, updateDocFile } from './docfiles.js';
import { getDocById } from './docs.js';
import { loadTree } from './categories.js';
import { replaceSuggestions } from './ai-suggestions.js';
import { insertTerms, termsToFrontMatter } from './search-terms.js';

// The text the model reads: the title and the body, never the front matter.
export const documentText = (title, body) => `Title: ${title}\n\n${body}`;

// Writes an extraction result (from provider.extractMetadata) to the doc.
export async function applyExtraction(pool, config, doc, result) {
  const { data, provider, model, promptVersion } = result;
  const keepSummary = Boolean(doc.summary_edited);
  const date = new Date().toISOString().slice(0, 10);

  await updateDocFile(config, doc.slug, (frontMatter) => ({
    ...frontMatter,
    ...termsToFrontMatter(data.terms),
    ...(keepSummary ? {} : { summary: data.summary, summary_edited: undefined }),
    ai: { provider, model, prompt_version: promptVersion, date },
  }));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM doc_terms WHERE doc_id = ?', [doc.id]);
    await insertTerms(conn, doc.id, data.terms);
    await replaceSuggestions(conn, doc.id, data.categories, data.proposals);
    await conn.query(
      `UPDATE docs SET summary = ?, ai_provider = ?, ai_model = ?, ai_prompt_version = ?, ai_at = NOW(),
              status = IF(status IN ('uploaded', 'processing'), 'ready', status)
        WHERE id = ?`,
      [keepSummary ? doc.summary : data.summary, provider, model, promptVersion, doc.id],
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// The whole job for one doc: read the file, ask the model, store the answer.
// Throws AiError, AiAborted, AiCapReached (from the provider), DocFileError, or
// ENOENT when the file is gone.
export async function extractForDoc(pool, config, provider, docId, { signal } = {}) {
  const doc = await getDocById(pool, docId);
  if (!doc) throw new DocFileError('The document no longer exists.');
  const { body } = await readDocFile(config, doc.slug);
  const result = await provider.extractMetadata(documentText(doc.title, body), await loadTree(pool), { signal });
  await applyExtraction(pool, config, doc, result);
  return result;
}
