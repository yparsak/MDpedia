// The ingest worker: a polling loop in the web server's own
// process that runs AI jobs from the queue. It enforces the safety limits:
//   - at most AI_CONCURRENCY jobs at a time, each claimed atomically
//   - AI_MAX_ATTEMPTS tries per job, with exponential backoff, for transient
//     errors only (timeout, network, 429, 5xx); anything else fails the job at once
//   - a daily cap on calls (checked here before a claim, and per call in ai-usage.js)
//   - a circuit breaker: after AI_CIRCUIT_BREAKER_FAILURES provider failures in a
//     row the loop stops claiming until the admin resumes it
//   - at startup, jobs left running by a crash go back to the queue
//   - on shutdown, in-flight calls are aborted and their jobs put back, unharmed
//   - every tick is a heartbeat for /healthz (services/loops.js)
//   (finished jobs are pruned by the maintenance job, services/maintenance.js)

import { log, errorFields } from '../logger.js';
import { recordAudit } from './audit.js';
import { aiConfigured } from '../config.js';
import { AiAborted, AiError } from './ai-provider.js';
import { getCircuit, recordFailure, recordSuccess } from './ai-circuit.js';
import { editForDoc, setEditDocState } from './ai-edit.js';
import { extractForDoc, extractForStaged } from './ai-extract.js';
import { AiCapReached, cappedProvider, getUsage } from './ai-usage.js';
import { DocFileError } from './docfiles.js';
import { claimNext, markDone, markFailed, recoverRunning, release, requeue } from './jobs.js';

const BACKOFF_BASE_MS = 5000;
const LOOP_NAME = 'ai-worker';
// /healthz fails when the loop has been silent for this many poll intervals (at least a minute).
const silenceLimitMs = (pollIntervalSeconds) => Math.max(60_000, pollIntervalSeconds * 3000);

// What the admin is told, never the raw error: it may carry driver internals.
function describeFailure(err) {
  if (err instanceof AiError) return err.message;
  if (err instanceof DocFileError) return err.message;
  if (err.code === 'ENOENT') return 'The file for this document is missing from the docs directory.';
  return `Unexpected error${err.code ? ` (${err.code})` : ''}. See the server log.`;
}

export function createWorker({ pool, config, loops = null }) {
  const provider = cappedProvider(pool, config);
  const shutdown = new AbortController();
  const running = new Set();
  let timer = null;
  let ticking = false;
  let stopping = false;

  const setDocStatus = (docId, status, onlyFrom) =>
    pool.query('UPDATE docs SET status = ? WHERE id = ? AND status IN (?)', [status, docId, onlyFrom]);

  async function handleFailure(job, err) {
    const failure = describeFailure(err);
    if (!(err instanceof AiError) && !(err instanceof DocFileError) && err.code !== 'ENOENT') {
      log.error('ai job failed unexpectedly', { job: job.id, ...errorFields(err) });
    }

    // Only the provider's own failures count toward the breaker.
    if (err instanceof AiError) {
      const tripped = await recordFailure(pool, config.ai.circuitBreakerFailures, failure);
      if (tripped) {
        log.warn('ai queue paused by the circuit breaker', { failures: config.ai.circuitBreakerFailures });
        await recordAudit(pool, {
          actor: 'system',
          action: 'ai.paused',
          summary: `The AI queue paused after ${config.ai.circuitBreakerFailures} failures in a row.`,
        });
      }
    }

    const retry = err instanceof AiError && err.transient && job.attempts < config.ai.maxAttempts;
    if (retry) {
      const backoff = err.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** (job.attempts - 1);
      await requeue(pool, job.id, { delayMs: backoff, message: `Attempt ${job.attempts} failed, will retry. ${failure}` });
      if (job.type === 'edit') await setEditDocState(pool, job.id, 'queued', { message: `Attempt ${job.attempts} failed, will retry. ${failure}` });
      return;
    }
    const finalMessage = job.attempts > 1 ? `Failed after ${job.attempts} attempts. ${failure}` : failure;
    await markFailed(pool, job.id, finalMessage);
    // A bulk edit job leaves the live doc alone; only its batch entry failed.
    if (job.type === 'edit') return setEditDocState(pool, job.id, 'failed', { message: finalMessage });
    // A replace job leaves the live doc alone; only its staged version failed.
    if (job.type === 'replace') {
      await pool.query("UPDATE docs SET staged_status = 'failed' WHERE id = ? AND staged_status = 'processing'", [job.docId]);
      return;
    }
    await setDocStatus(job.docId, 'failed', ['uploaded', 'processing']);
  }

  // The work of each job type. Ingest and replace are the Phase 6 and 8 jobs, edit is a bulk edit (Phase 9).
  function runByType(job) {
    const options = { signal: shutdown.signal };
    if (job.type === 'replace') return extractForStaged(pool, config, provider, job.docId, options);
    if (job.type === 'edit') return editForDoc(pool, config, provider, job, options);
    return extractForDoc(pool, config, provider, job.docId, options);
  }

  // A job put back unharmed: a bulk edit doc waits again with it.
  async function releaseJob(job, message) {
    await release(pool, job.id, message);
    if (job.type === 'edit') await setEditDocState(pool, job.id, 'queued', { onlyFrom: ['running'] });
  }

  async function runJob(job) {
    if (job.type === 'ingest') await setDocStatus(job.docId, 'processing', ['uploaded']);
    if (job.type === 'edit') await setEditDocState(pool, job.id, 'running', { onlyFrom: ['queued', 'running'] });
    try {
      await runByType(job);
      await markDone(pool, job.id);
      await recordSuccess(pool);
    } catch (err) {
      if (err instanceof AiAborted) return releaseJob(job, 'Interrupted by a restart. It will run again.');
      if (err instanceof AiCapReached) return releaseJob(job, err.message);
      await handleFailure(job, err);
    }
  }

  // Claims jobs while there is room, the cap allows and the breaker is closed.
  async function tick() {
    if (ticking || stopping) return;
    ticking = true;
    loops?.beat(LOOP_NAME);
    try {
      if ((await getCircuit(pool)).paused) return;
      while (running.size < config.ai.concurrency && !stopping) {
        if ((await getUsage(pool, config.ai.dailyCap)).reached) return;
        const job = await claimNext(pool);
        if (!job) return;
        const run = runJob(job)
          .catch((err) => log.error('ai worker could not finish a job', { job: job.id, ...errorFields(err) }))
          .finally(() => {
            running.delete(run);
            tick();
          });
        running.add(run);
      }
    } catch (err) {
      log.error('ai worker tick failed', errorFields(err));
    } finally {
      ticking = false;
    }
  }

  return {
    // Does nothing when the AI is not configured: uploads skip the queue then.
    async start() {
      if (!aiConfigured(config)) {
        log.info('ai worker not started: AI_BASE_URL, AI_API_KEY and AI_MODEL are not all set');
        return;
      }
      try {
        const recovered = await recoverRunning(pool, config.ai.maxAttempts);
        if (recovered.requeued + recovered.failed > 0) log.info('ai jobs recovered after a restart', recovered);
      } catch (err) {
        log.warn('ai job recovery failed', errorFields(err));
      }
      loops?.register(LOOP_NAME, silenceLimitMs(config.worker.pollIntervalSeconds));
      timer = setInterval(tick, config.worker.pollIntervalSeconds * 1000);
      timer.unref();
      tick();
    },

    // Stops claiming, aborts calls in flight and waits for their jobs to be put back.
    async stop() {
      stopping = true;
      clearInterval(timer);
      loops?.unregister(LOOP_NAME);
      shutdown.abort();
      await Promise.allSettled([...running]);
    },
  };
}
