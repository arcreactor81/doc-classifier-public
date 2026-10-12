/**
 * Browser self-test of the UI harness on headless Edge (WP-11a). Not in the gate and not a flow script:
 *   node --test scripts/ui-harness/browser.selftest.mjs
 *
 * Proves on this PC that: the controlled folder picker returns OPFS folders and records the requested mode;
 * cancel, refusal and permission answers behave like the browser's; the repo's own extractor, running in Edge,
 * reads the synthetic DOCX, PPTX (excluding speaker notes) and PDF files, and reports the scanned PDF as
 * E_NO_TEXT_LAYER, with the same fingerprints Node computes; files can be moved and listed as a person would;
 * the DOM helpers see what they should; a harness network failure makes fetch reject without reaching the fake;
 * a held request is dropped unprocessed when the page reloads.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeApi } from './fake-api.mjs';
import {
  REPO_ROOT, failNetworkOnce, isAppFile, launchEdge, launchEdgeProfile, openApp, pairClocks, startApp, watchContext
} from './app.mjs';
import { corpus, installPicker, listFolder, makeFolder, moveFile, opfsRoot, readFile, removeEntry, writeFolder } from './opfs.mjs';
import { feedbackAdjacency, focusedElement, focusedTestId, noHorizontalOverflow, visibleText, watchMutations } from './dom.mjs';

let app, profile, context, page, picker, watch, fake;
const root = opfsRoot('selftest');
const files = corpus(4, { scanned: 1 });

before(async () => {
  fake = createFakeApi();
  fake.categories(['procedures', 'explainers']);
  app = await startApp({ fake });
  // A persistent profile: the handle-in-IndexedDB test below crashes an off-the-record context (see the canary).
  profile = await launchEdgeProfile({ viewport: { width: 1280, height: 900 } });
  context = profile.context;
  picker = await installPicker(context);
  watch = watchContext(context, { origin: app.origin });
  page = context.pages()[0] ?? await context.newPage();
  await page.goto(app.url('#/'));
  await page.waitForFunction(() => document.getElementById('app')?.childElementCount > 0);
});

after(async () => {
  await profile?.close();
  await app?.close();
});

test('OPFS folders and the controlled picker', async () => {
  const written = await writeFolder(page, `${root}/source`, [...files, { name: 'nested/Extra notes.docx', bytes: files[0].bytes }]);
  assert.equal(written.length, 5);
  picker.queue(`${root}/source`);
  const names = await page.evaluate(async () => {
    const dir = await window.showDirectoryPicker({ mode: 'read', id: 'source' });
    const out = [];
    for await (const [name, handle] of dir.entries()) out.push(`${handle.kind}:${name}`);
    return { names: out.sort(), permission: await dir.queryPermission({ mode: 'read' }), harness: window.showDirectoryPicker.__uiHarness === true };
  });
  assert.deepEqual(names.names, ['directory:nested', ...files.map(f => `file:${f.name}`)].sort());
  assert.equal(names.permission, 'granted');
  assert.equal(names.harness, true);
  assert.equal(picker.calls[0].mode, 'read');
  assert.equal(picker.calls[0].id, 'source');

  const refusals = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 2; i++) {
      try { await window.showDirectoryPicker({ mode: 'readwrite' }); out.push('resolved'); } catch (error) { out.push(error.name); }
    }
    return out;
  });
  assert.deepEqual(refusals, ['AbortError', 'AbortError'], 'nothing queued means the person cancelled');
  picker.cancel().fail('NotAllowedError', 'Permission was not granted.');
  const queued = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 2; i++) {
      try { await window.showDirectoryPicker({ mode: 'readwrite' }); out.push('resolved'); } catch (error) { out.push(error.name); }
    }
    return out;
  });
  assert.deepEqual(queued, ['AbortError', 'NotAllowedError']);
  assert.equal(picker.calls.filter(call => call.mode === 'readwrite').length, 4);

  picker.permission = 'prompt';
  picker.queue(`${root}/source`);
  const asked = await page.evaluate(async () => {
    const dir = await window.showDirectoryPicker();
    return [await dir.queryPermission({ mode: 'readwrite' }), await dir.requestPermission({ mode: 'readwrite' })];
  });
  assert.deepEqual(asked, ['prompt', 'prompt']);
  assert.deepEqual(picker.permissionCalls.map(c => `${c.op}:${c.mode}`).slice(-2), ['queryPermission:readwrite', 'requestPermission:readwrite']);
  picker.permission = null;

  // Handles survive a structured clone into IndexedDB (the app stores them) and a reload.
  picker.queue(`${root}/source`);
  await page.evaluate(async () => {
    const dir = await window.showDirectoryPicker();
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('ui-harness-selftest', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('handles');
      open.onsuccess = () => {
        const tx = open.result.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(dir, 'source');
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
  });
  await page.reload();
  const reopened = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('ui-harness-selftest', 1);
    open.onsuccess = () => {
      const request = open.result.transaction('handles').objectStore('handles').get('source');
      request.onsuccess = async () => { open.result.close(); resolve(request.result?.name ?? null); };
      request.onerror = () => reject(request.error);
    };
    open.onerror = () => reject(open.error);
  }));
  assert.equal(reopened, 'source');
});

test('the repo extractor reads the synthetic files in Edge, with the fingerprints Node computed', async () => {
  picker.queue(`${root}/source`);
  const results = await page.evaluate(async ({ extractUrl, workerUrl }) => {
    const { extractDocument } = await import(extractUrl);
    const dir = await window.showDirectoryPicker({ mode: 'read' });
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      try {
        const doc = await extractDocument(await handle.getFile(), {
          pdfWorkerUrl: workerUrl,
          pdfPolicy: { largeFontRatio: 1.2, maximumHeadingCharacters: 120, topPageFraction: 0.2, gapRatio: 1.5, minimumHeadings: 3 },
          parserVersions: { zip: '2.17.0', xml: '5.11.1', pdf: '6.3.289' }
        });
        out.push({ name, ok: true, fingerprint: doc.fingerprint, fullText: doc.fullText, headings: doc.outline.headings.map(h => h.text),
          needsOutlineRecovery: doc.needsOutlineRecovery });
      } catch (error) {
        out.push({ name, ok: false, code: error.code ?? null, message: error.message });
      }
    }
    return out;
  }, { extractUrl: app.moduleUrl('core/extraction/extract.ts'), workerUrl: app.moduleUrl('node_modules/pdfjs-dist/build/pdf.worker.min.mjs') });
  const byName = Object.fromEntries(results.map(r => [r.name, r]));
  for (const file of files) {
    const result = byName[file.name];
    assert.ok(result, `extracted ${file.name}`);
    if (!file.readable) {
      assert.deepEqual([result.ok, result.code], [false, 'E_NO_TEXT_LAYER'], JSON.stringify(result));
      continue;
    }
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.fingerprint, file.fingerprint);
    for (const quote of file.quotes) assert.ok(result.fullText.includes(quote), `${file.name} text holds "${quote}"`);
  }
  const pdf = byName[files[2].name];
  assert.ok(pdf.fullText.startsWith('[Page 1]'));
  assert.deepEqual(pdf.headings, ['Report 3: ordering supplies', 'Findings', 'Next steps']);
  assert.equal(pdf.needsOutlineRecovery, false);
  assert.ok(!byName[files[1].name].fullText.includes('Speaker note'));
});

test('files move and list the way a person would change them', async () => {
  await writeFolder(page, `${root}/sorted/procedures`, [{ name: 'r1-0001--Guide 01.docx', bytes: files[0].bytes }]);
  await makeFolder(page, `${root}/sorted/explainers`);
  const moved = await moveFile(page, `${root}/sorted/procedures/r1-0001--Guide 01.docx`, `${root}/sorted/New folder`);
  assert.equal(moved, `${root}/sorted/New folder/r1-0001--Guide 01.docx`);
  assert.deepEqual((await listFolder(page, `${root}/sorted`)).map(f => f.path), ['New folder/r1-0001--Guide 01.docx']);
  const b64 = await readFile(page, moved, { base64: true });
  assert.equal(Buffer.from(b64, 'base64').length, files[0].bytes.length);
  await removeEntry(page, `${root}/sorted`);
  await assert.rejects(listFolder(page, `${root}/sorted`));
});

test('the extraction Worker reads CJK text using the shipped PDF assets', async () => {
  // A font with a predefined CMap, as in core/extraction/pdf.test.ts. No font program is embedded.
  const content = 'BT /F1 12 Tf 72 700 Td <65E5672C> Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 7 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>'
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const start = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const result = await page.evaluate(async ({ pdf, workerUrl, pdfWorkerUrl, optionsUrl }) => {
    const { extractOptions } = await import(optionsUrl);
    const options = extractOptions({ pdfPolicy: { largeFontRatio: 1.2, maxHeadingCharacters: 120, topPageFraction: 0.2, gapRatio: 1.5 }, recoveryMinimumHeadings: 2 }, pdfWorkerUrl);
    const font = await fetch(`${options.pdfStandardFontDataUrl}LiberationSans-Regular.ttf`);
    if (!font.ok || font.headers.get('content-type') !== 'font/ttf') throw new Error('The standard PDF font is not served as a font.');
    const worker = new Worker(workerUrl, { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The CJK reading did not finish.')), 30_000);
        worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
        worker.postMessage({ id: 1, file: new File([pdf], 'synthetic.pdf'), options });
      });
    } finally { worker.terminate(); }
  }, { pdf, workerUrl: app.moduleUrl('core/extraction/worker.ts'),
    pdfWorkerUrl: app.moduleUrl('node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),
    optionsUrl: app.moduleUrl('core/ui/extraction-plan.ts') });
  assert.equal(result.failure, undefined, JSON.stringify(result));
  assert.equal(result.document.fullText, '[Page 1]\n\u65e5\u672c');
  assert.deepEqual(result.document.notes, []);
});

test('DOM helpers', async () => {
  await page.evaluate(() => {
    const fixture = document.createElement('section');
    fixture.id = 'fixture';
    const action = (id, message) => {
      const wrap = document.createElement('div');
      wrap.className = 'action';
      wrap.dataset.action = id;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.op = id;
      button.textContent = `Button ${id}`;
      button.setAttribute('aria-describedby', `${id}-fb`);
      const slot = document.createElement('div');
      slot.className = 'feedback';
      slot.id = `${id}-fb`;
      slot.dataset.feedback = id;
      const status = document.createElement('div');
      status.className = 'feedback__status';
      status.textContent = message;
      slot.append(status);
      wrap.append(button, slot);
      return wrap;
    };
    const good = action('good:op', 'Saved at 10:21.');
    good.querySelector('button').dataset.primary = '';
    good.querySelector('button').dataset.testid = 'good-button';
    const bad = action('bad:op', '');
    bad.append(document.createElement('p'));
    const technical = document.createElement('details');
    technical.open = true;
    technical.dataset.technical = '';
    technical.textContent = 'fingerprint e3b0c442';
    const hidden = document.createElement('p');
    hidden.hidden = true;
    hidden.textContent = 'hidden words';
    const wide = document.createElement('div');
    wide.id = 'wide';
    wide.style.setProperty('width', '3000px');
    wide.textContent = 'Plain words stay.';
    const input = document.createElement('input');
    input.placeholder = 'Search documents';
    fixture.append(good, bad, technical, hidden, wide, input);
    document.body.append(fixture);
    good.querySelector('button').focus();
  });
  // The fixture is beside the running app, which has its own primary action.
  const adjacency = await feedbackAdjacency(page, { root: '#fixture' });
  const good = adjacency.buttons.find(b => b.id === 'good:op'), bad = adjacency.buttons.find(b => b.id === 'bad:op');
  assert.deepEqual([good.ok, good.lastIsFeedback, good.slotAfterButton, good.slotBelowButton, good.messages, good.describedByResolves],
    [true, true, true, true, 1, true]);
  assert.deepEqual([bad.ok, bad.lastIsFeedback], [false, false]);
  assert.equal(adjacency.primaryCount, 1);
  const text = await visibleText(page, { root: '#fixture' });
  assert.ok(text.includes('Plain words stay.') && text.includes('Saved at 10:21.'));
  assert.ok(!text.includes('fingerprint') && !text.includes('hidden words'));
  assert.ok((await visibleText(page, { root: '#fixture', excludeTechnical: false })).includes('fingerprint'));
  assert.ok((await visibleText(page, { root: '#fixture', includeAttributes: true })).includes('Search documents'));
  const overflow = await noHorizontalOverflow(page);
  assert.equal(overflow.ok, false);
  assert.ok(overflow.offenders.some(o => o.element.startsWith('div#wide') || o.element.startsWith('section#fixture')));
  assert.equal(await focusedTestId(page), 'good-button');
  assert.equal((await focusedElement(page)).op, 'good:op');

  const mutations = await watchMutations(page, { root: '#fixture' });
  await page.evaluate(() => {
    document.querySelector('#fixture .feedback__status').textContent = 'Saved at 10:22.';
    document.querySelector('#wide').remove();
    document.querySelector('#fixture input').setAttribute('aria-label', 'Search');
  });
  const records = await mutations.stop();
  const summary = mutations.summarize(records);
  assert.equal(summary.removedNodes, 2, 'the replaced text node and the removed element');
  assert.equal(summary.attributeChanges, 1);
  assert.ok(records.some(r => r.target?.testid === null && r.type === 'childList'));
  await page.evaluate(() => document.getElementById('fixture').remove());
  assert.equal((await noHorizontalOverflow(page)).ok, true);
});

test('a harness network failure rejects fetch without reaching the fake; the next request works', async () => {
  const before = fake.requests.length;
  await failNetworkOnce(context, fake, { method: 'GET', path: '/api/health' });
  const outcomes = await page.evaluate(async () => {
    const out = [];
    for (let i = 0; i < 2; i++) {
      try { out.push((await fetch('/api/health', { credentials: 'same-origin' })).status); } catch (error) { out.push(error.name); }
    }
    return out;
  });
  assert.deepEqual(outcomes, ['TypeError', 200]);
  const recorded = fake.requests.slice(before);
  assert.deepEqual(recorded.map(r => [r.path, r.network ?? null, r.status]), [['/api/health', 'aborted-by-harness', 0], ['/api/health', null, 200]]);
});

test('canary (recorded, not asserted): a handle read back from IndexedDB in an off-the-record context', async t => {
  const browser = await launchEdge();
  let disconnected = false;
  browser.on('disconnected', () => { disconnected = true; });
  const otr = await browser.newContext();
  const otrPage = await otr.newPage();
  await otrPage.goto(app.url('#/'));
  let outcome;
  try {
    outcome = await otrPage.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('ui-harness-canary', { create: true });
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open('ui-harness-canary', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('h');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise((resolve, reject) => { const tx = db.transaction('h', 'readwrite'); tx.objectStore('h').put(dir, 'k'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      return new Promise((resolve, reject) => { const r = db.transaction('h').objectStore('h').get('k'); r.onsuccess = () => resolve(r.result?.name ?? null); r.onerror = () => reject(r.error); });
    });
  } catch (error) {
    outcome = `failed: ${String(error.message).split('\n')[0]}`;
  }
  t.diagnostic(`off-the-record context, Edge ${browser.version()}: ${disconnected ? 'the browser crashed' : `read back "${outcome}"`}`);
  await browser.close().catch(() => {});
});

test('openApp (persistent profile, picker, watcher) and paired clocks', async () => {
  const opened = await openApp(app, { hash: null, viewport: { width: 390, height: 844 } });
  try {
    const time = Date.parse('2026-09-25T14:02:31.000Z');
    const clocks = await pairClocks(opened.page, fake, { time });
    await opened.page.goto(app.url('#/'));
    const skew = async () => Math.abs((await opened.page.evaluate(() => Date.now())) - fake.now());
    assert.ok(fake.now() >= time && fake.now() < time + 10_000);
    assert.ok(await skew() < 1_000, `clock skew ${await skew()} ms`);
    await clocks.fastForward(30_000);
    const pageNow = await opened.page.evaluate(() => Date.now());
    assert.ok(pageNow >= time + 30_000 && pageNow < time + 40_000, String(pageNow - time));
    assert.ok(await skew() < 1_000, `clock skew after fastForward ${await skew()} ms`);
    assert.equal(await opened.page.evaluate(() => window.showDirectoryPicker.__uiHarness === true), true);
    assert.equal(opened.watch.record.consoleErrors.length, 0, JSON.stringify(opened.watch.record.consoleErrors));
    assert.equal((await opened.page.evaluate(() => innerWidth)), 390);
  } finally {
    await opened.close();
    fake.clock.useRealTime();
  }
});

test('app modules under /api/ are served by Vite, never answered by the fake', async () => {
  // With root ui/app, WP-5's ui/app/api/*.ts modules are requested as /api/<file>.ts. A scratch root (under the
  // ignored .local/) stands in for ui/app, so this holds before those files exist.
  // A fixed path, so Vite's dependency cache for this root is reused on later runs; removed afterwards.
  const scratch = path.join(REPO_ROOT, '.local', 'ui-harness-selftest-root');
  rmSync(scratch, { recursive: true, force: true });
  const second = createFakeApi();
  let otherApp, browser;
  try {
    mkdirSync(path.join(scratch, 'api'), { recursive: true });
    writeFileSync(path.join(scratch, 'index.html'),
      '<!doctype html><html lang="en"><head><link rel="icon" href="data:,"></head><body><div id="app"></div>' +
      '<script type="module" src="./main.ts"></script></body></html>\n');
    writeFileSync(path.join(scratch, 'api', 'probe.ts'), 'export const probe: string = \'module loaded\';\n');
    writeFileSync(path.join(scratch, 'main.ts'), 'import { probe } from \'./api/probe.ts\';\n' +
      'const health = await fetch(\'/api/health\');\n' +
      '(window as unknown as { __probe: unknown }).__probe = { probe, health: health.status };\n');
    assert.equal(isAppFile('/api/probe.ts?import', scratch), true);
    assert.equal(isAppFile('/api/health', scratch), false);
    assert.equal(isAppFile('/api/../../package.json', scratch), false);
    // Its own dependency cache (kept between runs), so the real root's cache is not rebuilt for another root.
    otherApp = await startApp({ fake: second, root: scratch, cacheDir: path.join(os.tmpdir(), 'doc-classifier-ui-harness-vite-selftest') });
    browser = await launchEdge();
    const otr = await browser.newContext();
    const seen = watchContext(otr, { origin: otherApp.origin, root: otherApp.root });
    const probePage = await otr.newPage();
    await probePage.goto(otherApp.url('#/'));
    // The first run pre-bundles the extraction dependencies into that cache, which can take a while.
    const result = await probePage.waitForFunction(() => window.__probe, null, { timeout: 90_000 }).then(handle => handle.jsonValue());
    assert.deepEqual(result, { probe: 'module loaded', health: 200 });
    assert.deepEqual(second.requests.map(r => `${r.method} ${r.path}`), ['GET /api/health'], 'the fake saw only the API call');
    assert.deepEqual(seen.apiRequests(), ['GET /api/health']);
    assert.ok(seen.record.requests.some(r => new URL(r.url).pathname === '/api/probe.ts'), 'the module was requested');
    assert.deepEqual([seen.record.consoleErrors, seen.record.pageErrors], [[], []]);
  } finally {
    await browser?.close();
    await otherApp?.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('a held request is dropped unprocessed when the page reloads', async () => {
  const hold = fake.hold({ method: 'POST', path: '/api/kill' });
  await page.evaluate(() => { void fetch('/api/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' }).catch(() => {}); });
  for (let i = 0; i < 50 && hold.waiting === 0; i++) await page.waitForTimeout(20);
  assert.equal(hold.waiting, 1);
  await page.reload();
  await page.waitForTimeout(100);
  hold.release();
  await new Promise(resolve => setTimeout(resolve, 100));
  const [held] = hold.requests;
  assert.equal(held.dropped, true, 'the server never processed it');
  assert.equal(fake.state.controls.kill, false);
  assert.equal(watch.record.external.length, 0);
  assert.deepEqual(fake.problems, []);
});


test('retained keyed rows keep live reads after reorder and filtering until each row leaves', async () => {
  const result = await page.evaluate(async ({ domUrl, reactiveUrl }) => {
    const { mount, h, each } = await import(domUrl);
    const { signal, computed, onCleanup } = await import(reactiveUrl);
    const host = document.createElement('div');
    document.body.append(host);
    const keys = signal(['a', 'b']);
    const values = { a: signal('waiting'), b: signal('waiting'), c: signal('waiting') };
    const disposed = [];
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    const rows = () => [...host.querySelectorAll('[data-key]')].map(el => [el.dataset.key, el.textContent]);
    const stop = mount(host, () => each(keys, key => {
      onCleanup(() => disposed.push(key));
      return computed(() => values[key]());
    }, (read, key) => h('span', { attrs: { 'data-key': key } }, read)));
    try {
      await settle();
      const originalA = host.querySelector('[data-key="a"]');
      keys.set(['b', 'a']); await settle();
      values.a.set('right'); await settle();
      const reordered = { rows: rows(), disposed: [...disposed], sameA: host.querySelector('[data-key="a"]') === originalA };
      keys.set(['a']); await settle();
      values.a.set('confirmed'); await settle();
      const filtered = { rows: rows(), disposed: [...disposed], sameA: host.querySelector('[data-key="a"]') === originalA };
      keys.set(['a', 'c']); await settle();
      values.a.set('complete'); values.c.set('right'); await settle();
      const added = rows();
      stop();
      return { reordered, filtered, added, disposed: [...disposed].sort() };
    } finally { stop(); host.remove(); }
  }, { domUrl: app.moduleUrl('ui/app/view/dom.ts'), reactiveUrl: app.moduleUrl('core/ui/reactive.ts') });
  assert.deepEqual(result.reordered, { rows: [['b', 'waiting'], ['a', 'right']], disposed: [], sameA: true });
  assert.deepEqual(result.filtered, { rows: [['a', 'confirmed']], disposed: ['b'], sameA: true });
  assert.deepEqual(result.added, [['a', 'complete'], ['c', 'right']]);
  assert.deepEqual(result.disposed, ['a', 'b', 'c']);
});
