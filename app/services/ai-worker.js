// The ingest worker (brainstorm 5.5): a polling loop in the web server's own
// process that runs AI jobs from the queue. It enforces the safety limits:
//   - at most AI_CONCURRENCY jobs at a time, each claimed atomically
//   - AI_MAX_ATTEMPTS tries per job, with exponential backoff, for transient
//     errors only (timeout, network, 429, 5xx); anything else fails the job at once
//   - a daily cap on calls (checked here before a claim, and per call in ai-usage.js)
//   - a circuit breaker: after AI_CIRCUIT_BREAKER_FAILURES provider failures in a
//     row the loop stops claiming until the admin resumes it
//   - at startup, jobs left running by a crash go back to the queue
//   - on shutdown, in-flight calls are aborted and their jobs put back, unharmed
//   - finished jobs older than JOB_RETENTION_DAYS are deleted

import { log, errorFields } from '../logger.js';
import { recordAudit } from './audit.js';
import { aiConfigured } from '../config.js';
import { AiAborted, AiError } from './ai-provider.js';
import { getCircuit, recordFailure, recordSuccess } from './ai-circuit.js';
import { extractForDoc } from './ai-extract.js';
import { AiCapReached, cappedProvider, getUsage } from './ai-usage.js';
import { DocFileError } from './docfiles.js';
import { claimNext, markDone, markFailed, pruneJobs, recoverRunning, release, requeue } from './jobs.js';

const BACKOFF_BASE_MS = 5000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// What the admin is told, never the raw error: it may carry driver internals.
function describeFailure(err) {
  if (err instanceof AiError) return err.message;
  if (err instanceof DocFileError) return err.message;
  if (err.code === 'ENOENT') return 'The file for this document is missing from the docs directory.';
  return `Unexpected error${err.code ? ` (${err.code})` : ''}. See the server log.`;
}

export function createWorker({ pool, config }) {
  const provider = cappedProvider(pool, config);
  const shutdown = new AbortController();
  const running = new Set();
  let timer = null;
  let pruneTimer = null;
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
      return;
    }
    await markFailed(pool, job.id, job.attempts > 1 ? `Failed after ${job.attempts} attempts. ${failure}` : failure);
    await setDocStatus(job.docId, 'failed', ['uploaded', 'processing']);
  }

  async function runJob(job) {
    await setDocStatus(job.docId, 'processing', ['uploaded']);
    try {
      await extractForDoc(pool, config, provider, job.docId, { signal: shutdown.signal });
      await markDone(pool, job.id);
      await recordSuccess(pool);
    } catch (err) {
      if (err instanceof AiAborted) return release(pool, job.id, 'Interrupted by a restart. It will run again.');
      if (err instanceof AiCapReached) return release(pool, job.id, err.message);
      await handleFailure(job, err);
    }
  }

  // Claims jobs while there is room, the cap allows and the breaker is closed.
  async function tick() {
    if (ticking || stopping) return;
    ticking = true;
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

  async function prune() {
    try {
      const removed = await pruneJobs(pool, config.worker.jobRetentionDays);
      if (removed > 0) log.info('finished jobs pruned', { removed });
    } catch (err) {
      log.warn('job prune failed', errorFields(err));
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
      await prune();
      pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
      pruneTimer.unref();
      timer = setInterval(tick, config.worker.pollIntervalSeconds * 1000);
      timer.unref();
      tick();
    },

    // Stops claiming, aborts calls in flight and waits for their jobs to be put back.
    async stop() {
      stopping = true;
      clearInterval(timer);
      clearInterval(pruneTimer);
      shutdown.abort();
      await Promise.allSettled([...running]);
    },
  };
}
