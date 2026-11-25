// The worker thread that runs the embedding model. Embedding
// is CPU work that would freeze every page of the web server while it ran, so it
// lives here, started by embed-provider.js. Not imported by anything else.
//
// The package is imported here, not at the top of the app, so the wiki starts
// even when it is not installed and vector search is off.

import { parentPort, workerData } from 'node:worker_threads';

const { model, dtype, cacheDir } = workerData;
let extractor = null;

const loaded = (async () => {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  extractor = await pipeline('feature-extraction', model, { dtype });
  parentPort.postMessage({ type: 'ready' });
})();

loaded.catch((err) => parentPort.postMessage({ type: 'load-error', message: String(err?.message ?? err) }));

// { id, texts, pooling } in; { type: 'result', id, vectors } or { type: 'error', id, message } out.
// Vectors are normalized, so cosine distance and dot product agree.
parentPort.on('message', async ({ id, texts, pooling }) => {
  try {
    await loaded;
    const output = await extractor(texts, { pooling, normalize: true });
    parentPort.postMessage({ type: 'result', id, vectors: output.tolist() });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id, message: String(err?.message ?? err) });
  }
});
