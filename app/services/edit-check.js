// The safeguards on an AI edit (roadmap Phase 9). The AI may only add: this checks
// that every line of the original is still in the proposed text, word for word and in
// the same order, so anything it reworded, moved or deleted is refused. The proposal also
// goes through the checks an upload gets (no null byte, valid UTF-8, the size cap), and
// may not bring front matter of its own: the app keeps the front matter.
//
// Pure functions, no database and no files, so they can be tested alone.

import { splitFrontMatter } from './frontmatter.js';
import { validateUploadFile } from './upload.js';

const SNIPPET_MAX = 80;

// Line endings and trailing spaces do not count as changes; leading spaces do
// (they carry meaning in lists and code).
const linesOf = (text) => String(text).replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd());

const snippet = (line) => (line.trim().length > SNIPPET_MAX ? `${line.trim().slice(0, SNIPPET_MAX)}...` : line.trim());

// { ok: true, added: [lines] } when every non-blank original line appears in the
// proposal in order; the added lines are the proposal's non-blank lines that are not
// original ones. { ok: false, reason } otherwise.
export function checkAddOnly(original, proposed) {
  const originalLines = linesOf(original).filter((line) => line !== '');
  const proposedLines = linesOf(proposed);

  let next = 0;
  const matched = new Set();
  for (const line of originalLines) {
    let found = -1;
    for (let i = next; i < proposedLines.length; i += 1) {
      if (proposedLines[i] === line) {
        found = i;
        break;
      }
    }
    if (found === -1) return { ok: false, reason: `the original text was changed, moved or removed, near: "${snippet(line)}"` };
    matched.add(found);
    next = found + 1;
  }

  const added = proposedLines.filter((line, index) => line !== '' && !matched.has(index));
  if (added.length === 0) return { ok: false, reason: 'nothing was added.' };
  return { ok: true, added };
}

// Models sometimes wrap the whole reply in a ```markdown fence, and reasoning models
// emit a <think> block first. Only a fence labelled markdown/md (or none) around the
// entire reply is removed.
export function cleanReply(content) {
  const stripped = String(content ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i.exec(stripped);
  return fenced ? fenced[1] : stripped;
}

// The file checks every body gets, whoever wrote it. { ok: true, text } or { ok: false, reason }.
export function checkBodyText({ text, original, maxBytes }) {
  const checked = validateUploadFile({ buffer: Buffer.from(text, 'utf8'), originalName: 'edit.md', maxBytes });
  if (!checked.ok) return { ok: false, reason: checked.errors[0] };
  if (splitFrontMatter(text).raw !== null && splitFrontMatter(original).raw === null) {
    return { ok: false, reason: 'the text starts with front matter, which the app keeps and an edit may not add.' };
  }
  return { ok: true, text };
}

// The whole check of an AI reply against the original body. { ok: true, text, added: string }
// (added is the new lines joined, for the self-check) or { ok: false, reason }.
export function validateProposal({ original, reply, maxBytes }) {
  const text = cleanReply(reply);
  const body = checkBodyText({ text, original, maxBytes });
  if (!body.ok) return body;
  const addOnly = checkAddOnly(original, text);
  if (!addOnly.ok) return addOnly;
  return { ok: true, text, added: addOnly.added.join('\n') };
}
