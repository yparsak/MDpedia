// A stand-in AI provider for testing the bulk AI edit without a real
// model. It speaks the same OpenAI-compatible Chat Completions the app uses, so you
// point the app at it with .env and nothing in the app changes:
//
//   AI_BASE_URL=http://127.0.0.1:4010/v1   AI_API_KEY=mock   AI_MODEL=mock-model
//
//   make mock-ai          (or: node scripts/mock-ai-server.js)
//
// What it answers depends on the instruction you type on the bulk edit page. Put one of
// these markers anywhere in the instruction:
//
//   (no marker)     adds a short "Examples" section to the end of the document: a good result
//   MOCK:alter      changes the first original line: refused by the add-only check, on every try
//   MOCK:flaky      alters the text on the first try and answers well on the retry
//   MOCK:badcheck   adds a good section but the self-check always says it failed
//   MOCK:slow       waits 4 seconds per call, so there is time to press Stop mid-batch
//   MOCK:fail       answers HTTP 400, so the job fails at once (the "Failed" status and Retry failed)
//
// Metadata extraction (uploads, keyword refresh) is answered with a small valid reply
// built from the document's title. MOCK_AI_PORT changes the port (default 4010).
// This is a test tool: it is not used by the app and holds no secrets.

import http from 'node:http';

const PORT = Number(process.env.MOCK_AI_PORT ?? 4010);
const SLOW_MS = 4000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const between = (text, tag) => {
  const match = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return match ? match[1].replaceAll(`<\\/${tag}`, `</${tag}`) : '';
};

function reply(res, content) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ model: 'mock-model', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
}

function metadata(userText) {
  const title = /Title: (.*)/.exec(userText)?.[1]?.trim() || 'Mock';
  return JSON.stringify({
    summary: `A mock summary of ${title}.`,
    keywords: [{ term: title.toLowerCase().slice(0, 50), weight: 3 }, { term: 'mock keyword', weight: 1 }],
    key_phrases: [],
    synonyms: [],
    questions: [],
    categories: [],
    proposed_categories: [],
  });
}

function addition(body) {
  const heading = /^## Examples/m.test(body) ? '## More examples (mock)' : '## Examples (mock)';
  return `${body.replace(/\s+$/, '')}\n\n${heading}\n\n1. Mock worked example one, with a solution.\n2. Mock worked example two, with a solution.\n3. Mock worked example three, with a solution.\n`;
}

// Changes the first non-blank original line, so the add-only check must refuse it.
function altered(body) {
  const lines = body.split('\n');
  const index = lines.findIndex((line) => line.trim() !== '');
  if (index !== -1) lines[index] = `${lines[index]} (the mock reworded this line)`;
  return `${lines.join('\n')}\n\nA mock addition.\n`;
}

async function handle(messages, res) {
  const system = messages[0]?.content ?? '';
  const user = messages.find((m) => m.role === 'user')?.content ?? '';
  const instruction = between(user, 'instruction');

  if (system.startsWith('You add new content')) {
    if (instruction.includes('MOCK:fail')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    if (instruction.includes('MOCK:slow')) await sleep(SLOW_MS);
    const body = between(user, 'document');
    const retrying = messages.length > 2;
    if (instruction.includes('MOCK:alter') || (instruction.includes('MOCK:flaky') && !retrying)) return reply(res, altered(body));
    return reply(res, addition(body));
  }

  if (system.startsWith('You check an edit')) {
    if (instruction.includes('MOCK:slow')) await sleep(SLOW_MS);
    const pass = !instruction.includes('MOCK:badcheck');
    return reply(res, JSON.stringify({ pass, reason: pass ? 'The mock additions follow the instruction.' : 'The mock says the additions do not follow the instruction.' }));
  }

  return reply(res, system.startsWith('You extract search metadata') ? metadata(user) : 'OK');
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    return res.end();
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let messages;
    try {
      messages = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages;
    } catch {
      res.writeHead(400);
      return res.end();
    }
    handle(messages, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`mock AI provider on http://127.0.0.1:${PORT}/v1 (Ctrl+C to stop)\n`);
});
