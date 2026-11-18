// The daily cap on AI calls (brainstorm 5.5). Every HTTP call counts, retries and
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
// so two jobs running at once cannot both take the last call.
export async function reserveCall(pool, cap) {
  await pool.query('INSERT IGNORE INTO ai_usage_daily (day, calls) VALUES (CURDATE(), 0)');
  const [result] = await pool.query('UPDATE ai_usage_daily SET calls = calls + 1 WHERE day = CURDATE() AND calls < ?', [cap]);
  if (result.affectedRows === 0) throw new AiCapReached(cap);
}

// { used, cap, reached }
export async function getUsage(pool, cap) {
  const [rows] = await pool.query('SELECT calls FROM ai_usage_daily WHERE day = CURDATE()');
  const used = Number(rows[0]?.calls ?? 0);
  return { used, cap, reached: used >= cap };
}

// The provider every caller uses, so every call is counted against the cap.
export const cappedProvider = (pool, config) =>
  createProvider(config, { beforeCall: () => reserveCall(pool, config.ai.dailyCap) });
