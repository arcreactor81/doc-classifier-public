/** Long names in Results keep their file type visible and their full filename accessible. */
import { startApp, openApp } from '../ui-harness/app.mjs';
import { createFakeApi } from '../ui-harness/fake-api.mjs';
import { corpus } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

await runScript('47-results-filenames', 'Results preserve file types at narrow and wide widths', async ({ checks, evidence, defer }) => {
  const fake = createFakeApi();
  const files = corpus(3).map(file => ({ ...file, name: 'A long document name for the results table ' + file.name }));
  const { runId } = fake.completed({ files });
  const app = await startApp({ fake }); defer(() => app.close());
  const session = await openApp(app, { hash: '#/run/' + runId + '/results' }); defer(() => session.close());
  const { page, watch } = session;
  await page.locator('.results-table .c-doc .ext').first().waitFor();
  for (const width of [1280, 760, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const rows = await page.locator('.results-table .c-doc').evaluateAll(cells => cells.map(cell => {
      const link = cell.querySelector('a'), ext = cell.querySelector('.ext');
      const box = cell.getBoundingClientRect(), badge = ext.getBoundingClientRect();
      return { name: link.textContent, title: link.title, type: ext.textContent,
        inside: badge.right <= box.right && badge.left >= box.left && badge.width > 0 };
    }));
    checks.check('every file type remains within its document cell at ' + width + 'px',
      rows.length === files.length && rows.every(r => r.inside), rows);
    checks.check('the entire name is available without opening the row at ' + width + 'px',
      rows.every(r => r.title === r.name && files.some(file => file.name === r.name) && r.name.toUpperCase().endsWith('.' + r.type)), rows);
    if (width === 1280) {
      await page.locator('.results-table').scrollIntoViewIfNeeded();
      evidence.desktop = await screenshot(page, '47-results-filenames-desktop', { fullPage: false });
    }
  }
  checks.check('viewing the files sends no writes and opens no external service', fake.requests.every(r => r.method === 'GET' || r.method === 'HEAD') &&
    watch.record.external.length === 0 && watch.record.pageErrors.length === 0);
});
