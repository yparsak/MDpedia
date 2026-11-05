// One place that reads, validates and types every .env value (brainstorm 5.13).
// Environment values are strings: COOKIE_SECURE=false is the string "false",
// which is truthy, so booleans are parsed explicitly and anything else is rejected.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env into process.env. Variables already set in the real environment win,
// so `make` and systemd can override the file.
export function loadEnvFile() {
  const envPath = process.env.ENV_FILE
    ? path.resolve(process.env.ENV_FILE)
    : path.join(projectRoot, '.env');
  const result = dotenv.config({ path: envPath, quiet: true });
  return { envPath, found: !result.error };
}

const required = z.string({ required_error: 'is required, but missing or empty' }).min(1);

const bool = (def) =>
  z
    .enum(['true', 'false'], { errorMap: () => ({ message: 'must be exactly "true" or "false"' }) })
    .default(def)
    .transform((v) => v === 'true');

const int = (def, min, max) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().min(min, `must be at least ${min}`).max(max, `must be at most ${max}`))
    .default(def);

const nonNegative = (def) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, 'must be a number that is zero or more')
    .transform(Number)
    .default(def);

const absolutePath = z
  .string({ required_error: 'is required, but missing or empty' })
  .min(1)
  .refine((p) => path.isAbsolute(p), 'must be an absolute path');

const schema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: int('3000', 1, 65535),
  TRUST_PROXY: bool('false'),
  NODE_ENV: z
    .enum(['production', 'development', 'test'], {
      errorMap: () => ({ message: 'must be production, development or test' }),
    })
    .default('production'),

  DB_HOST: required,
  DB_PORT: int('3306', 1, 65535),
  DB_NAME: required,
  DB_USER: required,
  DB_PASSWORD: required,

  DOCS_DIR: absolutePath,
  STAGING_DIR: absolutePath,
  DATA_DIR: absolutePath,

  SESSION_SECRET: required.refine((s) => s.length >= 32, 'must be at least 32 characters'),
  COOKIE_SECURE: bool('false'),
  SESSION_IDLE_MINUTES: int('30', 1, 1440),
  SESSION_MAX_HOURS: int('8', 1, 168),
  PASSWORD_MIN_LENGTH: int('12', 8, 128),

  AI_PROVIDER: z.string().default('nvidia'),
  AI_BASE_URL: z.string().url('must be a full URL such as https://host/v1').optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_CALL_TIMEOUT_SECONDS: int('60', 1, 600),
  AI_MAX_ATTEMPTS: int('3', 1, 10),
  AI_DAILY_CAP: int('200', 0, 100000),
  AI_CONCURRENCY: int('1', 1, 8),
  AI_CIRCUIT_BREAKER_FAILURES: int('5', 1, 100),

  MAX_UPLOAD_BYTES: int('262144', 1, 104857600),

  JOB_POLL_INTERVAL_SECONDS: int('5', 1, 3600),
  RECONCILE_INTERVAL_MINUTES: int('15', 1, 1440),
  JOB_RETENTION_DAYS: int('30', 1, 3650),

  RATE_LOGIN_FAILS_PER_15MIN: int('5', 1, 1000),
  RATE_SEARCH_PER_MIN: int('30', 1, 10000),
  RATE_PAGES_PER_MIN: int('300', 1, 100000),
  RATE_ADMIN_WRITES_PER_MIN: int('20', 1, 10000),

  SEARCH_RESULT_LIMIT: int('100', 1, 1000),
  SEARCH_PAGE_SIZE: int('10', 1, 100),
  SEARCH_PARTIAL_THRESHOLD: int('3', 0, 1000),
  SEARCH_LOG_RETENTION_DAYS: int('90', 1, 3650),
  SEARCH_WEIGHT_TITLE: nonNegative('5'),
  SEARCH_WEIGHT_KEYWORD: nonNegative('3'),
  SEARCH_WEIGHT_PHRASE: nonNegative('3'),
  SEARCH_WEIGHT_SYNONYM: nonNegative('2'),
  SEARCH_WEIGHT_QUESTION: nonNegative('2'),
  SEARCH_WEIGHT_SUMMARY: nonNegative('2'),
  SEARCH_WEIGHT_BODY: nonNegative('1'),

  AUDIT_RETENTION_DAYS: int('365', 1, 3650),
  BACKUP_STALE_DAYS: int('7', 0, 3650),
});

const WEIGHT_KEYS = [
  'SEARCH_WEIGHT_TITLE',
  'SEARCH_WEIGHT_KEYWORD',
  'SEARCH_WEIGHT_PHRASE',
  'SEARCH_WEIGHT_SYNONYM',
  'SEARCH_WEIGHT_QUESTION',
  'SEARCH_WEIGHT_SUMMARY',
  'SEARCH_WEIGHT_BODY',
];

// Returns { ok: true, config } or { ok: false, errors: ['KEY: message', ...] }.
// An empty value is treated as unset, so the default applies (or "is required" fires).
export function loadConfig(env = process.env) {
  const raw = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[key];
    raw[key] = value === undefined || value.trim() === '' ? undefined : value.trim();
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => {
      const key = i.path.join('.');
      const shown = raw[key] === undefined || /KEY|PASSWORD|SECRET/.test(key) ? '' : ` (got "${raw[key]}")`;
      return `${key}: ${i.message}${shown}`;
    });
    return { ok: false, errors };
  }

  const v = parsed.data;
  if (WEIGHT_KEYS.every((k) => v[k] === 0)) {
    return { ok: false, errors: ['SEARCH_WEIGHT_*: at least one search weight must be above zero'] };
  }

  return {
    ok: true,
    config: {
      env: v.NODE_ENV,
      server: { host: v.HOST, port: v.PORT, trustProxy: v.TRUST_PROXY },
      db: { host: v.DB_HOST, port: v.DB_PORT, name: v.DB_NAME, user: v.DB_USER, password: v.DB_PASSWORD },
      paths: { docs: v.DOCS_DIR, staging: v.STAGING_DIR, data: v.DATA_DIR },
      session: {
        secret: v.SESSION_SECRET,
        cookieSecure: v.COOKIE_SECURE,
        idleMinutes: v.SESSION_IDLE_MINUTES,
        maxHours: v.SESSION_MAX_HOURS,
        passwordMinLength: v.PASSWORD_MIN_LENGTH,
      },
      ai: {
        provider: v.AI_PROVIDER,
        baseUrl: v.AI_BASE_URL,
        apiKey: v.AI_API_KEY,
        model: v.AI_MODEL,
        timeoutSeconds: v.AI_CALL_TIMEOUT_SECONDS,
        maxAttempts: v.AI_MAX_ATTEMPTS,
        dailyCap: v.AI_DAILY_CAP,
        concurrency: v.AI_CONCURRENCY,
        circuitBreakerFailures: v.AI_CIRCUIT_BREAKER_FAILURES,
      },
      uploads: { maxBytes: v.MAX_UPLOAD_BYTES },
      worker: {
        pollIntervalSeconds: v.JOB_POLL_INTERVAL_SECONDS,
        reconcileIntervalMinutes: v.RECONCILE_INTERVAL_MINUTES,
        jobRetentionDays: v.JOB_RETENTION_DAYS,
      },
      rate: {
        loginFailsPer15Min: v.RATE_LOGIN_FAILS_PER_15MIN,
        searchPerMin: v.RATE_SEARCH_PER_MIN,
        pagesPerMin: v.RATE_PAGES_PER_MIN,
        adminWritesPerMin: v.RATE_ADMIN_WRITES_PER_MIN,
      },
      search: {
        resultLimit: v.SEARCH_RESULT_LIMIT,
        pageSize: v.SEARCH_PAGE_SIZE,
        partialThreshold: v.SEARCH_PARTIAL_THRESHOLD,
        logRetentionDays: v.SEARCH_LOG_RETENTION_DAYS,
        weights: {
          title: v.SEARCH_WEIGHT_TITLE,
          keyword: v.SEARCH_WEIGHT_KEYWORD,
          phrase: v.SEARCH_WEIGHT_PHRASE,
          synonym: v.SEARCH_WEIGHT_SYNONYM,
          question: v.SEARCH_WEIGHT_QUESTION,
          summary: v.SEARCH_WEIGHT_SUMMARY,
          body: v.SEARCH_WEIGHT_BODY,
        },
      },
      retention: { auditDays: v.AUDIT_RETENTION_DAYS, backupStaleDays: v.BACKUP_STALE_DAYS },
    },
  };
}

// The startup summary. Written out field by field so a secret can never slip in
// by iterating the whole object.
export function summarize(config) {
  const set = (value) => (value ? 'set' : 'not set');
  return [
    `environment     ${config.env}`,
    `listen          ${config.server.host}:${config.server.port} (trust proxy: ${config.server.trustProxy})`,
    `database        ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.name} (password ${set(config.db.password)})`,
    `docs dir        ${config.paths.docs}`,
    `staging dir     ${config.paths.staging}`,
    `data dir        ${config.paths.data}`,
    `sessions        idle ${config.session.idleMinutes} min, max ${config.session.maxHours} h, secure cookie: ${config.session.cookieSecure} (secret ${set(config.session.secret)})`,
    `AI provider     ${config.ai.provider}, model ${config.ai.model || '<unset>'} (key ${set(config.ai.apiKey)})`,
    `upload cap      ${config.uploads.maxBytes} bytes`,
  ];
}
