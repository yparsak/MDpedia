// The rendering pipeline (brainstorm 5.8, 5.16, section 7). Markdown in, sanitized
// HTML and a plain-text copy out. Stages, in order:
//   parse (CommonMark, GFM, math)  ->  plain text  ->  raw HTML and images made inert
//   ->  to HTML  ->  sanitize  ->  title de-dup, heading ids, table of contents, anchors
//   ->  KaTeX  ->  syntax highlighting.
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

// Resolves to { html, plainText, hasRawHtml }. The title is the one stored for
// the doc, so a first H1 that repeats it is not rendered twice.
export async function renderMarkdown(body, { title }) {
  const file = await processor.process({ value: body, data: { title } });
  return {
    html: String(file),
    plainText: file.data.plainText ?? '',
    hasRawHtml: Boolean(file.data.hasRawHtml),
  };
}
