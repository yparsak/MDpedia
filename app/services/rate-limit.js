// A fixed-window request limiter, one counter per key (the client IP). Used for
// search (brainstorm section 7): N requests per window, then the key is refused
// until the window ends. Nothing is stored beyond the counters, so no IP address
// ever reaches the database or the search log.
//
// State is in memory: a restart clears it, which is acceptable for a single
// process on a LAN. The clock is injectable so the tests need no real waiting.

const SWEEP_ABOVE = 1000;

export function createRateLimiter({ limit, windowMs = 60 * 1000, now = Date.now }) {
  // key -> { count, resetAt }
  const windows = new Map();

  function sweep() {
    const t = now();
    for (const [key, w] of windows) if (w.resetAt <= t) windows.delete(key);
  }

  // Counts one request. { allowed: true } or { allowed: false, retryAfterSeconds }.
  // A refused request is not counted, so waiting out the window always works.
  function hit(key) {
    if (windows.size > SWEEP_ABOVE) sweep();
    const t = now();
    let w = windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + windowMs };
      windows.set(key, w);
    }
    if (w.count >= limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - t) / 1000)) };
    w.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  return { hit };
}
