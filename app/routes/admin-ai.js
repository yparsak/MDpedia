import { Router } from 'express';
import { aiConfigured } from '../config.js';
import { verifyCsrf } from '../middleware/admin-session.js';
import { receiveUpload } from '../middleware/receive-upload.js';
import { AiAborted, AiError } from '../services/ai-provider.js';
import { documentText } from '../services/ai-extract.js';
import { AiCapReached, cappedProvider, getUsage } from '../services/ai-usage.js';
import { recordAudit } from '../services/audit.js';
import { loadTree, pathLabel } from '../services/categories.js';
import { DocFileError, readDocFile } from '../services/docfiles.js';
import { getDocById, listDocs } from '../services/docs.js';
import { parseFrontMatter } from '../services/frontmatter.js';
import { firstHeading } from '../services/markdown.js';
import { termsToFrontMatter } from '../services/search-terms.js';
import { resolveTitle, validateUploadFile } from '../services/upload.js';

const LAB_DOC_LIMIT = 100;
const parseId = (value) => (/^\d{1,10}$/.test(String(value)) ? Number(value) : null);

// Problems with the input or the provider that are shown on the page. Anything
// else is a bug and goes to the error page.
function describe(err) {
  if (err instanceof AiError || err instanceof AiCapReached || err instanceof DocFileError) return err.message;
  if (err instanceof AiAborted) return 'The call was interrupted.';
  if (err.code === 'ENOENT') return 'The file for this document is missing from the docs directory.';
  return null;
}

// The AI Lab and the connection test. The Lab runs the
// configured model over a doc and shows what came back. Nothing is saved: no
// file, no row, no job. It uses the same provider as the queue, so its calls
// count against the daily cap.
export function adminAiRouter({ pool, config, needAdmin }) {
  const router = Router();
  const receive = receiveUpload({ maxBytes: config.uploads.maxBytes, fields: 3 });

  const renderLab = async (res, status, { errors = [], connection = null, run = null } = {}) =>
    res.status(status).render('admin/ai-lab', {
      title: 'AI Lab',
      configured: aiConfigured(config),
      provider: config.ai.provider,
      model: config.ai.model ?? '',
      usage: await getUsage(pool, config.ai.dailyCap),
      docs: (await listDocs(pool, { limit: LAB_DOC_LIMIT, offset: 0 })).rows.map((d) => ({ id: d.id, title: d.title, slug: d.slug })),
      docLimit: LAB_DOC_LIMIT,
      maxBytes: config.uploads.maxBytes,
      errors,
      connection,
      run,
    });

  router.get('/', needAdmin, (req, res) => renderLab(res, 200));

  // ---------------------------------------------------------- test connection

  router.post('/test', needAdmin, verifyCsrf, async (req, res) => {
    if (!aiConfigured(config)) return renderLab(res, 400, { errors: ['Set AI_BASE_URL, AI_API_KEY and AI_MODEL in .env and restart.'] });
    let connection;
    try {
      const { model } = await cappedProvider(pool, config).testConnection();
      connection = { ok: true, model };
    } catch (err) {
      const message = describe(err);
      if (message === null) throw err;
      connection = { ok: false, message };
    }
    await recordAudit(pool, {
      actor: req.session.username,
      action: 'ai.test',
      summary: `Tested the AI connection: ${connection.ok ? 'ok' : 'failed'}.`,
      ip: req.ip,
    });
    return renderLab(res, connection.ok ? 200 : 502, { connection });
  });

  // -------------------------------------------------------------------- run

  // Resolves to { title, text } or { errors }. A chosen doc wins over a file.
  async function labInput(req) {
    const docId = parseId(req.body.doc_id);
    if (docId !== null) {
      const doc = await getDocById(pool, docId);
      if (!doc) return { errors: ['That document does not exist.'] };
      const { body } = await readDocFile(config, doc.slug);
      return { title: doc.title, text: documentText(doc.title, body), source: `doc ${doc.id}` };
    }
    if (!req.file) return { errors: ['Choose a document from the list or upload a Markdown file.'] };

    const checked = validateUploadFile({ buffer: req.file.buffer, originalName: req.file.originalname, maxBytes: config.uploads.maxBytes });
    if (!checked.ok) return { errors: checked.errors };
    const parsed = parseFrontMatter(checked.text);
    if (!parsed.ok) return { errors: [parsed.error] };
    const title = resolveTitle({
      formTitle: '',
      frontMatterTitle: parsed.data.title,
      heading: firstHeading(parsed.body),
      originalName: req.file.originalname,
    });
    return { title, text: documentText(title, parsed.body), source: 'an uploaded file' };
  }

  router.post('/run', needAdmin, receive, verifyCsrf, async (req, res) => {
    if (!aiConfigured(config)) return renderLab(res, 400, { errors: ['Set AI_BASE_URL, AI_API_KEY and AI_MODEL in .env and restart.'] });
    if (req.uploadError) {
      const tooBig = req.uploadError.code === 'LIMIT_FILE_SIZE';
      return renderLab(res, tooBig ? 413 : 400, {
        errors: [tooBig ? `The file is over the ${config.uploads.maxBytes} byte limit.` : 'The upload could not be read. Choose the file again.'],
      });
    }

    let input;
    try {
      input = await labInput(req);
    } catch (err) {
      const message = describe(err);
      if (message === null) throw err;
      return renderLab(res, 409, { errors: [message] });
    }
    if (input.errors) return renderLab(res, 400, { errors: input.errors });

    const tree = await loadTree(pool);
    const started = process.hrtime.bigint();
    const run = { title: input.title, passed: false };
    try {
      const result = await cappedProvider(pool, config).extractMetadata(input.text, tree);
      const { data } = result;
      run.passed = true;
      run.calls = result.calls;
      run.model = result.model;
      run.promptVersion = result.promptVersion;
      run.categories = data.categories.map((id) => pathLabel(tree.byId.get(id)));
      // The validated output as it would be stored, with category ids resolved for reading.
      run.json = JSON.stringify(
        {
          summary: data.summary,
          ...termsToFrontMatter(data.terms),
          categories: data.categories.map((id) => ({ id, path: pathLabel(tree.byId.get(id)) })),
          proposed_categories: data.proposals.map((p) => ({
            parent: p.parentId === null ? null : { id: p.parentId, path: pathLabel(tree.byId.get(p.parentId)) },
            name: p.name,
          })),
        },
        null,
        2,
      );
    } catch (err) {
      const message = describe(err);
      if (message === null) throw err;
      run.error = message;
    }
    run.seconds = (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1);

    await recordAudit(pool, {
      actor: req.session.username,
      action: 'ai.lab',
      summary: `AI Lab run on ${input.source}: ${run.passed ? `passed the schema in ${run.seconds} s` : 'failed'}.`,
      ip: req.ip,
    });
    return renderLab(res, 200, { run });
  });

  return router;
}
