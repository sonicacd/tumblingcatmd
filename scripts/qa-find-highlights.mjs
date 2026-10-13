// Isolated Edge checks for automatic find navigation and persistent highlights.
// npm install --prefix work/qa --no-package-lock --no-save playwright
// Optional suites: node scripts/qa-find-highlights.mjs desktop narrow large large-narrow edits short
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../work/qa/node_modules/playwright/index.mjs';

const outputDirectory = new URL('../work/qa/', import.meta.url);
await mkdir(outputDirectory, { recursive: true });
const server = await createServer({
  root: fileURLToPath(new URL('../', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../work/qa/.vite-find/', import.meta.url)),
  server: { host: '127.0.0.1', port: 1431, strictPort: true, hmr: false,
    watch: { ignored: ['**/src-tauri/**', '**/work/**'] } },
  optimizeDeps: { entries: ['index.html'], force: true }, clearScreen: false
});
const suites = new Set(process.argv.slice(2));
for (const suite of suites) {
  assert.ok(['desktop', 'narrow', 'large', 'large-narrow', 'edits', 'short'].includes(suite), `Unknown suite: ${suite}`);
}
const runSuite = name => suites.size === 0 || suites.has(name);
const resultFile = `find-highlights-results${suites.size ? `-${[...suites].join('-')}` : ''}.json`;
const checks = [], failures = [], errors = [], alerts = [];
const desktop = { width: 1280, height: 900 }, narrow = { width: 390, height: 760 };
const modes = ['wysiwyg', 'markdown', 'reader'];
const themes = ['eye', 'white', 'black'];
const settleTime = 1200; // Wait for view-position restoration to finish before starting a search.
let browser, appUrl, activePage;

function fixture(sectionCount, repetitions) {
  const first = Math.floor(sectionCount * 0.2), single = Math.floor(sectionCount * 0.5);
  const last = Math.floor(sectionCount * 0.8);
  return Array.from({ length: sectionCount }, (_, index) => {
    const markers = index === first ? 'FHFIRST FHMULTI 与 FHMULTI 结束。' :
      index === single ? 'FHSINGLE FHUNIQUE 结束。' : index === last ? 'FHLAST FHMULTI 结束。' : '';
    return `## 第 ${index} 节\n\n${markers}搜索跳转回归正文。` +
      '本段用于检查滚动位置，查找操作应保留全部原文。'.repeat(repetitions);
  }).join('\n\n') + '\n';
}

const ordinary = fixture(90, 6), large = fixture(7000, 6);
assert.ok(Buffer.byteLength(large, 'utf8') >= 2.5 * 1024 * 1024);

function selectors(mode, isLarge = false) {
  if (isLarge) return { root: '#largeFileEditor .cm-content', scroll: '#largeFileEditor .cm-scroller' };
  if (mode === 'reader') return { root: '#viewer', scroll: '#readerPanel' };
  const root = `.toastui-editor-${mode === 'markdown' ? 'md' : 'ww'}-container .ProseMirror`;
  return { root, scroll: root };
}

async function openFixture(content, name, viewport) {
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(20000);
  const page = await context.newPage(); activePage = page;
  page.on('pageerror', error => errors.push(error.stack));
  page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.dismiss(); });
  await page.addInitScript(({ content, name }) => {
    localStorage.setItem('rollcat-md.hide-startup-help', 'true');
    window.__findQA = { saved: null, saves: 0 };
    const handle = {
      kind: 'file', name,
      async getFile() { return new File([content], name); },
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async createWritable() {
        let pending;
        return {
          async write(value) { pending = await new Blob([value]).text(); },
          async close() { window.__findQA.saved = pending; window.__findQA.saves += 1; }
        };
      }
    };
    window.showOpenFilePicker = async () => [handle];
    window.showSaveFilePicker = async () => handle;
  }, { content, name });
  await page.goto(appUrl);
  await page.locator('.toastui-editor-ww-container .ProseMirror').waitFor({ state: 'visible' });
  await page.locator('#openButton').click();
  await page.waitForFunction(name => document.title.includes(name), name);
  await page.waitForTimeout(settleTime);
  if (viewport.width < 600 && await page.locator('#outlineToggle').getAttribute('aria-expanded') === 'true') {
    await page.locator('#outlineCloseButton').click();
  }
  console.log(`OPEN ${name}`);
  return { page, context };
}

async function changeMode(page, mode, isLarge) {
  if (await page.locator(`#${mode}Mode`).getAttribute('aria-pressed') !== 'true') {
    await expandMobileChrome(page);
    await page.locator(`#${mode}Mode`).click();
    await page.waitForFunction(mode => document.querySelector(`#${mode}Mode`).getAttribute('aria-pressed') === 'true', mode);
    await page.locator(selectors(mode, isLarge).root).waitFor({ state: 'visible' });
    await page.waitForTimeout(settleTime);
  }
}

async function expandMobileChrome(page) {
  const toggle = page.locator('#mobileChromeToggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') {
    await toggle.click();
  }
}

async function cursorAtEnd(page, mode, isLarge) {
  const { root, scroll } = selectors(mode, isLarge);
  if (mode !== 'reader' || isLarge) {
    await page.locator(root).evaluate(element => element.focus({ preventScroll: true }));
    await page.keyboard.press('Control+End');
  }
  await page.locator(scroll).evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(250);
  const position = await page.locator(scroll).evaluate(element => ({ top: element.scrollTop, height: element.clientHeight }));
  assert.ok(position.top > position.height, 'precondition: the viewport starts at the end of a long document');
}

async function openFind(page) {
  await page.keyboard.press('Control+f');
  await page.waitForFunction(() => document.activeElement === document.querySelector('#findInput'));
}

async function find(page, query, expectedCount) {
  await page.locator('#findInput').fill(query);
  await page.waitForFunction(count => document.querySelector('#findMatchCount').value === count, expectedCount);
  // Let the editor's scroll measurement run after the search transaction.
  await page.waitForTimeout(200);
}

// Inspect only rendered DOM and the browser's CSS Highlight registry.
// Large documents intentionally mount highlights only for the visible viewport.
async function highlightState(page, mode, isLarge) {
  return page.evaluate(({ root, scroll, useRegistry }) => {
    const content = document.querySelector(root), scroller = document.querySelector(scroll);
    const bounds = scroller.getBoundingClientRect();
    const visible = rect => rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, bounds.top) &&
      rect.top < Math.min(innerHeight, bounds.bottom) && rect.right > 0 && rect.left < innerWidth;
    const unobscured = rect => {
      if (!visible(rect)) return false;
      const left = Math.max(0, bounds.left, rect.left), right = Math.min(innerWidth, bounds.right, rect.right);
      const top = Math.max(0, bounds.top, rect.top), bottom = Math.min(innerHeight, bounds.bottom, rect.bottom);
      const element = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return Boolean(element && !element.closest('#findReplacePanel'));
    };
    const describeRange = range => ({
      text: range.toString(),
      owner: range.startContainer.parentElement?.closest('p, h1, h2, h3, li, pre, .cm-line')?.textContent || range.startContainer.parentElement?.textContent || '',
      visible: [...range.getClientRects()].some(visible),
      unobscured: [...range.getClientRects()].some(unobscured)
    });
    const describeElement = element => ({
      text: element.textContent,
      owner: element.closest('p, h1, h2, h3, li, pre, .cm-line')?.textContent || element.parentElement?.textContent || '',
      visible: [...element.getClientRects()].some(visible),
      unobscured: [...element.getClientRects()].some(unobscured),
      background: getComputedStyle(element).backgroundColor
    });
    const all = useRegistry ? [...(CSS.highlights?.get('rollcat-find') || [])].map(describeRange) :
      [...content.querySelectorAll('.find-match')].map(describeElement);
    const active = useRegistry ? [...(CSS.highlights?.get('rollcat-find-active') || [])].map(describeRange) :
      [...content.querySelectorAll('.find-match-active')].map(describeElement);
    return {
      all, active, focus: document.activeElement?.id, count: document.querySelector('#findMatchCount').value,
      modified: document.title.endsWith(' *'), top: scroller.scrollTop,
      registryStyle: useRegistry ? getComputedStyle(content, '::highlight(rollcat-find)').backgroundColor : null
    };
  }, { ...selectors(mode, isLarge), useRegistry: mode === 'reader' && !isLarge });
}

async function expectHighlights(page, mode, isLarge, { total, query, owner, focus = false, unchanged = true }) {
  const state = await highlightState(page, mode, isLarge);
  assert.equal(state.active.length, 1, `one active match: ${JSON.stringify(state)}`);
  assert.equal(state.active[0].text, query, `active highlight covers the exact matched text: ${JSON.stringify(state)}`);
  assert.ok(state.active[0].visible, `active match must be visible: ${JSON.stringify(state)}`);
  assert.ok(state.active[0].unobscured, `find panel must not cover the active match: ${JSON.stringify(state)}`);
  assert.ok(state.active[0].owner.includes(owner), `expected ${owner}: ${JSON.stringify(state)}`);
  if (isLarge) assert.ok(state.all.length >= (total === 3 && owner === 'FHFIRST' ? 2 : 1), `mounted matches must all be highlighted: ${JSON.stringify(state)}`);
  else assert.equal(state.all.length, total, `all matches must be highlighted: ${JSON.stringify(state)}`);
  assert.ok(state.all.every(item => item.text === query), `highlights must contain the query: ${JSON.stringify(state)}`);
  if (focus) assert.equal(state.focus, 'findInput', 'typing a query must retain input focus');
  if (unchanged) assert.equal(state.modified, false, 'search must not mark the document modified');
  if (mode === 'reader' && !isLarge) assert.ok(state.registryStyle && state.registryStyle !== 'rgba(0, 0, 0, 0)', 'reader highlights need visible styling');
  else assert.ok(state.all.every(item => item.background && item.background !== 'rgba(0, 0, 0, 0)'), 'every highlight needs visible styling');
}

async function expectCleared(page, mode, isLarge) {
  const state = await highlightState(page, mode, isLarge);
  assert.deepEqual(state.all, [], `all highlights should be removed: ${JSON.stringify(state)}`);
  assert.deepEqual(state.active, [], `active highlights should be removed: ${JSON.stringify(state)}`);
  assert.equal(state.count, '0 / 0');
}

async function check(label, run) {
  try {
    await run(); checks.push(label); console.log(`PASS ${label}`);
  } catch (error) {
    failures.push({ label, message: error.message }); console.error(`FAIL ${label}: ${error.message}`);
    if (failures.length <= 3) {
      await activePage?.screenshot({ path: fileURLToPath(new URL(`find-highlights-failure-${failures.length}.png`, outputDirectory)) }).catch(() => {});
    }
  }
}

async function basicSearchChecks(page, mode, isLarge, label) {
  if (await page.locator('#findReplacePanel').isVisible()) await page.locator('#closeFindButton').click();
  await changeMode(page, mode, isLarge);
  await cursorAtEnd(page, mode, isLarge);
  await openFind(page);
  await check(`${label}: query starts at first result and highlights all matches`, async () => {
    await find(page, 'FHMULTI', '1 / 3');
    await expectHighlights(page, mode, isLarge, { total: 3, query: 'FHMULTI', owner: 'FHFIRST', focus: true });
  });
  await check(`${label}: next, previous and wrap retain highlights`, async () => {
    for (const [key, count, owner] of [
      ['Enter', '2 / 3', 'FHFIRST'], ['Enter', '3 / 3', 'FHLAST'],
      ['Enter', '1 / 3', 'FHFIRST'], ['Shift+Enter', '3 / 3', 'FHLAST']
    ]) {
      await page.locator('#findInput').press(key);
      await page.waitForFunction(count => document.querySelector('#findMatchCount').value === count, count);
      await page.waitForTimeout(200);
      await expectHighlights(page, mode, isLarge, { total: 3, query: 'FHMULTI', owner, focus: true });
    }
  });
  await check(`${label}: single result jumps into view and stays highlighted`, async () => {
    await find(page, 'FHUNIQUE', '1 / 1');
    await expectHighlights(page, mode, isLarge, { total: 1, query: 'FHUNIQUE', owner: 'FHSINGLE', focus: true });
  });
  await check(`${label}: empty query and no matches remove highlights`, async () => {
    await find(page, '', '0 / 0');
    await expectCleared(page, mode, isLarge);
    await find(page, 'FHMULTI', '1 / 3');
    await find(page, 'FHNOSUCHRESULT', '0 / 0');
    await expectCleared(page, mode, isLarge);
    assert.equal(await page.locator('#findNextButton').isDisabled(), true);
    assert.equal(await page.locator('#findPreviousButton').isDisabled(), true);
  });
  await check(`${label}: closing find removes all highlights`, async () => {
    await find(page, 'FHMULTI', '1 / 3');
    await page.locator('#findInput').press('Escape');
    await page.locator('#findReplacePanel').waitFor({ state: 'hidden' });
    await expectCleared(page, mode, isLarge);
  });
}

async function savedText(page) {
  const previous = await page.evaluate(() => window.__findQA.saves);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(previous => window.__findQA.saves > previous, previous);
  return page.evaluate(() => window.__findQA.saved);
}

async function runSearchMatrix(suite, viewport, isLarge) {
  if (!runSuite(suite)) return;
  const content = isLarge ? large : ordinary;
  const { page, context } = await openFixture(content, `find-${suite}.md`, viewport);
  try {
    assert.equal(await page.locator('#largeFilePanel').getAttribute('aria-hidden'), String(!isLarge));
    const baseline = await savedText(page);
    for (const theme of themes) {
      await expandMobileChrome(page);
      await page.locator('#themeSelect').selectOption(theme);
      for (const mode of modes) {
        await basicSearchChecks(page, mode, isLarge, `${suite} ${theme} ${mode}`);
      }
    }
    await check(`${suite}: complete Markdown is unchanged after search and navigation`, async () => {
      assert.equal((await page.title()).endsWith(' *'), false);
      assert.equal(await savedText(page), baseline);
      assert.equal(baseline, content);
    });
  } finally {
    await context.close();
  }
}

async function runEditChecks(mode, isLarge) {
  const label = `${isLarge ? 'large' : 'ordinary'} ${mode}`;
  const { page, context } = await openFixture(isLarge ? large : ordinary, `find-edit-${label.replace(' ', '-')}.md`, desktop);
  try {
    await changeMode(page, mode, isLarge);
    await openFind(page);
    await find(page, 'FHMULTI', '1 / 3');
    await check(`${label}: replacement refreshes remaining and new matches`, async () => {
      await page.locator('#replaceInput').fill('FHREPLACED');
      await page.locator('#replaceButton').click();
      await page.waitForFunction(() => document.querySelector('#findMatchCount').value === '1 / 2');
      await page.waitForTimeout(200);
      await expectHighlights(page, mode, isLarge, { total: 2, query: 'FHMULTI', owner: 'FHFIRST', unchanged: false });
      await find(page, 'FHREPLACED', '1 / 1');
      await expectHighlights(page, mode, isLarge, { total: 1, query: 'FHREPLACED', owner: 'FHFIRST', unchanged: false });
      await find(page, 'FHMULTI', '1 / 2');
      await page.locator('#replaceAllButton').click();
      await page.waitForFunction(() => document.querySelector('#findMatchCount').value === '0 / 0');
      await expectCleared(page, mode, isLarge);
      await find(page, 'FHREPLACED', '1 / 3');
      await expectHighlights(page, mode, isLarge, { total: 3, query: 'FHREPLACED', owner: 'FHFIRST', unchanged: false });
    });
    if (mode !== 'reader') {
      await check(`${label}: editing with find open refreshes highlights without stealing focus`, async () => {
        await find(page, 'FHEDITED', '0 / 0');
        await page.locator(selectors(mode, isLarge).root).evaluate(element => element.focus({ preventScroll: true }));
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' FHEDITED');
        await page.waitForFunction(() => document.querySelector('#findMatchCount').value === '1 / 1');
        await page.waitForTimeout(250);
        const state = await highlightState(page, mode, isLarge);
        assert.equal(state.all.length, 1);
        assert.equal(state.active.length, 1);
        assert.equal(state.active[0].text, 'FHEDITED');
        assert.equal(state.focus, '', 'find refresh must leave the contenteditable focused');
        assert.equal(await page.locator(selectors(mode, isLarge).root).evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Control+z');
        await page.waitForFunction(() => document.querySelector('#findMatchCount').value === '0 / 0');
        await expectCleared(page, mode, isLarge);
      });
    }
  } finally {
    await context.close();
  }
}

async function runShortDocumentChecks(viewport) {
  const label = `${viewport.width}px short`;
  const content = 'FHSINGLE FHUNIQUE。FHFIRST FHMULTI 与 FHMULTI。\n';
  const { page, context } = await openFixture(content, `find-short-${viewport.width}.md`, viewport);
  try {
    for (const mode of modes) {
      await changeMode(page, mode, false);
      await openFind(page);
      await check(`${label} ${mode}: first-line single result is visible below find panel`, async () => {
        await find(page, 'FHUNIQUE', '1 / 1');
        await expectHighlights(page, mode, false, { total: 1, query: 'FHUNIQUE', owner: 'FHSINGLE', focus: true });
      });
      await check(`${label} ${mode}: all first-line matches remain visible below find panel`, async () => {
        await find(page, 'FHMULTI', '1 / 2');
        await expectHighlights(page, mode, false, { total: 2, query: 'FHMULTI', owner: 'FHFIRST', focus: true });
        const state = await highlightState(page, mode, false);
        assert.ok(state.all.every(match => match.visible && match.unobscured), JSON.stringify(state));
      });
      await page.locator('#closeFindButton').click();
    }
    await check(`${label}: search preserves the complete short document`, async () => {
      assert.equal(await savedText(page), content);
    });
  } finally {
    await context.close();
  }
}

try {
  await server.listen(); appUrl = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  await runSearchMatrix('desktop', desktop, false);
  await runSearchMatrix('narrow', narrow, false);
  await runSearchMatrix('large', desktop, true);
  await runSearchMatrix('large-narrow', narrow, true);
  if (runSuite('short')) {
    for (const viewport of [desktop, narrow]) await runShortDocumentChecks(viewport);
  }
  if (runSuite('edits')) {
    for (const isLarge of [false, true]) {
      for (const mode of modes) await runEditChecks(mode, isLarge);
    }
  }
  assert.deepEqual(errors, [], 'unexpected page errors');
  assert.deepEqual(alerts, [], 'unexpected dialogs');
} catch (error) {
  failures.push({ label: 'suite setup or harness', message: error.stack || error.message });
  throw error;
} finally {
  await writeFile(new URL(resultFile, outputDirectory), JSON.stringify({ checks, failures, errors, alerts }, null, 2));
  await Promise.allSettled([browser?.close(), server.close()]);
}
assert.deepEqual(failures, [], `Find-highlight checks failed; see work/qa/${resultFile}`);
console.log(JSON.stringify({ checks, failures, errors, alerts }, null, 2));
