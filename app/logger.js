// JSON lines to standard output, collected by journald (brainstorm 5.17).
// No log files, so the SD card is not written to.

function write(level, msg, fields) {
  const line = { time: new Date().toISOString(), level, msg, ...fields };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

// Only the message and code of an error are logged, never the stack or driver
// internals, which can include connection details.
export function errorFields(err) {
  return { error: err?.message, code: err?.code };
}

export const log = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};

// Request logging: method, path without the query string (queries can carry
// search terms), status and duration.
export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    log.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms),
    });
  });
  next();
}
