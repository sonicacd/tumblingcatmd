// Isolated Edge regression checks for HTML lists embedded in Markdown tables.
// An optional local Markdown path exercises the same open/save flow in memory.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from '../work/qa/node_modules/playwright/index.mjs';

const table = (content) => `| Steps | Screenshot |\n| --- | --- |\n| ${content} | ![missing](images/missing.png) |\n`;
const list = '<ul><li>First **bold** [link](https://example.com/)</li><br><li>Second</li></ul>';
const fixture = `# HTML table lists\n\n${table(list).trimEnd()}\n` +
  '| <ol><li>Third</li><br/><br /><li>Fourth</li></ol> | Details |\n\nEnd marker\n';
const documents = [{ name: 'html-table-lists.md', source: fixture, synthetic: true }];
if (process.argv[2]) documents.push({ name: 'local-sample.md', source: await readFile(process.argv[2], 'utf8') });
await mkdir('work/qa', { recursive: true });
const server = await createServer({
  server: { host: '127.0.0.1', port: 1433, strictPort: true, hmr: false,
    watch: { ignored: ['**/src-tauri/**', '**/work/**'] } },
  optimizeDeps: { entries: ['index.html'], force: true }, clearScreen: false
});
const errors = [], alerts = [], checks = [];
function checked(message) { checks.push(message); console.log(`PASS ${message}`); }
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const document of documents) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.stack));
    page.on('dialog', async (dialog) => { alerts.push(dialog.message()); await dialog.dismiss(); });
    await page.addInitScript(({ source, name }) => {
      localStorage.setItem('rollcat-md.hide-startup-help', 'true');
      window.__qa = { saved: null, saves: 0 };
      window.showOpenFilePicker = async () => [{
        kind: 'file', name,
        getFile: async () => new File([source], name),
        queryPermission: async () => 'granted',
        createWritable: async () => ({
          async write(value) {
            window.__qa.saved = typeof value === 'string' ? value : new TextDecoder().decode(value);
          },
          async close() { window.__qa.saves++; }
        })
      }];
    }, document);
    await page.goto(server.resolvedUrls.local[0]);
    const wysiwyg = page.locator('.toastui-editor-ww-container [contenteditable="true"]');
    await wysiwyg.waitFor({ state: 'visible' });
    await page.locator('#openButton').click();
    await page.waitForFunction((name) => document.title.includes(name), document.name);
    assert.ok((await wysiwyg.innerText()).includes(document.source.match(/^# (.+)/m)[1]));
    if (document.synthetic) {
      assert.equal(await wysiwyg.locator('tbody tr').count(), 2);
      assert.equal(await wysiwyg.locator('li').count(), 4);
      assert.equal(await wysiwyg.locator('li strong').innerText(), 'bold');
      assert.equal(await wysiwyg.locator('li a').getAttribute('href'), 'https://example.com/');
    }
    checked(`${document.name}: opens with table and list content intact`);
    if (await page.locator('#outlineCloseButton').isVisible()) await page.locator('#outlineCloseButton').click();

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['black', 'white', 'eye']) {
        await page.locator('#themeSelect').selectOption(theme);
        for (const [mode, selector] of [
          ['markdown', '.toastui-editor-md-container [contenteditable="true"]'],
          ['reader', '#viewer'],
          ['wysiwyg', '.toastui-editor-ww-container [contenteditable="true"]']
        ]) {
          await page.locator(`#${mode}Mode`).click();
          await page.locator(selector).waitFor({ state: 'visible' });
          assert.ok((await page.locator(selector).innerText()).includes(document.source.match(/^# (.+)/m)[1]));
          if (document.synthetic && mode !== 'markdown') {
            assert.equal(await page.locator(selector).locator('li').count(), 4);
          }
        }
      }
      if (document.synthetic) await page.screenshot({ path: `work/qa/html-table-lists-${width}.png` });
      checked(`${document.name}: views and themes at ${width}px`);
    }
    const save = async () => {
      const saves = await page.evaluate(() => window.__qa.saves);
      await page.locator('#saveButton').click();
      await page.waitForFunction((previous) => window.__qa.saves > previous, saves);
      return page.evaluate(() => window.__qa.saved);
    };
    assert.equal(await save(), document.source, 'saving an unchanged document preserves its exact source');
    checked(`${document.name}: unchanged save preserves exact source`);

    if (document.synthetic) {
      await wysiwyg.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' edited');
      const edited = await save();
      assert.match(edited, /End marker edited/);
      for (const word of ['First', 'Second', 'Third', 'Fourth']) assert.ok(edited.includes(word));
      assert.match(edited, /<ul><li>/);
      assert.match(edited, /<ol><li>/);
      assert.match(edited, /\*\*bold\*\*/);
      checked('editing and saving retains both lists and inline formatting');

      const samples = {
        plain: '<ul><li>one</li><li>two</li></ul>',
        single: '<ul><li>one</li><br><li>two</li></ul>',
        multiple: '<ul><li>one</li><br/><br /><li>two</li></ul>',
        ordered: '<ol><li>one</li><br><li>two</li></ol>',
        edges: '<ul><br><li>one</li><br><li>two</li><br></ul>',
        nested: '<ul><li>outer<ul><li>one</li></ul></li><br><li>two</li></ul>',
        insideItem: '<ul><li>one<br>continued</li><br><li>two</li></ul>',
        paragraph: 'one<br>two'
      };
      const results = await page.evaluate(async (samples) => {
        const { default: Editor } = await import('/node_modules/@toast-ui/editor/dist/esm/index.js');
        const results = {};
        for (const [name, markdown] of Object.entries(samples)) {
          const el = document.body.appendChild(document.createElement('div'));
          const editor = new Editor({ el, initialEditType: 'wysiwyg', usageStatistics: false });
          try {
            editor.setMarkdown(markdown, false);
            editor.wwEditor.view.state.doc.check();
            const itemParagraphs = el.querySelector('.toastui-editor-ww-container li')?.querySelectorAll('p').length;
            const source = editor.getMarkdown();
            editor.setMarkdown(source, false);
            editor.wwEditor.view.state.doc.check();
            const rendered = el.querySelector('.toastui-editor-ww-container');
            results[name] = { source, text: rendered.innerText, items: rendered.querySelectorAll('li').length, itemParagraphs };
          } finally { editor.destroy(); el.remove(); }
        }
        return results;
      }, Object.fromEntries(Object.entries(samples).map(([name, content]) => [name, table(content)])));
      for (const [name, result] of Object.entries(results)) {
        assert.ok(result.text.includes('one') && result.text.includes('two'), name);
        assert.equal(result.items, name === 'paragraph' ? 0 : name === 'nested' ? 3 : 2, name);
        if (name === 'insideItem') {
          assert.ok(result.text.includes('continued'));
          assert.equal(result.itemParagraphs, 2, 'an internal break still opens a separate paragraph');
        }
      }
      checked('list separators and nested lists round-trip; internal and ordinary table breaks render');
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(alerts, []);
  await writeFile('work/qa/html-table-lists-results.json', JSON.stringify({ checks, errors, alerts }, null, 2));
  console.log(JSON.stringify({ checks, errors, alerts }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
