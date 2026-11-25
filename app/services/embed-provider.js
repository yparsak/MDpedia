// The embedding adapter: the one place that turns text into
// vectors. The lab, the compare page and the embed worker call embed(texts, kind)
// and know nothing about the runtime, so the provider can change without touching
// them. Only `transformersjs` exists; `ollama` and `api` are possible later additions
// to ADAPTERS.
//
// transformersjs: one worker thread (embed-thread.js) holds the model, loaded
// once on the first request and reused. The model downloads on that first use.

import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { log } from '../logger.js';
import { applyPrefix } from './embed-text.js';

export class EmbedError extends Error {
  constructor(message, { transient = false } = {}) {
    super(message);
    this.name = 'EmbedError';
    this.transient = transient;
  }
}

const MESSAGE_MAX = 300;
const short = (message) => String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, MESSAGE_MAX);

// After a failed model load, the next requests fail at once for this long instead
// of each trying the download again.
const LOAD_RETRY_COOLDOWN_MS = 30_000;

function createTransformersAdapter(embedConfig) {
  let thread = null;
  let state = 'idle'; // idle | loading | ready | failed
  let lastError = null;
  let failedAt = 0;
  let nextId = 1;
  const pending = new Map();

  function failAll(error) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  }

  function handle(message) {
    if (message.type === 'ready') {
      state = 'ready';
      lastError = null;
      log.info('embedding model loaded', { model: embedConfig.model });
      return;
    }
    if (message.type === 'load-error') {
      state = 'failed';
      failedAt = Date.now();
      lastError = `The embedding model could not be loaded: ${short(message.message)}`;
      log.error('embedding model failed to load', { model: embedConfig.model, error: short(message.message) });
      failAll(new EmbedError(lastError));
      thread?.terminate();
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.type === 'result') entry.resolve(message.vectors);
    else entry.reject(new EmbedError(`The embedding model failed: ${short(message.message)}`));
  }

  function start() {
    fs.mkdirSync(embedConfig.cacheDir, { recursive: true });
    state = 'loading';
    const created = new Worker(new URL('./embed-thread.js', import.meta.url), {
      workerData: { model: embedConfig.model, dtype: embedConfig.dtype, cacheDir: embedConfig.cacheDir },
    });
    created.on('message', handle);
    created.on('error', (err) => {
      if (state !== 'failed') {
        state = 'failed';
        failedAt = Date.now();
        lastError = `The embedding thread crashed: ${short(err.message)}`;
      }
      failAll(new EmbedError(lastError));
    });
    created.on('exit', () => {
      if (thread === created) thread = null;
      if (state === 'ready' || state === 'loading') state = 'idle';
      failAll(new EmbedError('The embedding thread stopped.', { transient: true }));
    });
    thread = created;
  }

  return {
    state: () => ({ state, error: lastError }),

    // texts: strings already carrying their prefix. Resolves to one array of numbers per text.
    embedRaw(texts) {
      if (state === 'failed' && Date.now() - failedAt < LOAD_RETRY_COOLDOWN_MS) {
        return Promise.reject(new EmbedError(lastError));
      }
      if (!thread) {
        try {
          start();
        } catch (err) {
          state = 'failed';
          failedAt = Date.now();
          lastError = `The embedding thread could not start: ${short(err.message)}`;
          return Promise.reject(new EmbedError(lastError));
        }
      }
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new EmbedError(`The embedding took longer than ${embedConfig.timeoutSeconds} seconds.`, { transient: true }));
        }, embedConfig.timeoutSeconds * 1000);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        thread.postMessage({ id, texts, pooling: embedConfig.pooling });
      });
    },

    async close() {
      failAll(new EmbedError('The app is shutting down.', { transient: true }));
      const closing = thread;
      thread = null;
      state = 'idle';
      await closing?.terminate();
    },
  };
}

const ADAPTERS = { transformersjs: createTransformersAdapter };

// Resolves nothing until used. kind is 'document' or 'query': it picks the prefix.
// With EMBED_PROVIDER=none the embedder is disabled and embed() says so.
export function createEmbedder(config) {
  const embedConfig = config.embed;
  const adapter = embedConfig.enabled ? ADAPTERS[embedConfig.provider](embedConfig) : null;

  return {
    enabled: embedConfig.enabled,
    state: () => (adapter ? adapter.state() : { state: 'off', error: null }),

    // Resolves to { vectors, ms }: one vector per text, each checked against EMBED_DIMENSIONS.
    async embed(texts, kind) {
      if (!adapter) throw new EmbedError('Vector search is off. Set EMBED_PROVIDER=transformersjs in .env and restart.');
      const prefix = kind === 'query' ? embedConfig.queryPrefix : embedConfig.docPrefix;
      const started = performance.now();
      const vectors = await adapter.embedRaw(texts.map((text) => applyPrefix(prefix, text)));
      const ms = Math.round(performance.now() - started);
      const wrong = vectors.find((v) => v.length !== embedConfig.dimensions);
      if (wrong) {
        throw new EmbedError(
          `The model returned ${wrong.length} numbers per vector, but EMBED_DIMENSIONS is ${embedConfig.dimensions} and the doc_vectors column is fixed at 384. Check EMBED_MODEL and EMBED_DIMENSIONS.`,
        );
      }
      return { vectors, ms };
    },

    close: () => adapter?.close() ?? Promise.resolve(),
  };
}
