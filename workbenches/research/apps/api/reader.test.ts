import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReader, readerCsp } from './reader.ts';
test('untrusted report HTML stays inert while Mermaid fences retain their render hook', () => {
  const html = renderReader({
    title: '<img src=x onerror=alert(1)>',
    document:
      '<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n```mermaid\nflowchart LR\nA-->B\n```',
  });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /class="language-mermaid"/);
  assert.match(html, /src="\/reader.js"/);
  assert.match(readerCsp, /sandbox/);
});

test('structured review findings remain visible even with a short model document', () => {
  const html = renderReader({
    title: 'Review',
    document: 'candidate',
    decision: 'revise',
    findings: [{ id: 'F1', location: 'diagram', issue: 'Explain the causal arrow <script>' }],
  });
  assert.match(html, /需要修订/);
  assert.match(html, /Explain the causal arrow &lt;script&gt;/);
  assert.match(html, /不代表用户接受/);
});
