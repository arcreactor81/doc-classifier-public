// The real rolling count may retain all animation digits; the harness must read the semantic progress bar.
import fs from 'node:fs';
import path from 'node:path';
import {startApp,launchEdgeProfile,REPO_ROOT} from '../ui-harness/app.mjs';
import {runScript} from '../ui-harness/evidence.mjs';
import {readReadingCount} from '../live-accuracy/reading.mjs';
import {readingProgress} from '../live-accuracy/plan.mjs';
await runScript('51-reading-progress','Semantic extraction progress with the real animated count',async({checks,evidence,defer})=>{
  const base=path.join(REPO_ROOT,'.local','qa','reading-progress');fs.mkdirSync(base,{recursive:true});
  const profile=fs.mkdtempSync(path.join(base,'profile-'));
  const app=await startApp({fake:null,cacheDir:path.join(profile,'vite-cache')});defer(()=>app.close());
  const browser=await launchEdgeProfile({userDataDir:profile});defer(()=>browser.close());
  await browser.context.route('**/__reading-progress.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body><main id="reading-lab"></main></body>'}));
  const page=browser.context.pages()[0];await page.goto(app.origin+'/__reading-progress.html');
  await page.evaluate(async urls=>{
    await import(urls.tokens);
    const {signal}=await import(urls.reactive),{mount,h}=await import(urls.dom),{count}=await import(urls.count);
    const value=signal(1);window.readingLab={value,dispose:mount(document.getElementById('reading-lab'),()=>
      h('section',null,h('b',{testid:'probe-number'},count(value)),h('div',{testid:'files-read-bar',attrs:{role:'progressbar','aria-valuenow':value,'aria-valuemax':60}})))};
    value.set(2);for(const a of document.getAnimations())a.pause();
  },{tokens:app.moduleUrl('ui/app/styles/tokens.css'),reactive:app.moduleUrl('core/ui/reactive.ts'),dom:app.moduleUrl('ui/app/view/dom.ts'),count:app.moduleUrl('ui/app/components/count.ts')});
  const raw=await page.getByTestId('probe-number').textContent(),read=await readReadingCount(page,60);
  evidence.animationText=raw;evidence.semanticCount=read;
  checks.check('the real count has overlapping animation text',Number(raw.replace(/[^0-9]/g,''))!==2,raw);
  checks.check('the harness reads exactly two files during the held animation',read===2,read);
  await page.evaluate(()=>{window.readingLab.value.set(42);for(const a of document.getAnimations())a.pause();});
  const next=await readReadingCount(page,60);checks.check('a later real value is read independently of the old digits',next===42,next);
  let state=readingProgress({read,now:0,stallMs:600000});state=readingProgress({read:next,now:480000,stallMs:600000,previous:state});
  checks.check('real progress refreshes the stall clock',!readingProgress({read:42,now:600001,stallMs:600000,previous:state}).stalled);
  checks.check('an actually unchanged semantic count still stops at the existing deadline',readingProgress({read:42,now:1080000,stallMs:600000,previous:state}).stalled);
  await page.getByTestId('files-read-bar').evaluate(el=>el.setAttribute('aria-valuenow','2012129090'));
  let refused=false;try{await readReadingCount(page,60);}catch(e){refused=/reading progress/.test(e.message);}
  checks.check('a corrupted semantic value is refused rather than treated as progress',refused);
});
