import { Router } from 'express';
import { verifyCsrf } from '../middleware/admin-session.js';
import { receiveUpload } from '../middleware/receive-upload.js';
import { recordAudit } from '../services/audit.js';
import { enqueueAllEmbeddings } from '../services/embed-queue.js';
import { EmbedError } from '../services/embed-provider.js';
import { noticeFrom } from '../services/notices.js';
import { EVAL_MAX_BYTES, EVAL_MAX_QUERIES, TOP_N, parseTestSet } from '../services/search-eval.js';
import { QUERY_MAX_CHARS, parseQuery } from '../services/search-query.js';
import { getPublishedByIds, searchPublished } from '../services/search.js';
import { cleanLine } from '../services/text.js';
import { runVectorEvaluation } from '../services/vector-eval.js';
import { LAB_LIMIT, embedJobCounts, hasVectorIndex, searchVectors, vectorCoverage } from '../services/vectors.js';

const NOTICES = {
  rebuilt: { kind: 'ok', text: 'Every published document is queued for embedding. Watch the queue counts below, or /admin/jobs.' },
  off: { kind: 'warn', text: 'Vector search is off (EMBED_PROVIDER=none), so nothing was queued.' },
};

const MODES = ['scan', 'index', 'both'];
const TABLE_MISSING = 'The doc_vectors table is missing. Run make migrate (it needs MariaDB 11.7 or later).';

const str = (value) => (typeof value === 'string' ? value : '');
const isMissingTable = (err) => err.code === 'ER_NO_SUCH_TABLE';

// Vector search pages (roadmap Phase 11, admin only): the lab (11a, 11b) where a
// query shows its nearest documents, the SQL, the query plan and the time, and the
// compare page (11c) that sets keyword results beside vector results and scores the
// Phase 4 test set both ways. Nothing here is reachable by readers.
export function adminVectorsRouter({ pool, config, needAdmin, embedder }) {
  const router = Router();
  const enabled = config.embed.enabled && embedder !== null;
  const upload = receiveUpload({ maxBytes: EVAL_MAX_BYTES, fields: 3 });

  const audit = (req, action, summary) =>
    recordAudit(pool, { actor: req.session.username, action, summary, ip: req.ip });

  // The lab's header numbers. Resolves to { tableMissing, ... }.
  async function labStatus() {
    try {
      return {
        tableMissing: false,
        coverage: await vectorCoverage(pool, config),
        jobs: await embedJobCounts(pool),
        indexPresent: await hasVectorIndex(pool),
      };
    } catch (err) {
      if (isMissingTable(err)) return { tableMissing: true, coverage: null, jobs: null, indexPresent: false };
      throw err;
    }
  }

  const modelInfo = () => ({
    provider: config.embed.provider,
    model: config.embed.model,
    dtype: config.embed.dtype,
    dimensions: config.embed.dimensions,
    pooling: config.embed.pooling,
    queryPrefix: config.embed.queryPrefix,
    docPrefix: config.embed.docPrefix,
    cacheDir: config.embed.cacheDir,
  });

  // ---------------------------------------------------------------- the lab

  router.get('/', needAdmin, async (req, res) => {
    const query = cleanLine(str(req.query.q)).slice(0, QUERY_MAX_CHARS);
    const status = await labStatus();
    const requested = MODES.includes(req.query.mode) ? req.query.mode : null;
    const mode = requested ?? (status.indexPresent ? 'both' : 'scan');

    let runs = [];
    let queryMs = null;
    let coldStart = false;
    let error = null;
    if (query && !enabled) error = 'Vector search is off. Set EMBED_PROVIDER=transformersjs in .env and restart.';
    else if (query && status.tableMissing) error = TABLE_MISSING;
    else if (query) {
      const wanted = mode === 'both' ? ['scan', 'index'] : [mode];
      if (wanted.includes('index') && !status.indexPresent) {
        error = 'There is no vector index yet. Apply 012_vector_index (make migrate) to try the index mode.';
      } else {
        try {
          coldStart = embedder.state().state !== 'ready';
          const embedded = await embedder.embed([query], 'query');
          queryMs = embedded.ms;
          for (const wantedMode of wanted) runs.push(await searchVectors(pool, config, embedded.vectors[0], { limit: LAB_LIMIT, mode: wantedMode }));
        } catch (err) {
          if (!(err instanceof EmbedError)) throw err;
          error = err.message;
          runs = [];
        }
      }
    }

    // With both modes: do the two lists agree?
    let agreement = null;
    if (runs.length === 2) {
      const [scanIds, indexIds] = runs.map((r) => r.rows.map((row) => row.id));
      agreement = {
        sameOrder: JSON.stringify(scanIds) === JSON.stringify(indexIds),
        shared: scanIds.filter((id) => indexIds.includes(id)).length,
        of: scanIds.length,
      };
    }

    res.render('admin/vectors', {
      title: 'Vector lab',
      notice: noticeFrom(NOTICES, req),
      enabled,
      embedState: enabled ? embedder.state() : { state: 'off', error: null },
      info: modelInfo(),
      status,
      query,
      mode,
      runs,
      agreement,
      queryMs,
      coldStart,
      error,
      limit: LAB_LIMIT,
    });
  });

  router.post('/rebuild', needAdmin, verifyCsrf, async (req, res) => {
    if (!enabled) return res.redirect(303, '/admin/vectors?msg=off');
    const queued = await enqueueAllEmbeddings(pool, config);
    await audit(req, 'vectors.rebuild', `Queued ${queued} document${queued === 1 ? '' : 's'} for embedding (rebuild all vectors).`);
    res.redirect(303, '/admin/vectors?msg=rebuilt');
  });

  // ----------------------------------------------------------- the compare page

  const renderCompare = (res, status, { errors = [], query = '', side = null, report = null } = {}) =>
    res.status(status).render('admin/vector-compare', {
      title: 'Keyword and vector compared',
      enabled,
      errors,
      query,
      side,
      report,
      maxBytes: EVAL_MAX_BYTES,
      maxQueries: EVAL_MAX_QUERIES,
      topN: TOP_N,
      limit: LAB_LIMIT,
    });

  // One query, both ways. Resolves to { keyword, vector, vectorError }.
  async function compareQuery(query) {
    const { ids } = await searchPublished(pool, config, parseQuery(query));
    const keyword = (await getPublishedByIds(pool, ids.slice(0, LAB_LIMIT))).map((d) => ({ id: d.id, slug: d.slug, title: d.title }));
    try {
      const embedded = await embedder.embed([query], 'query');
      const mode = (await hasVectorIndex(pool)) ? 'index' : 'scan';
      const found = await searchVectors(pool, config, embedded.vectors[0], { limit: LAB_LIMIT, mode });
      return { keyword, vector: found.rows, vectorMode: mode, vectorError: null };
    } catch (err) {
      if (err instanceof EmbedError) return { keyword, vector: [], vectorMode: null, vectorError: err.message };
      if (isMissingTable(err)) return { keyword, vector: [], vectorMode: null, vectorError: TABLE_MISSING };
      throw err;
    }
  }

  router.get('/compare', needAdmin, async (req, res) => {
    const query = cleanLine(str(req.query.q)).slice(0, QUERY_MAX_CHARS);
    if (!query) return renderCompare(res, 200);
    if (!enabled) return renderCompare(res, 200, { query, errors: ['Vector search is off. Set EMBED_PROVIDER=transformersjs in .env and restart.'] });
    renderCompare(res, 200, { query, side: await compareQuery(query) });
  });

  router.post('/compare/eval', needAdmin, upload, verifyCsrf, async (req, res) => {
    if (!enabled) return renderCompare(res, 400, { errors: ['Vector search is off. Set EMBED_PROVIDER=transformersjs in .env and restart.'] });
    if (req.uploadError) {
      const tooBig = req.uploadError.code === 'LIMIT_FILE_SIZE';
      return renderCompare(res, tooBig ? 413 : 400, {
        errors: [tooBig ? `The file is over the ${EVAL_MAX_BYTES} byte limit.` : 'The upload could not be read. Choose the file again.'],
      });
    }
    if (!req.file || req.file.buffer.length === 0) return renderCompare(res, 400, { errors: ['Choose a test set file (.json) to upload.'] });

    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(req.file.buffer);
    } catch {
      return renderCompare(res, 400, { errors: ['The file is not valid UTF-8.'] });
    }
    const parsed = parseTestSet(text);
    if (!parsed.ok) return renderCompare(res, 400, { errors: [parsed.error] });

    let report;
    try {
      report = await runVectorEvaluation(pool, config, embedder, parsed.queries);
    } catch (err) {
      if (err instanceof EmbedError) return renderCompare(res, 502, { errors: [err.message] });
      if (isMissingTable(err)) return renderCompare(res, 409, { errors: [TABLE_MISSING] });
      throw err;
    }
    await audit(req, 'vectors.eval', `Scored a test set of ${report.summary.total} queries with keyword and vector search.`);
    renderCompare(res, 200, { report });
  });

  return router;
}
