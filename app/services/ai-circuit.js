// The circuit breaker: after AI_CIRCUIT_BREAKER_FAILURES provider
// failures in a row the queue pauses and stays paused until the admin resumes it,
// so a wrong key or a provider outage cannot burn through the queue. The state is
// one row in `ai_state`, so it survives a restart and the admin pages can read it.
// Only queue jobs count. The AI Lab and Test connection report their own errors.

export async function getCircuit(pool) {
  const [rows] = await pool.query('SELECT consecutive_failures, paused_at, pause_reason FROM ai_state WHERE id = 1');
  const row = rows[0] ?? { consecutive_failures: 0, paused_at: null, pause_reason: null };
  return {
    failures: Number(row.consecutive_failures),
    paused: row.paused_at !== null,
    pausedAt: row.paused_at ?? '',
    reason: row.pause_reason ?? '',
  };
}

export async function recordSuccess(pool) {
  await pool.query('UPDATE ai_state SET consecutive_failures = 0 WHERE id = 1');
}

// Counts one failure. Resolves to true when this failure paused the queue.
export async function recordFailure(pool, threshold, reason) {
  await pool.query('UPDATE ai_state SET consecutive_failures = consecutive_failures + 1 WHERE id = 1');
  const [result] = await pool.query(
    'UPDATE ai_state SET paused_at = NOW(), pause_reason = ? WHERE id = 1 AND paused_at IS NULL AND consecutive_failures >= ?',
    [String(reason).slice(0, 300), threshold],
  );
  return result.affectedRows > 0;
}

export async function resume(pool) {
  await pool.query('UPDATE ai_state SET consecutive_failures = 0, paused_at = NULL, pause_reason = NULL WHERE id = 1');
}
