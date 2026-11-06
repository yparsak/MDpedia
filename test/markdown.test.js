// The rendering pipeline on the inputs that matter most: math, and hostile markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstHeading, renderMarkdown } from '../app/services/markdown.js';

const render = (body, title = 'Test') => renderMarkdown(body, { title });

test('inline and display math are rendered by KaTeX', async () => {
  const { html } = await render('Inline $x^2$ here.\n\n$$\n\\frac{a}{b}\n$$\n');
  assert.match(html, /class="katex"/);
  assert.match(html, /katex-display/);
});

test('escaped dollar signs stay ordinary text', async () => {
  const { html } = await render('It costs \\$5 and \\$10.');
  assert.doesNotMatch(html, /katex/);
  assert.match(html, /\$5 and \$10/);
});

test('a malformed equation does not throw', async () => {
  const { html } = await render('Broken $\\frac{1}{$ here.');
  assert.match(html, /katex/);
});

test('raw HTML is shown as text, flagged, and never emitted as markup', async () => {
  const { html, hasRawHtml } = await render('<script>alert(1)</script>\n\nText <b onclick="x()">bold</b>\n');
  assert.equal(hasRawHtml, true);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<b /);
  assert.match(html, /&#x3C;script>|&lt;script>/);
});

test('unsafe link schemes lose their href, safe ones keep it', async () => {
  const { html } = await render('[a](javascript:alert(1)) [b](data:text/html,x) [c](vbscript:x) [d](https://example.com) [e](/wiki/x)');
  assert.doesNotMatch(html, /javascript:|data:|vbscript:/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /href="\/wiki\/x"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('images show only their alt text', async () => {
  const { html } = await render('![the alt text](https://example.invalid/x.png)');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /the alt text/);
});

test('a first heading that repeats the title is not rendered twice', async () => {
  const same = await render('# Test\n\nBody\n', 'Test');
  assert.doesNotMatch(same.html, /<h1/);
  const different = await render('# Other\n\nBody\n', 'Test');
  assert.match(different.html, /<h1/);
});

test('a table of contents appears from four headings', async () => {
  const few = await render('## A\n\n## B\n\n## C\n');
  assert.doesNotMatch(few.html, /class="toc"/);
  const many = await render('## A\n\n## B\n\n## C\n\n## D\n');
  assert.match(many.html, /class="toc"/);
  assert.match(many.html, /href="#a"/);
});

test('code blocks are highlighted on the server', async () => {
  const { html } = await render('```python\nprint("hi")\n```\n');
  assert.match(html, /hljs/);
});

test('the plain text leaves math out', async () => {
  const { plainText } = await render('Words about $\\frac{a}{b}$ limits.\n\n$$\n\\sum_i x_i\n$$\n');
  assert.match(plainText, /Words about/);
  assert.doesNotMatch(plainText, /frac|sum_i/);
});

test('firstHeading ignores headings inside code fences', () => {
  assert.equal(firstHeading('```\n# not this\n```\n\n# This one\n'), 'This one');
  assert.equal(firstHeading('no heading here'), null);
});
