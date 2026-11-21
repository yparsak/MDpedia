// Heartbeats for the background loops, so /healthz can say "alive" (brainstorm
// 5.17). A loop registers with the longest silence it may have, and beats every
// time it wakes up. A loop that was never started (the AI worker when the AI is
// not configured) is simply not registered, so it cannot make the check fail.

export function createLoopMonitor(now = Date.now) {
  const loops = new Map();

  return {
    register(name, maxSilenceMs) {
      loops.set(name, { maxSilenceMs, lastBeat: now() });
    },
    beat(name) {
      const loop = loops.get(name);
      if (loop) loop.lastBeat = now();
    },
    unregister(name) {
      loops.delete(name);
    },
    // Names of the loops that have been silent too long.
    stalled() {
      return [...loops].filter(([, l]) => now() - l.lastBeat > l.maxSilenceMs).map(([name]) => name);
    },
    allAlive() {
      return this.stalled().length === 0;
    },
  };
}
