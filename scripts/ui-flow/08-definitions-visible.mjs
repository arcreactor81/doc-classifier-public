/**
 * Script 8 — category definitions visible during folder review (owner rule 7; REG "definitions visible during folder
 * review"; SPEC §3c step 1: "Right, sticky: the frozen definitions").
 *
 * A complete run (10 documents over four categories) is built into OPFS folders through the real Results → Make
 * folders screens (05-loop.mjs `builtRun`), two copies are moved, and Review folders is walked through its two
 * sub-steps: folder (chosen, before "Read my changes") and cards (the deck, one document at a time, since the owner's
 * decision of 6 October 2026). At 1280, 1100, 960, 640 and 540 px wide (900 px tall) each sub-step passes when the definitions
 * are visible in view — with the page at the top, or with the sub-step's own control scrolled into view (where the
 * person is working) — or are reachable directly: the first content after the h1, or a visible link to them in view.
 * "Visible" means a substantial part of at least one definition card (not only the section title) is inside the
 * viewport. Also: the definitions hold every category's "What belongs" and "What doesn't belong" at each sub-step,
 * and the page never scrolls sideways at these widths.
 * Evidence: .local/qa/ui-rebuild/08-definitions-visible.json and 08-definitions-visible-<step>-<width>.png (viewport).
 */
import { viteVersion } from '../ui-harness/app.mjs';
import { noHorizontalOverflow } from '../ui-harness/dom.mjs';
import { moveFile } from '../ui-harness/opfs.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';
import { builtRun, feedbackText, labelOf, sleep, slotButton, slotReady, until } from './05-loop.mjs';
import { settle } from './07-feedback-adjacency.mjs';

const SCRIPT = '08-definitions-visible';
const WIDTHS = [1280, 1100, 960, 640, 540];
const HEIGHT = 900;

/** Where the definitions are, measured in the page at the current scroll position. */
function measure() {
  const visible = el => Boolean(el) && (el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true);
  const visiblePart = el => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * (r.right > 0 && r.left < innerWidth ? 1 : 0);
  };
  const defs = document.querySelector('[data-testid="review-definitions"]');
  const cards = defs ? [...defs.querySelectorAll('[data-testid^="review-definition-"]')] : [];
  const cardInView = cards.some(card => visible(card) && visiblePart(card) >= Math.min(120, card.getBoundingClientRect().height));
  const main = document.querySelector('[data-testid="review"] .review__main');
  const first = main?.firstElementChild ?? null;
  const d = defs?.getBoundingClientRect() ?? null, f = first?.getBoundingClientRect() ?? null;
  const id = defs?.id || null;
  const links = [...document.querySelectorAll('#app a[href], #app button')]
    .filter(el => !el.closest('[data-testid="shell-topbar"], nav') && visible(el) && visiblePart(el) > 0)
    .filter(el => {
      const href = el.getAttribute('href') ?? '', controls = el.getAttribute('aria-controls') ?? '';
      return (id !== null && (href === `#${id}` || controls === id)) ||
        (defs !== null && href.startsWith('#') && !href.startsWith('#/') && defs.contains(document.getElementById(href.slice(1)))) ||
        /\b(definitions|your categories)\b/i.test(el.textContent ?? '');
    })
    .map(el => ({ tag: el.tagName.toLowerCase(), text: (el.textContent ?? '').trim().slice(0, 60), href: el.getAttribute('href') }));
  const layout = document.querySelector('[data-testid="review"] .review__layout');
  return {
    scrollY: Math.round(scrollY), viewport: { width: innerWidth, height: innerHeight },
    pageHeight: document.documentElement.scrollHeight,
    columns: layout ? getComputedStyle(layout).gridTemplateColumns : null,
    definitionsPosition: defs ? getComputedStyle(defs).position : null,
    definitionsTop: d ? Math.round(d.top + scrollY) : null,
    firstContentTop: f ? Math.round(f.top + scrollY) : null,
    firstContent: first?.getAttribute('data-testid') ?? first?.className ?? null,
    cardInView,
    firstAfterH1: d !== null && f !== null && d.top <= f.top + 1,
    links,
    cards: cards.length,
    cardsComplete: cards.filter(card => /What belongs here/.test(card.textContent ?? '') && /What doesn.t belong here/.test(card.textContent ?? '')).length
  };
}

await runScript(SCRIPT, 'Owner rule 7: category definitions visible during folder review (folder, cards) at five widths',
  async ({ checks, evidence, defer }) => {
    const { check } = checks;
    const ctx = await builtRun({ outcomes: { filed: 6, review: 3, failed: 1 }, label: 'defs', defer });
    const { fake, page, runId, sorted, docs, copyOf, typeIds, watch } = ctx;
    evidence.app = { origin: ctx.app.origin, vite: viteVersion, runId, typeIds, documents: docs.length, widths: WIDTHS, height: HEIGHT };

    // Two moves, as the person would make them in File Explorer.
    const filed = docs.find(doc => doc.rule === 'R1' && doc.folder === typeIds[0]);
    const review = docs.find(doc => doc.folder === 'human_review');
    await moveFile(page, `${sorted}/${copyOf(filed)}`, `${sorted}/${typeIds[1]}`);
    await moveFile(page, `${sorted}/${copyOf(review)}`, `${sorted}/${typeIds[2]}`);

    await (await slotReady(page, 'build-primary', /review/i)).click();
    await page.waitForSelector('[data-testid="review"]', { timeout: 20_000 });
    await until(async () => (await page.locator('[data-testid="review-definitions"] [data-testid^="review-definition-"]').count()) === typeIds.length,
      'the definition cards', 20_000).catch(() => {});

    const results = [];
    /** Measures one sub-step at every width: at the top of the page, and with `work` (the person's control) in view. */
    const atEveryWidth = async (step, work) => {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: HEIGHT });
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(300);
        const top = await page.evaluate(measure);
        const shot = await screenshot(page, `${SCRIPT}-${step}-${width}`, { fullPage: false });
        await page.locator(work).first().scrollIntoViewIfNeeded();
        await sleep(200);
        const working = await page.evaluate(measure);
        const workShot = working.scrollY !== top.scrollY ? await screenshot(page, `${SCRIPT}-${step}-${width}-working`, { fullPage: false }) : null;
        const overflow = await noHorizontalOverflow(page);
        const pass = top.cardInView || working.cardInView || top.firstAfterH1 || top.links.length > 0 || working.links.length > 0;
        results.push({ step, width, pass, top, working, overflow: { ok: overflow.ok, scrollWidth: overflow.scrollWidth, offenders: overflow.offenders },
          screenshots: [shot, workShot].filter(Boolean) });
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      await page.setViewportSize({ width: 1280, height: HEIGHT });
      await sleep(200);
    };
    const report = step => {
      const rows = results.filter(r => r.step === step);
      for (const r of rows) {
        check(`${step} sub-step at ${r.width} px: definitions in view, first after the h1, or linked directly`, r.pass, {
          columns: r.top.columns, position: r.top.definitionsPosition, definitionsTop: r.top.definitionsTop,
          firstContentTop: r.top.firstContentTop, pageHeight: r.top.pageHeight, inViewAtTop: r.top.cardInView,
          inViewWhileWorking: r.working.cardInView, workingScrollY: r.working.scrollY, links: [...r.top.links, ...r.working.links],
          screenshots: r.screenshots
        });
      }
      const complete = rows.every(r => r.top.cards === typeIds.length && r.top.cardsComplete === typeIds.length);
      check(`${step} sub-step: every category's definition (what belongs, what doesn't) is on the page at every width`, complete,
        rows.map(r => ({ width: r.width, cards: r.top.cards, complete: r.top.cardsComplete })));
    };

    // Sub-step 1: the folder (chosen; before "Read my changes").
    const useAgain = page.locator('[data-testid="review-folder"] button[data-op^="review:folder-use:"]');
    if (await useAgain.count()) await useAgain.click();
    else {
      ctx.picker.queue(sorted);
      await page.locator('[data-testid="review-folder"] button[data-op^="review:folder-choose:"]').click();
    }
    const readPrimary = await labelOf(await slotReady(page, 'review-primary', /read my changes/i));
    evidence.readPrimary = readPrimary;
    await atEveryWidth('folder', '[data-testid="review-primary"] button[data-op]');
    report('folder');

    // Sub-step 2: the cards (the folder read; one document at a time).
    await (await slotReady(page, 'review-primary', /read my changes/i)).click();
    await page.waitForSelector('[data-testid="review-cards"] [data-testid="review-card"]', { timeout: 60_000 });
    await until(async () => /save my review/i.test(await labelOf(slotButton(page, 'review-primary'))), 'Save my review', 20_000).catch(() => {});
    evidence.readFeedback = await feedbackText(page, '[data-testid="review-primary"] [data-feedback]');
    // The card and its evidence open with motion; the widths are measured once it has settled.
    await settle(page, { quiet: 500 });
    await atEveryWidth('cards', '[data-testid="review-cards"] [data-testid="review-card"]');
    report('cards');

    const overflowRows = results.filter(r => !r.overflow.ok);
    check('no horizontal overflow on Review folders at 1280, 1100, 960, 640 or 540 px (either sub-step)', overflowRows.length === 0,
      overflowRows.map(r => ({ step: r.step, width: r.width, scrollWidth: r.overflow.scrollWidth, offenders: r.overflow.offenders })));

    evidence.results = results;
    evidence.api = fake.requests.map(r => `${r.method} ${r.path} ${r.status}`);
    const writes = fake.requests.filter(r => r.method !== 'GET' && r.method !== 'HEAD');
    check('nothing was written to the server by looking at Review folders (no POST before Save my review)', writes.length === 0,
      writes.map(r => `${r.method} ${r.path}`));
    const record = watch.record;
    evidence.consoleErrors = record.consoleErrors;
    evidence.pageErrors = record.pageErrors;
    check('zero requests to any other origin', record.external.length === 0, record.external);
    check('no console errors and no uncaught page errors', record.consoleErrors.length === 0 && record.pageErrors.length === 0,
      { console: record.consoleErrors.slice(0, 5), page: record.pageErrors.slice(0, 5) });
    check('every API answer matched the wire contract (fake.problems empty)', fake.problems.length === 0, fake.problems);
  });
