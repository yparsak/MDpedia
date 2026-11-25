// The AI provider adapter. One interface, OpenAI-compatible
// Chat Completions over fetch, configured only by AI_PROVIDER, AI_BASE_URL,
// AI_API_KEY and AI_MODEL, so changing provider is a change to .env.
//
//   provider.extractMetadata(documentText, categoryTree, { signal }) -> result
//   provider.testConnection({ signal })                              -> { model }
//   provider.editDocument(documentText, instruction, { ... })        -> result  (Phase 9)
//
// Every HTTP call first awaits `beforeCall`, which is where the daily cap is
// counted, so a repair retry counts like any other attempt. Errors are AiError
// with a sentence that is safe to store and show: it never holds the API key,
// the response body or any document text.

import {
  EDIT_PROMPT_VERSION,
  PROMPT_VERSION,
  buildCheckMessages,
  buildEditMessages,
  buildMessages,
  editRejectedMessage,
  repairMessage,
} from './ai-prompt.js';
import { parseCheckReply, parseReply } from './ai-schema.js';

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

// One chat call. Resolves to { content, model, truncated }; truncated is true when the
// provider stopped at the token limit. maxTokens overrides AI_MAX_TOKENS (an edit
// returns a whole document).
async function chat(config, messages, { signal, beforeCall, maxTokens = config.ai.maxTokens }) {
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
      body: JSON.stringify({ model: config.ai.model, messages, temperature: 0, max_tokens: maxTokens }),
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
  return {
    content,
    model: typeof body.model === 'string' ? body.model : config.ai.model,
    truncated: body?.choices?.[0]?.finish_reason === 'length',
  };
}

// What the self-check reads: the added lines, capped so a long addition cannot blow the context.
const CHECK_TEXT_MAX = 12000;

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

    // Phase 9. Asks the model to add to the document, per the instruction, then to check
    // its own output against the instruction. The caller's `validate(replyText)` (the
    // add-only check and the same file checks as an upload) returns
    // { ok: true, text, added } or { ok: false, reason }. A reply that fails either check
    // is sent back with the reason, at most `maxRetries` times, and every call counts
    // against the daily cap through beforeCall. There is no open-ended loop.
    // Resolves to { ok: true, text, calls, provider, model, promptVersion, checkReason }
    // or { ok: false, reason, calls, ... }. Throws AiError or AiAborted like the others.
    async editDocument(documentText, instruction, { title = '', signal, maxRetries = 0, validate } = {}) {
      const options = { signal, beforeCall, maxTokens: config.bulkEdit.maxTokens };
      const messages = buildEditMessages(title, documentText, instruction);
      const summary = { calls: 0, provider: config.ai.provider, model: config.ai.model, promptVersion: EDIT_PROMPT_VERSION };

      let reason = '';
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const reply = await chat(config, messages, options);
        summary.calls += 1;
        summary.model = reply.model;

        const checked = reply.truncated ? { ok: false, reason: 'the reply was cut off at the token limit.' } : validate(reply.content);
        if (checked.ok) {
          const addedText = checked.added.length > CHECK_TEXT_MAX ? `${checked.added.slice(0, CHECK_TEXT_MAX)}\n[cut off]` : checked.added;
          const verdictReply = await chat(config, buildCheckMessages(instruction, addedText), { signal, beforeCall, maxTokens: config.ai.maxTokens });
          summary.calls += 1;
          const verdict = parseCheckReply(verdictReply.content);
          if (verdict.pass) return { ok: true, text: checked.text, checkReason: verdict.reason, ...summary };
          reason = `The self-check failed: ${verdict.reason || 'no reason given'}`;
        } else {
          reason = checked.reason;
        }
        messages.push({ role: 'assistant', content: reply.content }, editRejectedMessage(reason));
      }
      return { ok: false, reason, ...summary };
    },

    // The model name the provider reports back, to prove the key and URL work.
    async testConnection({ signal } = {}) {
      const reply = await chat(config, [{ role: 'user', content: 'Reply with the single word OK.' }], { signal, beforeCall });
      return { model: reply.model };
    },
  };
}
