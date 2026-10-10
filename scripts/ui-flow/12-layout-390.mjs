/**
 * Click-through sweep, every-view group — script 12: layout at 390 px (owner rule 12).
 *
 * Every view of the every-view tour (07's `tourEveryView`), in dark mode: no horizontal overflow at 390 px
 * (dom.mjs `noHorizontalOverflow`: the page does not scroll sideways, and nothing sticks out past the right edge
 * outside a horizontally scrolling container), and a full-page screenshot at 1280 and at 390 px.
 * The 1280 px pass is checked for overflow too. Screenshots: .local/qa/ui-rebuild/12-<station>-<theme>-<width>.png.
 */
import { checkTour, eachVariant, tourEveryView, THEMES, WIDTHS } from './07-feedback-adjacency.mjs';
import { noHorizontalOverflow } from '../ui-harness/dom.mjs';
import { runScript, screenshot } from '../ui-harness/evidence.mjs';

const SCRIPT = '12-layout-390';

await runScript(SCRIPT, 'Owner rule 12: no horizontal overflow at 390 px; dark screenshots at 1280 and 390 (every view)',
  async ({ checks, evidence }) => {
    const perStation = {};
    const tour = await tourEveryView({
      label: SCRIPT,
      log: line => console.log(line),
      async visit(station, { page }) {
        perStation[station] = await eachVariant(page, async ({ theme, width }) => {
          const overflow = await noHorizontalOverflow(page);
          const shot = await screenshot(page, `${SCRIPT}-${station}-${theme}-${width}`);
          return { ...overflow, screenshot: shot };
        });
      }
    });
    checkTour(checks, tour, evidence);
    evidence.perStation = perStation;
    evidence.screenshots = Object.values(perStation).flat().map(v => v.result.screenshot);
    for (const [station, variants] of Object.entries(perStation)) {
      for (const width of [390, 1280]) {
        const bad = variants.filter(v => v.width === width && !(v.result.ok && v.result.offenders.length === 0))
          .map(v => ({ theme: v.theme, scrollWidth: v.result.scrollWidth, width: v.result.width, offenders: v.result.offenders,
            screenshot: v.result.screenshot }));
        checks.check(`${station}: no horizontal overflow at ${width} px (dark mode)`, bad.length === 0, bad.length ? bad : undefined);
      }
    }
    const expected = tour.reached.length * THEMES.length * WIDTHS.length;
    checks.check('a screenshot of every reached view in each supported theme and width', evidence.screenshots.length === expected,
      { screenshots: evidence.screenshots.length, expected });
  });
