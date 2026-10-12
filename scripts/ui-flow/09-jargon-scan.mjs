/**
 * Click-through sweep, every-view group — script 09: jargon scan (owner rule 6).
 *
 * Every view of the every-view tour, in both themes at 1280 and 390 px: the rendered text outside
 * `[data-technical]` Details (dom.mjs `visibleText`) has none of the terms below. Each view is scanned as it is,
 * then again with every non-technical disclosure (`<details>` not inside `[data-technical]`) opened, so text a
 * person can open is scanned too; the disclosures are closed again afterwards. Visible or announced attribute
 * text (placeholder, title, alt, aria-label, …) is scanned as a separate check.
 *
 * Test data never contains these words (the synthetic corpus in opfs.mjs was checked: guides, slides, reports and
 * scanned forms about office tasks), so a hit is the app's own text or text it shows from the service.
 */
import { checkTour, eachVariant, tourEveryView } from './07-feedback-adjacency.mjs';
import { visibleText } from '../ui-harness/dom.mjs';
import { runScript } from '../ui-harness/evidence.mjs';

const SCRIPT = '09-jargon-scan';

export const JARGON = [
  ['manifest', /\bmanifests?\b/i],
  ['json', /\bjson\b/i],
  ['fingerprint', /\bfingerprints?\b/i],
  ['sidecar', /\bsidecars?\b/i],
  ['git', /\bgit\b/i],
  ['repository', /\brepositor(y|ies)\b/i],
  ['project pack', /\bproject[ -]packs?\b/i],
  ['pin', /\bpin(s|ned)?\b/i],
  ['workflow', /\bworkflows?\b/i],
  ['token', /\btokens?\b/i],
  ['http', /\bhttps?\b/i],
  ['inference', /\binferences?\b/i],
  ['uuid', /\buuids?\b/i],
  ['threshold', /\bthresholds?\b/i],
  ['noul', /\bnouls?\b/i],
  ['probability', /\bprobabilit(y|ies)\b/i],
  ['E_ error code', /\bE_[A-Z0-9_]+\b/],
  ['R0–R5 rule id', /\bR[0-5]n?\b/],
  ['raw identifier (uuid or 64-hex fingerprint)', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{64}\b/i]
];

export function jargonHits(text) {
  const hits = [];
  for (const line of text.split('\n')) {
    for (const [term, re] of JARGON) {
      const m = re.exec(line);
      if (m) hits.push({ term, match: m[0], line: line.slice(0, 200) });
    }
  }
  return hits;
}

/** Opens every closed non-technical <details> in main and the shell; returns the ones it opened (to close them). */
async function openDisclosures(page) {
  return page.evaluate(() => {
    const opened = [];
    document.querySelectorAll('details').forEach((details, index) => {
      if (details.open || details.closest('[data-technical]')) return;
      details.setAttribute('data-sweep-opened', String(index));
      details.open = true;
      opened.push(details.querySelector('summary')?.textContent.trim().slice(0, 60) ?? `details #${index}`);
    });
    return opened;
  });
}

async function closeDisclosures(page) {
  await page.evaluate(() => document.querySelectorAll('details[data-sweep-opened]').forEach(details => {
    details.open = false;
    details.removeAttribute('data-sweep-opened');
  }));
}

if (import.meta.main) {
  await runScript(SCRIPT, 'Owner rule 6: no Git, JSON, manifest, fingerprint, threshold, probability, token or code jargon in visible text (every view)',
    async ({ checks, evidence }) => {
      const perStation = {};
      const errorScans = {};
      const tour = await tourEveryView({
        label: SCRIPT,
        log: line => console.log(line),
        // The app's own error notices are scanned too: four person-started requests fail once (as in script 07).
        hooks: {
          injectErrors: true,
          async onInjectedError(name, { page }) {
            const shown = await visibleText(page);
            errorScans[name] = { hits: jargonHits(shown), attributeHits: jargonHits(await visibleText(page, { includeAttributes: true })),
              notice: (await page.locator('[data-feedback] .notice').first().textContent().catch(() => null))?.trim().slice(0, 300) ?? null };
          }
        },
        async visit(station, { page }) {
          perStation[station] = await eachVariant(page, async () => {
            const asShown = await visibleText(page);
            const opened = await openDisclosures(page);
            await page.waitForTimeout(150);
            const withOpened = opened.length ? await visibleText(page) : asShown;
            const attributes = await visibleText(page, { includeAttributes: true });
            await closeDisclosures(page);
            return { opened, hits: jargonHits(asShown), hitsOpened: jargonHits(withOpened),
              attributeHits: jargonHits(attributes).filter(hit => !jargonHits(withOpened).some(h => h.line === hit.line)),
              chars: asShown.length };
          });
        }
      });
      checkTour(checks, tour, evidence);
      evidence.errorScans = errorScans;
      for (const name of ['confirm-start', 'review-save', 'category-draft', 'compare-save']) {
        const scan = errorScans[name];
        checks.check(`error notice (${name}, injected): no jargon in the visible text outside Details`, Boolean(scan && scan.notice) && scan.hits.length === 0,
          scan ? { notice: scan.notice, hits: scan.hits } : 'not reached');
        checks.check(`error notice (${name}, injected): no jargon in visible or announced attribute text`, Boolean(scan) && scan.attributeHits.length === 0,
          scan ? scan.attributeHits : 'not reached');
      }
      evidence.terms = JARGON.map(([term, re]) => ({ term, pattern: String(re) }));
      evidence.perStation = perStation;
      const unique = list => [...new Map(list.map(hit => [`${hit.term}|${hit.line}`, hit])).values()];
      for (const [station, variants] of Object.entries(perStation)) {
        const tag = v => `${v.theme}@${v.width}`;
        const shown = unique(variants.flatMap(v => v.result.hits.map(hit => ({ ...hit, variant: tag(v) }))));
        checks.check(`${station}: no jargon in the visible text outside Details (1280 and 390, dark mode)`, shown.length === 0,
          shown.length ? shown : undefined);
        const opened = unique(variants.flatMap(v => v.result.hitsOpened.map(hit => ({ ...hit, variant: tag(v) }))))
          .filter(hit => !shown.some(s => s.line === hit.line && s.term === hit.term));
        checks.check(`${station}: no jargon in the text of its non-technical disclosures, opened`, opened.length === 0,
          opened.length ? { hits: opened, disclosures: variants[0].result.opened } : { disclosures: variants[0].result.opened });
        const attributes = unique(variants.flatMap(v => v.result.attributeHits.map(hit => ({ ...hit, variant: tag(v) }))));
        checks.check(`${station}: no jargon in visible or announced attribute text (placeholder, title, aria-label)`, attributes.length === 0,
          attributes.length ? attributes : undefined);
      }
    });
}
