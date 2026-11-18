// What the dashboard and the Jobs page show about the AI: whether it is
// configured, today's calls against the cap, the circuit breaker, and the queue.

import { aiConfigured } from '../config.js';
import { getCircuit } from './ai-circuit.js';
import { getUsage } from './ai-usage.js';
import { countJobs } from './jobs.js';

export async function aiOverview(pool, config) {
  const usage = await getUsage(pool, config.ai.dailyCap);
  const jobs = await countJobs(pool);
  return {
    configured: aiConfigured(config),
    provider: config.ai.provider,
    model: config.ai.model ?? '',
    usage,
    circuit: await getCircuit(pool),
    jobs,
    // Queued work that cannot start because today's calls are used up.
    waitingForCap: usage.reached && jobs.queued > 0,
  };
}
