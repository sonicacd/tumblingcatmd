import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectMarkdownForExport,
  iterateMarkdownExportChunks
} from '../src/markdown-export-chunks.js';

function lines(source) {
  const values = source.split('\n');
  return {
    lineCount: values.length,
    getLine: (lineNumber) => values[lineNumber - 1]
  };
}

test('chunked export keeps fenced code valid and carries reference definitions', async () => {
  const source = [
    '# Chapter',
    '',
    '```js',
    ...Array.from({ length: 30 }, (_, index) => `console.log(${index});`),
    '```',
    '',
    '![cover][image]',
    '',
    '[image]: https://example.com/cover.png'
  ].join('\n');
  const lineSource = lines(source);
  const inspected = await inspectMarkdownForExport(lineSource);
  const chunks = [];
  for await (const chunk of iterateMarkdownExportChunks(lineSource, {
    ...inspected,
    targetCharacters: 80,
    maximumBlockCharacters: 180
  })) {
    chunks.push(chunk);
  }

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.markdown.includes('[image]: https://example.com/cover.png')));
  assert.ok(chunks.filter((chunk) => chunk.markdown.includes('console.log')).every((chunk) => {
    const fences = chunk.markdown.match(/^```/gm) || [];
    return fences.length % 2 === 0;
  }));
});

test('chunk inspection and iteration honor cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    inspectMarkdownForExport(lines('one\ntwo'), { signal: controller.signal }),
    { name: 'AbortError' }
  );
});

test('HTML examples inside fenced code do not trigger the raw HTML size limit', async () => {
  const source = ['```html', '<div>', ...Array.from({ length: 20 }, () => 'code '.repeat(8)), '```', '', '# After'].join('\n');
  const chunks = [];
  for await (const chunk of iterateMarkdownExportChunks(lines(source), { targetCharacters: 80, maximumBlockCharacters: 180 })) chunks.push(chunk);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.filter((chunk) => chunk.markdown.includes('code ')).every((chunk) => chunk.markdown.startsWith('```html\n') && chunk.markdown.endsWith('\n```')));
  assert.ok(chunks.at(-1).markdown.endsWith('\n\n# After'));
});

test('fence-like lines with trailing text remain literal code across chunk boundaries', async () => {
  const source = ['```md', '```example', 'a'.repeat(60), '', 'b'.repeat(60), '```', '', '# After'].join('\n');
  const chunks = [];
  for await (const chunk of iterateMarkdownExportChunks(lines(source), { targetCharacters: 40, maximumBlockCharacters: 100 })) chunks.push(chunk);
  assert.ok(chunks.filter((chunk) => /a{60}|b{60}/.test(chunk.markdown)).every((chunk) => chunk.markdown.startsWith('```md\n') && chunk.markdown.endsWith('\n```')));
  assert.ok(chunks.at(-1).markdown.endsWith('\n\n# After'));
});

test('raw HTML keeps literal fence markers and still enforces its size limit', async () => {
  const html = '<pre>\n```\nexample\n</pre>';
  const chunks = [];
  for await (const chunk of iterateMarkdownExportChunks(lines(`${html}\n\n# After`), { targetCharacters: 10, maximumBlockCharacters: 50 })) chunks.push(chunk);
  assert.equal(chunks[0].markdown.trim(), html);
  assert.equal(chunks[1].markdown, '# After');
  await assert.rejects(async () => {
    for await (const chunk of iterateMarkdownExportChunks(lines(`<pre>\n${'code\n'.repeat(20)}</pre>`), { maximumBlockCharacters: 50 })) {
      assert.fail(`Oversized HTML must stay together: ${chunk.markdown}`);
    }
  }, /HTML/);
});
