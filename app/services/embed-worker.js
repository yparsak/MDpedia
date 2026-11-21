// The embedding worker (roadmap 5a point 8): a polling loop in the web server's
// own process that runs the 'embed' jobs of the shared queue, one at a time. The
// model itself runs in a worker thread (embed-provider.js), so a "Rebuild all
// vectors" run does not freeze the pages.
//
// It is the AI worker's smaller sibling, and differs on purpose: embedding is
// local, so it does not use AI_DAILY_CAP, the circuit breaker or AI_MAX_ATTEMPTS.
// A transient failure (a timeout) is retried with backoff up to MAX_ATTEMPTS; any
// other failure fails the job with a sentence for the Jobs page, where Retry works.
// Every tick is a heartbeat for /healthz, and the loop exists only when
// EMBED_PROVIDER is not 'none'.

import { log, errorFields } from '../logger.js';
import { EmbedError } from './embed-provider.js';
import { embedDocument } from './vectors.js';
import { claimNext, markDone, markFailed, recoverRunning, release, requeue } from './jobs.js';

const LOOP_NAME = 'embed-worker';
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 5000;
const silenceLimitMs = (pollIntervalSeconds) => Math.max(60_000, pollIntervalSeconds * 3000);

function describeFailure(err) {
  if (err instanceof EmbedError) return err.message;
  return `Unexpected error${err.code ? ` (${err.code})` : ''}. See the server log.`;
}

export function createEmbedWorker({ pool, config, embedder, loops = null }) {
  let timer = null;
  let ticking = false;
  let stopping = false;

  async function handleFailure(job, err) {
    const failure = describeFailure(err);
    if (!(err instanceof EmbedError)) log.error('embed job failed unexpectedly', { job: job.id, ...errorFields(err) });

    if (err instanceof EmbedError && err.transient && job.attempts < MAX_ATTEMPTS) {
      await requeue(pool, job.id, { delayMs: BACKOFF_BASE_MS * 2 ** (job.attempts - 1), message: `Attempt ${job.attempts} failed, will retry. ${failure}` });
      return;
    }
    await markFailed(pool, job.id, job.attempts > 1 ? `Failed after ${job.attempts} attempts. ${failure}` : failure);
  }

  async function runJob(job) {
    try {
      await embedDocument(pool, config, embedder, job.docId);
      await markDone(pool, job.id);
    } catch (err) {
      // Shutting down: the job goes back unharmed and runs after the restart.
      if (stopping) return release(pool, job.id, 'Interrupted by a restart. It will run again.');
      await handleFailure(job, err);
    }
  }

  async function tick() {
    if (ticking || stopping) return;
    ticking = true;
    loops?.beat(LOOP_NAME);
    try {
      while (!stopping) {
        const job = await claimNext(pool, { embed: true });
        if (!job) return;
        await runJob(job);
        loops?.beat(LOOP_NAME);
      }
    } catch (err) {
      log.error('embed worker tick failed', errorFields(err));
    } finally {
      ticking = false;
    }
  }

  return {
    // Does nothing when vector search is off.
    async start() {
      if (!embedder.enabled) {
        log.info('embed worker not started: EMBED_PROVIDER is none');
        return;
      }
      try {
        const recovered = await recoverRunning(pool, MAX_ATTEMPTS, { embed: true });
        if (recovered.requeued + recovered.failed > 0) log.info('embed jobs recovered after a restart', recovered);
      } catch (err) {
        log.warn('embed job recovery failed', errorFields(err));
      }
      loops?.register(LOOP_NAME, silenceLimitMs(config.worker.pollIntervalSeconds));
      timer = setInterval(tick, config.worker.pollIntervalSeconds * 1000);
      timer.unref();
      tick();
    },

    // Stops claiming and closes the model thread, which fails the job in flight (put back above).
    async stop() {
      stopping = true;
      clearInterval(timer);
      loops?.unregister(LOOP_NAME);
      await embedder.close();
    },
  };
}
