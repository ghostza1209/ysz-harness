import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Md } from '../web/Md';

const html = (text: string) => renderToStaticMarkup(createElement(Md, { text }));

it('renders agent-written HTML as literal text, never as markup', () => {
  const out = html('Hi <script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<script'), out);
  assert.ok(!out.includes('<img'), out);
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), out);
});

it('drops a Markdown image, so opening a Ticket fetches nothing', () => {
  assert.equal(html('See ![chart](https://e.x/p.png) here'), '<div class="bl-md"><p>See  here</p></div>');
});

it('drops a javascript: link and opens a web link in a new tab with no Referer', () => {
  assert.ok(!html('[x](javascript:alert(1))').includes('javascript:'));
  assert.equal(html('PR opened: https://github.com/o/r/pull/1'), '<div class="bl-md"><p>PR opened: <a href="https://github.com/o/r/pull/1" target="_blank" rel="noreferrer">https://github.com/o/r/pull/1</a></p></div>');
});
