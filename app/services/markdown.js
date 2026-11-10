// The rendering pipeline (brainstorm 5.8, 5.16, section 7). Markdown in, sanitized
// HTML and a plain-text copy out. Stages, in order:
//   parse (CommonMark, GFM, math)  ->  plain text  ->  raw HTML and images made inert
//   ->  to HTML  ->  sanitize  ->  [[wiki links]]  ->  title de-dup, heading ids,
//   table of contents, anchors  ->  KaTeX  ->  syntax highlighting.
// The sanitizer runs before KaTeX so KaTeX's many spans and inline styles are
// not stripped or whitelisted blindly. Do not add rehype-raw or allowDangerousHtml.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { visit, SKIP } from 'unist-util-visit';
import { toString as hastToString } from 'hast-util-to-string';
import { toString as mdastToString } from 'mdast-util-to-string';

const TOC_MIN_HEADINGS = 4;
const SAFE_LINK_SCHEMES = ['http', 'https', 'mailto'];

// [[target]] and [[target|display text]] (brainstorm 5.9). A target longer than
// LINK_TARGET_MAX, or past the first MAX_LINK_TARGETS different ones in a doc,
// is drawn as broken and not recorded, so one doc cannot flood doc_links.
const WIKI_LINK = /\[\[([^[\]|\n]*)(?:\|([^[\]\n]*))?\]\]/g;
const WIKI_LINK_SKIPPED_TAGS = new Set(['a', 'code', 'pre']);
export const LINK_TARGET_MAX = 200;
export const MAX_LINK_TARGETS = 200;

// Block-level HTML becomes a code block, inline HTML becomes text; either way
// the author sees the markup as visible text instead of losing it silently.
const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

// Plain text for the FULLTEXT index: math and raw HTML are left out so tokens
// like "frac" do not pollute it. Block nodes end with a newline.
const TEXT_SKIPPED = new Set(['html', 'math', 'inlineMath', 'yaml']);
const PHRASING = new Set([
  'text', 'emphasis', 'strong', 'delete', 'link', 'linkReference', 'inlineCode',
  'image', 'imageReference', 'footnoteReference',
]);

function collectText(node) {
  if (TEXT_SKIPPED.has(node.type)) return '';
  if (node.type === 'break') return '\n';
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if (typeof node.value === 'string') return node.value + (PHRASING.has(node.type) ? '' : '\n');
  const inner = (node.children ?? []).map(collectText).join(node.type === 'tableRow' ? ' ' : '');
  return PHRASING.has(node.type) || node.type === 'root' ? inner : `${inner}\n`;
}

function remarkPlainText() {
  return (tree, file) => {
    file.data.plainText = collectText(tree)
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };
}

function remarkSafeContent() {
  return (tree, file) => {
    let hasRawHtml = false;
    visit(tree, (node, index, parent) => {
      if (node.type === 'html') {
        hasRawHtml = true;
        parent.children[index] = FLOW_PARENTS.has(parent.type)
          ? { type: 'code', lang: null, meta: null, value: node.value }
          : { type: 'text', value: node.value };
        return SKIP;
      }
      // Images are disabled in v1: only the alt text is shown.
      if (node.type === 'image' || node.type === 'imageReference') {
        parent.children[index] = { type: 'text', value: node.alt ?? '' };
        return SKIP;
      }
      return undefined;
    });
    file.data.hasRawHtml = hasRawHtml;
  };
}

// Default GitHub-style schema, narrowed: links limited to http, https and mailto
// (relative paths have no scheme and pass), no <img>, and the classes
// remark-math puts on its code nodes allowed through so KaTeX can find them.
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames.filter((tag) => tag !== 'img'),
  protocols: { ...defaultSchema.protocols, href: SAFE_LINK_SCHEMES },
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes.code ?? []),
      ['className', 'language-math', 'math-inline', 'math-display'],
    ],
  },
};

const normalizeTitle = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

const isHeading = (node) => node.type === 'element' && /^h[1-6]$/.test(node.tagName);

// The footnote section's hidden heading is not a real heading of the document.
const isFootnoteLabel = (node) =>
  node.properties?.id === 'user-content-footnote-label' || node.properties?.className?.includes('sr-only');

// The page shows the title once, so a first H1 that repeats it is dropped.
function rehypeDropDuplicateTitle() {
  return (tree, file) => {
    const title = normalizeTitle(file.data.title);
    const index = tree.children.findIndex((n) => n.type === 'element' && n.tagName === 'h1');
    if (index === -1 || !title) return;
    if (normalizeTitle(hastToString(tree.children[index])) === title) tree.children.splice(index, 1);
  };
}

const text = (value) => ({ type: 'text', value });
const element = (tagName, properties, children) => ({ type: 'element', tagName, properties, children });

// A table of contents for 4 or more headings, placed before the body. Built
// from heading text and generated ids only, so nothing from the author reaches
// an attribute.
function rehypeToc() {
  return (tree) => {
    const headings = [];
    visit(tree, 'element', (node) => {
      if (isHeading(node) && node.properties?.id && !isFootnoteLabel(node)) headings.push(node);
    });
    if (headings.length < TOC_MIN_HEADINGS) return;

    const top = Math.min(...headings.map((h) => Number(h.tagName[1])));
    const items = headings.map((h) => {
      const depth = Math.min(Number(h.tagName[1]) - top + 1, 4);
      return element('li', { className: [`toc-level-${depth}`] }, [
        element('a', { href: `#${h.properties.id}` }, [text(hastToString(h))]),
      ]);
    });
    tree.children.unshift(
      element('nav', { className: ['toc'], ariaLabel: 'Table of contents' }, [
        element('p', { className: ['toc-title'] }, [text('Contents')]),
        element('ol', {}, items),
      ]),
    );
  };
}

// External links get rel="noopener noreferrer" (brainstorm 5.16).
function rehypeExternalLinks() {
  return (tree) => {
    visit(tree, 'element', (node) => {
      if (node.tagName === 'a' && typeof node.properties?.href === 'string' && /^(?:https?:)?\/\//i.test(node.properties.href)) {
        node.properties.rel = ['noopener', 'noreferrer'];
      }
    });
  };
}

export const normalizeLinkTarget = (text) => String(text).trim().toLowerCase();

// The pieces of a text value: { text } for plain text, { target, display } for a
// link. null when the value holds no link. An empty target stays plain text.
function splitWikiLinks(value) {
  const parts = [];
  let end = 0;
  for (const match of value.matchAll(WIKI_LINK)) {
    const target = normalizeLinkTarget(match[1]);
    if (target === '') continue;
    if (match.index > end) parts.push({ text: value.slice(end, match.index) });
    parts.push({ target, display: (match[2] ?? '').replace(/\s+/g, ' ').trim() });
    end = match.index + match[0].length;
  }
  if (parts.length === 0) return null;
  if (end < value.length) parts.push({ text: value.slice(end) });
  return parts;
}

// A link to a published doc shows its title unless the author gave display text.
// Anything else is drawn as a marked, dead span: it never reveals the title of a
// doc that is unpublished (brainstorm 5.10), and it is not an anchor.
function wikiLinkElement({ target, display }, doc) {
  if (doc?.published) {
    return element('a', { className: ['wikilink'], href: `/doc?id=${doc.id}` }, [text(display || doc.title)]);
  }
  return element('span', { className: ['wikilink-broken'], title: 'Broken link: no published document has this address' }, [
    text(display || target),
  ]);
}

// Turns [[links]] in prose into anchors. Runs after the sanitizer, on text nodes
// only, so code, links already in the page and the sanitizer's view of the
// author's markup are untouched; the anchors are built here from a numeric id.
// file.data.resolveLinks(targets) resolves to Map(slug -> { id, title, published }).
// file.data.linkTargets receives the recorded targets, for the doc_links table.
function rehypeWikiLinks() {
  return async (tree, file) => {
    const found = [];
    visit(tree, (node, index, parent) => {
      if (node.type === 'element' && WIKI_LINK_SKIPPED_TAGS.has(node.tagName)) return SKIP;
      if (node.type !== 'text' || !node.value.includes('[[')) return undefined;
      const parts = splitWikiLinks(node.value);
      if (parts) found.push({ parent, index, parts });
      return undefined;
    });

    const recorded = new Set();
    for (const { parts } of found) {
      for (const { target } of parts) {
        if (target !== undefined && target.length <= LINK_TARGET_MAX && (recorded.has(target) || recorded.size < MAX_LINK_TARGETS)) {
          recorded.add(target);
        }
      }
    }
    file.data.linkTargets = [...recorded];
    const resolved = recorded.size > 0 ? await file.data.resolveLinks([...recorded]) : new Map();

    // Last first, so the indexes of earlier siblings stay valid while splicing.
    for (const { parent, index, parts } of found.reverse()) {
      const nodes = parts.map((part) =>
        part.target === undefined ? text(part.text) : wikiLinkElement(part, recorded.has(part.target) ? resolved.get(part.target) : null),
      );
      parent.children.splice(index, 1, ...nodes);
    }
  };
}

// trust stays off. throwOnError false shows a bad equation as an error instead
// of failing the page, and maxExpand/maxSize stop a hostile macro from hanging
// the server (brainstorm 5.8). strict "ignore" keeps KaTeX from writing warnings
// to the console.
const katexOptions = { throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000, maxSize: 20, errorColor: '#b00020' };

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkPlainText)
  .use(remarkSafeContent)
  .use(remarkRehype)
  .use(rehypeSanitize, sanitizeSchema)
  .use(rehypeWikiLinks)
  .use(rehypeDropDuplicateTitle)
  .use(rehypeSlug)
  .use(rehypeToc)
  .use(rehypeAutolinkHeadings, {
    behavior: 'append',
    properties: { className: ['heading-anchor'], ariaLabel: 'Link to this section' },
    content: text('#'),
  })
  .use(rehypeExternalLinks)
  .use(rehypeKatex, katexOptions)
  .use(rehypeHighlight, { detect: false, ignoreMissing: true })
  .use(rehypeStringify);

// Parse only, for the title precedence rule (form, front matter, first H1, file name).
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export function firstHeading(body) {
  const heading = parser.parse(body).children.find((n) => n.type === 'heading' && n.depth === 1);
  return heading ? mdastToString(heading).trim() : null;
}

const noLinksResolved = async () => new Map();

// Resolves to { html, plainText, hasRawHtml, linkTargets }. The title is the one
// stored for the doc, so a first H1 that repeats it is not rendered twice.
// resolveLinks looks up [[link]] targets (see wiki-links.js); without it every
// link is drawn as broken.
export async function renderMarkdown(body, { title, resolveLinks = noLinksResolved }) {
  const file = await processor.process({ value: body, data: { title, resolveLinks } });
  return {
    html: String(file),
    plainText: file.data.plainText ?? '',
    hasRawHtml: Boolean(file.data.hasRawHtml),
    linkTargets: file.data.linkTargets ?? [],
  };
}
