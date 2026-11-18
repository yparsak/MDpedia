// The AI provider adapter (brainstorm 5.6). One interface, OpenAI-compatible
// Chat Completions over fetch, configured only by AI_PROVIDER, AI_BASE_URL,
// AI_API_KEY and AI_MODEL, so changing provider is a change to .env.
//
//   provider.extractMetadata(documentText, categoryTree, { signal }) -> result
//   provider.testConnection({ signal })                              -> { model }
//
// Every HTTP call first awaits `beforeCall`, which is where the daily cap is
// counted, so a repair retry counts like any other attempt. Errors are AiError
// with a sentence that is safe to store and show: it never holds the API key,
// the response body or any document text.

import { PROMPT_VERSION, buildMessages, repairMessage } from './ai-prompt.js';
import { parseReply } from './ai-schema.js';

const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

// transient: worth another try (timeout, network, 429, 5xx). retryAfterMs: the
// provider's own Retry-After, when it sent one.
export class AiError extends Error {
  constructor(message, { transient = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'AiError';
    this.transient = transient;
    this.retryAfterMs = retryAfterMs;
  }
}

// The caller's signal fired (the app is shutting down): not a provider failure.
export class AiAborted extends Error {
  constructor() {
    super('The AI call was interrupted.');
    this.name = 'AiAborted';
  }
}

function httpError(response) {
  const { status } = response;
  if (status === 429 || status >= 500) {
    const seconds = Number(response.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : null;
    return new AiError(`The AI provider is busy or failing (HTTP ${status}).`, { transient: true, retryAfterMs });
  }
  if (status === 401 || status === 403) {
    return new AiError(`The AI provider rejected the API key (HTTP ${status}). Check AI_API_KEY.`);
  }
  if (status === 404) return new AiError('The AI provider did not find the endpoint or model (HTTP 404). Check AI_BASE_URL and AI_MODEL.');
  return new AiError(`The AI provider refused the request (HTTP ${status}).`);
}

// One chat call. Resolves to { content, model }.
async function chat(config, messages, { signal, beforeCall }) {
  await beforeCall();

  const timeout = AbortSignal.timeout(config.ai.timeoutSeconds * 1000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const url = `${config.ai.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  let response;
  let body;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ai.apiKey}` },
      body: JSON.stringify({ model: config.ai.model, messages, temperature: 0, max_tokens: config.ai.maxTokens }),
      signal: combined,
    });
    if (response.ok) body = await response.json();
  } catch (err) {
    if (signal?.aborted) throw new AiAborted();
    if (timeout.aborted) {
      throw new AiError(`The AI provider did not answer within ${config.ai.timeoutSeconds} seconds.`, { transient: true });
    }
    if (err instanceof SyntaxError) throw new AiError('The AI provider sent a reply that is not JSON.');
    throw new AiError(`Could not reach the AI provider (${err.cause?.code ?? err.name}).`, { transient: true });
  }

  if (!response.ok) throw httpError(response);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') throw new AiError('The AI provider sent a reply with no text.');
  return { content, model: typeof body.model === 'string' ? body.model : config.ai.model };
}

// beforeCall: awaited before every HTTP call; throw from it to refuse the call.
export function createProvider(config, { beforeCall = async () => {} } = {}) {
  return {
    // Resolves to { data, calls, provider, model, promptVersion }; data is what
    // ai-schema.js returns. Throws AiError (the reply failed the schema even after
    // one repair retry, or the provider failed), AiAborted, or whatever beforeCall throws.
    async extractMetadata(documentText, categoryTree, { signal } = {}) {
      const options = { signal, beforeCall };
      const messages = buildMessages(documentText, categoryTree);

      let calls = 1;
      let reply = await chat(config, messages, options);
      let checked = parseReply(reply.content, categoryTree);

      if (!checked.ok) {
        calls += 1;
        const repaired = await chat(config, [...messages, { role: 'assistant', content: reply.content }, repairMessage(checked.errors)], options);
        reply = repaired;
        checked = parseReply(repaired.content, categoryTree);
      }
      if (!checked.ok) {
        throw new AiError(`The reply did not match the schema, even after a repair try: ${checked.errors.slice(0, 3).join('; ')}`);
      }
      return { data: checked.data, calls, provider: config.ai.provider, model: reply.model, promptVersion: PROMPT_VERSION };
    },

    // The model name the provider reports back, to prove the key and URL work.
    async testConnection({ signal } = {}) {
      const reply = await chat(config, [{ role: 'user', content: 'Reply with the single word OK.' }], { signal, beforeCall });
      return { model: reply.model };
    },
  };
}
