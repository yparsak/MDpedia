// The daily cap on AI calls. Every HTTP call counts, retries and
// repair tries included. The day is the database server's date, so it resets at
// that server's midnight.

import { createProvider } from './ai-provider.js';

// Thrown when no call is left for today.
export class AiCapReached extends Error {
  constructor(cap) {
    super(`The daily AI cap of ${cap} calls is reached. Queued work waits until tomorrow.`);
    this.name = 'AiCapReached';
  }
}

// Claims one call for today, or throws AiCapReached. A single conditional UPDATE,
// so two jobs running at once cannot both take the last call. Past the cap, a call
// is taken from the one-time allowance a bulk import grants (ai_state.extra_calls).
export async function reserveCall(pool, cap) {
  await pool.query('INSERT IGNORE INTO ai_usage_daily (day, calls) VALUES (CURDATE(), 0)');
  const [result] = await pool.query('UPDATE ai_usage_daily SET calls = calls + 1 WHERE day = CURDATE() AND calls < ?', [cap]);
  if (result.affectedRows > 0) return;
  const [extra] = await pool.query('UPDATE ai_state SET extra_calls = extra_calls - 1 WHERE id = 1 AND extra_calls > 0');
  if (extra.affectedRows === 0) throw new AiCapReached(cap);
  await pool.query('UPDATE ai_usage_daily SET calls = calls + 1 WHERE day = CURDATE()');
}

// { used, cap, extra, reached }. extra is what is left of the allowance above the cap.
export async function getUsage(pool, cap) {
  const [rows] = await pool.query('SELECT calls FROM ai_usage_daily WHERE day = CURDATE()');
  const [[state]] = await pool.query('SELECT extra_calls FROM ai_state WHERE id = 1');
  const used = Number(rows[0]?.calls ?? 0);
  const extra = Number(state?.extra_calls ?? 0);
  return { used, cap, extra, reached: used >= cap && extra === 0 };
}

// How many calls above today's cap a batch of `calls` needs, after what the cap
// and an earlier allowance already cover. 0 when the cap is enough.
export const allowanceNeeded = (usage, calls) => Math.max(0, calls - Math.max(0, usage.cap - usage.used) - usage.extra);

// The one-time allowance of a bulk import, added to what is left of an earlier one.
export async function grantAllowance(pool, calls) {
  await pool.query('UPDATE ai_state SET extra_calls = extra_calls + ? WHERE id = 1', [calls]);
}

// The provider every caller uses, so every call is counted against the cap.
export const cappedProvider = (pool, config) =>
  createProvider(config, { beforeCall: () => reserveCall(pool, config.ai.dailyCap) });
