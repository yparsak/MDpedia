// Login throttle (brainstorm section 7): N failures per 15 minutes per key
// (the client IP), then that key is blocked for 15 minutes. There is no hard
// lockout of the account, because that would let anyone on the LAN lock the
// admin out. Each repeated failure also adds a growing delay instead.
//
// State is in memory: a restart clears it, which is acceptable for a single
// process on a LAN. The clock is injectable so the tests need no real waiting.

const WINDOW_MS = 15 * 60 * 1000;
const DELAY_STEP_MS = 500;
const DELAY_MAX_MS = 3000;
const SWEEP_ABOVE = 1000;

export function createThrottle({ maxFails, now = Date.now, windowMs = WINDOW_MS }) {
  // key -> { fails: [timestamp, ...], blockedUntil: timestamp | 0 }
  const entries = new Map();

  function sweep() {
    const t = now();
    for (const [key, e] of entries) {
      e.fails = e.fails.filter((f) => t - f < windowMs);
      if (e.fails.length === 0 && e.blockedUntil <= t) entries.delete(key);
    }
  }

  // { blocked: false } or { blocked: true, retryAfterSeconds }
  function check(key) {
    const e = entries.get(key);
    const t = now();
    if (e && e.blockedUntil > t) {
      return { blocked: true, retryAfterSeconds: Math.ceil((e.blockedUntil - t) / 1000) };
    }
    return { blocked: false };
  }

  // Returns { blocked, justBlocked, retryAfterSeconds, delayMs }.
  function recordFailure(key) {
    if (entries.size > SWEEP_ABOVE) sweep();
    const t = now();
    const e = entries.get(key) ?? { fails: [], blockedUntil: 0 };
    e.fails = e.fails.filter((f) => t - f < windowMs);
    e.fails.push(t);
    entries.set(key, e);

    if (e.fails.length >= maxFails) {
      e.blockedUntil = t + windowMs;
      e.fails = [];
      return { blocked: true, justBlocked: true, retryAfterSeconds: Math.ceil(windowMs / 1000), delayMs: 0 };
    }
    return {
      blocked: false,
      justBlocked: false,
      retryAfterSeconds: 0,
      delayMs: Math.min((e.fails.length - 1) * DELAY_STEP_MS, DELAY_MAX_MS),
    };
  }

  function reset(key) {
    entries.delete(key);
  }

  return { check, recordFailure, reset };
}
