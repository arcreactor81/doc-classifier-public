/**
 * Script 36 — DeepSeek's peak and off-peak price on Confirm (owner's option (a), 7 October 2026). Beside DeepSeek Flash,
 * and nowhere else, Confirm says which of DeepSeek's published prices applies now and until when, in the person's local
 * time, and adds once that Chinese public holidays are not tracked. Display only. The page clock starts at a known
 * instant and the browser runs in India's time zone (UTC+5:30), so local times differ from UTC:
 * - Friday 9 October 2026, 09:30 UTC (15:00 local): the peak price, until 15:30 (10:00 UTC);
 * - 31 minutes later, past 10:00 UTC, the line changes by itself: half price, until 06:30 on 12 Oct (Monday 01:00 UTC).
 * Evidence: .local/qa/ui-rebuild/38-deepseek-price-period.json and its screenshots.
 */
import {readFileSync} from 'node:fs';
import {createFakeApi} from '../ui-harness/fake-api.mjs';
import {startApp,openApp,pairClocks} from '../ui-harness/app.mjs';
import {corpus,opfsRoot,writeFolder} from '../ui-harness/opfs.mjs';
import {runScript,screenshot} from '../ui-harness/evidence.mjs';
import {until} from './05-loop.mjs';
import {confirmCopy} from '../../core/ui/copy-confirm.ts';
const SCRIPT='38-deepseek-price-period';
const PEAK='DeepSeek charges its full price now, until 15:30. This site counts every call at that price.';
const OFF_PEAK="DeepSeek charges half price now, until 06:30 on 12 Oct. This site still counts every call at the peak price, so its daily limit doesn't change.";
const HOLIDAYS="Chinese public holidays are half price all day; this site doesn't track them.";
await runScript(SCRIPT,'Confirm shows DeepSeek\'s current peak or off-peak price beside DeepSeek only, until when in local time, and keeps it current',async({checks,evidence,defer})=>{
 const {check}=checks,fake=createFakeApi();fake.categories(['procedures','explainers']);
 const owner=JSON.parse(readFileSync(new URL('../../projects/owner/project.json',import.meta.url),'utf8'));
 fake.state.seed={...owner,id:fake.state.seed.id,typeFile:fake.state.seed.typeFile,structuralVocabulary:[]};
 const app=await startApp({fake});defer(()=>app.close());
 const session=await openApp(app,{hash:null,contextOptions:{timezoneId:'Asia/Kolkata'}});defer(()=>session.close());
 const {page,picker,watch}=session;
 const clocks=await pairClocks(page,fake,{time:Date.parse('2026-10-09T09:30:00.000Z')});
 await page.goto(app.url('#/'));
 const root=opfsRoot('deepseek-price-period');await writeFolder(page,root,corpus(2));
 check('the wording is the owner\'s',confirmCopy.readerPricePeriod.deepseek.peak('15:30')===PEAK&&
  confirmCopy.readerPricePeriod.deepseek.offPeak(confirmCopy.readerPricePeriodUntil('06:30','12 Oct'))===OFF_PEAK&&confirmCopy.readerPricePeriod.deepseek.holidays===HOLIDAYS);
 await page.goto(app.url('#/new'));await page.waitForSelector('[data-testid="files"]');
 const localId=await page.evaluate(()=>location.hash.split('/')[2]);picker.queue(root);
 await page.locator(`button[data-op="files:choose-folder:${localId}"]`).click();
 await page.locator('[data-testid="files-primary"] [data-feedback][data-state="done"]').waitFor({timeout:30000});
 await page.locator('[data-testid="files-primary"] button').click();await page.waitForSelector('[data-testid="confirm-reader-option-deepseek"]');
 const lines=()=>page.locator('[data-testid^="confirm-reader-price-now"]');
 const lineOf=id=>page.locator(`[data-testid="confirm-reader-option-${id}"] [data-testid="confirm-reader-price-${id}"]`);
 const nowText=async()=>((await page.locator('[data-testid="confirm-reader-price-now-deepseek"]').textContent())??'').trim();
 const holidaysOnPage=async()=>((await page.locator('[data-testid="confirm"]').textContent())??'').split(HOLIDAYS).length-1;
 const browser=await page.evaluate(()=>({utc:new Date().toISOString(),local:new Date().toString(),zone:Intl.DateTimeFormat().resolvedOptions().timeZone}));
 evidence.browserClock=browser;
 check('the page clock reads Friday 9 October 2026, 09:30 UTC, in India\'s time zone',browser.utc.startsWith('2026-10-09T09:3')&&['Asia/Calcutta','Asia/Kolkata'].includes(browser.zone),browser);
 const others={};for(const id of ['standard','mini','qwen'])others[id]=await lineOf(id).count();
 evidence.atPeak={deepseek:await nowText(),others,lines:await lines().count(),holidays:await holidaysOnPage()};
 check('the price line sits beside DeepSeek Flash and beside no other reader',await lineOf('deepseek').count()===1&&Object.values(others).every(n=>n===0),evidence.atPeak);
 check('at 09:30 UTC on a Friday it is the peak price, until 15:30 local time (10:00 UTC)',await nowText()===PEAK,evidence.atPeak);
 check('the holiday sentence appears once, beside the line',await holidaysOnPage()===1&&
  ((await page.locator('[data-testid="confirm-reader-price-holidays-deepseek"]').textContent())??'').trim()===HOLIDAYS,evidence.atPeak);
 evidence.peakShot=await screenshot(page,SCRIPT+'-peak');
 // Choosing DeepSeek does not repeat the line: it stays once, beside the option.
 await page.locator(`button[data-op="confirm:reader:${localId}:deepseek"]`).click();
 await until(async()=>(await page.locator('[data-testid="confirm-reader-selected"]').textContent())==='DeepSeek Flash','DeepSeek chosen');
 check('with DeepSeek chosen the line and the holiday sentence still appear once',await lines().count()===1&&await holidaysOnPage()===1,{lines:await lines().count(),holidays:await holidaysOnPage()});
 // Past 10:00 UTC the minute clock moves the line on by itself.
 await clocks.fastForward(31*60_000);
 const offPeak=await until(async()=>{const text=await nowText();return text===OFF_PEAK?text:null;},'the off-peak line',20000).catch(async()=>nowText());
 evidence.offPeak={deepseek:offPeak,utc:await page.evaluate(()=>new Date().toISOString())};
 check('past 10:00 UTC on a Friday it is half price, until 06:30 on 12 Oct local time (Monday 01:00 UTC), without reloading',offPeak===OFF_PEAK,evidence.offPeak);
 evidence.offPeakShot=await screenshot(page,SCRIPT+'-off-peak');
 check('no request leaves the local app origin',watch.record.external.length===0,watch.record.external);
 check('no uncaught page errors or console errors',watch.record.pageErrors.length===0&&watch.record.consoleErrors.length===0,{pages:watch.record.pageErrors,console:watch.record.consoleErrors});
 check('the fixture stays within the real wire contracts',fake.problems.length===0,fake.problems);
 evidence.api=fake.requests.map(r=>({method:r.method,path:r.path,status:r.status}));
});
