/**
 * Script 35 — the version behind DeepSeek Flash (owner, 7 October 2026: record the version, never refuse). DeepSeek moves
 * `deepseek-flash` forward to newer versions and its replies name only that id, so when a DeepSeek run first starts the
 * service reads DeepSeek's model list once and records the version it lists. The run's facts show it beside the reader:
 * "DeepSeek Flash: DeepSeek-V4.1-Flash when this run started", and Details keeps the record. When the list cannot be read
 * the run still starts, and the facts say "DeepSeek Flash: version not recorded (DeepSeek's model list couldn't be read)".
 * A repeated Start reads nothing again. Evidence: .local/qa/ui-rebuild/37-deepseek-version.json and its screenshots.
 */
import {readFileSync} from 'node:fs';
import {createFakeApi} from '../ui-harness/fake-api.mjs';
import {startApp,openApp} from '../ui-harness/app.mjs';
import {corpus,opfsRoot,writeFolder} from '../ui-harness/opfs.mjs';
import {runScript,screenshot} from '../ui-harness/evidence.mjs';
import {until,slotReady} from './05-loop.mjs';
import {shellCopy} from '../../core/ui/copy-shell.ts';
const SCRIPT='37-deepseek-version';
const KNOWN='DeepSeek Flash: DeepSeek-V4.1-Flash when this run started';
const UNKNOWN="DeepSeek Flash: version not recorded (DeepSeek's model list couldn't be read)";
await runScript(SCRIPT,'A DeepSeek run records the version DeepSeek lists when it first starts and shows it in the run facts; a failed lookup never stops the run',async({checks,evidence,defer})=>{
 const {check}=checks,fake=createFakeApi();fake.categories(['procedures','explainers']);
 const owner=JSON.parse(readFileSync(new URL('../../projects/owner/project.json',import.meta.url),'utf8'));
 fake.state.seed={...owner,id:fake.state.seed.id,typeFile:fake.state.seed.typeFile,structuralVocabulary:[]};
 const app=await startApp({fake});defer(()=>app.close());
 const session=await openApp(app,{hash:'#/'});defer(()=>session.close());
 const {page,picker,watch}=session,root=opfsRoot('deepseek-version');await writeFolder(page,root,corpus(2));
 check('the wording is the owner\'s',shellCopy.readerVersion.known('DeepSeek Flash','DeepSeek-V4.1-Flash')===KNOWN&&shellCopy.readerVersion.unknown('DeepSeek Flash')===UNKNOWN);
 // Files → Confirm → DeepSeek Flash → Start run, through the real screens; the Progress screen hands the run over.
 const startDeepSeekRun=async()=>{
  await page.goto(app.url('#/new'));await page.waitForSelector('[data-testid="files"]');
  const localId=await page.evaluate(()=>location.hash.split('/')[2]);picker.queue(root);
  await page.locator(`button[data-op="files:choose-folder:${localId}"]`).click();
  await page.locator('[data-testid="files-primary"] [data-feedback][data-state="done"]').waitFor({timeout:30000});
  await page.locator('[data-testid="files-primary"] button').click();await page.waitForSelector('[data-testid="confirm-reader-selected"]');
  await page.locator(`button[data-op="confirm:reader:${localId}:deepseek"]`).click();
  await until(async()=>(await page.locator('[data-testid="confirm-reader-selected"]').textContent())==='DeepSeek Flash','DeepSeek chosen');
  const before=new Set(fake.state.runs.keys());
  await page.locator('#confirm-limit-blended').fill('5');
  await (await slotReady(page,'confirm-primary',/^Start run$/i)).click();
  await page.waitForURL(url=>/\/progress$/.test(url.hash),{timeout:30000});
  const runId=[...fake.state.runs.keys()].find(id=>!before.has(id));
  await until(()=>['running','complete'].includes(fake.state.runs.get(runId)?.status),'the run started',30000);
  return runId;
 };
 const factsOf=async(expected,shot)=>{
  await page.locator('[data-testid="shell-run-facts"] > summary').click();
  const rows=await until(async()=>{
   const list=(await page.locator('[data-testid="shell-run-facts"] .run-facts dd').allTextContents()).map(text=>text.trim());
   return list.includes(expected)?list:null;
  },'the reader fact',30000).catch(()=>page.locator('[data-testid="shell-run-facts"] .run-facts dd').allTextContents());
  const details=page.locator('[data-testid="shell-run-facts"] details[data-technical] > summary').first();
  if(await details.count())await details.click();
  const technical=await page.locator('[data-testid="shell-run-facts"] .run-facts__technical').textContent({timeout:5000}).catch(()=>'');
  const file=await screenshot(page,SCRIPT+'-'+shot);
  await page.locator('[data-testid="shell-run-facts"] > summary').click();
  return {rows,technical,file};
 };

 // --- DeepSeek lists the version -----------------------------------------------------------------------------------
 const listed=await startDeepSeekRun();
 const listedFacts=await factsOf(KNOWN,'listed');
 evidence.listed={runId:listed,facts:listedFacts.rows,reads:fake.state.modelListReads,record:fake.state.runs.get(listed).readerVersion};
 check('the first Start of a DeepSeek run reads DeepSeek\'s model list once and records the version it lists',
  fake.state.modelListReads===1&&fake.state.runs.get(listed).readerVersion?.name==='DeepSeek-V4.1-Flash',evidence.listed);
 check('the run facts show "DeepSeek Flash: DeepSeek-V4.1-Flash when this run started" beside the other run facts',
  listedFacts.rows.includes(KNOWN),listedFacts.rows);
 check('Details keeps the record: the model, the listed name and when it was recorded',
  /"model": "deepseek-flash"/.test(listedFacts.technical)&&/"name": "DeepSeek-V4.1-Flash"/.test(listedFacts.technical)&&/"recordedAt": "\d{4}-/.test(listedFacts.technical),listedFacts.technical);
 evidence.listedShot=listedFacts.file;
 // A repeated Start on the running run reads nothing again.
 const again=await page.evaluate(async id=>(await fetch(`/api/runs/${id}/start`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,listed);
 check('a repeated Start does not read the model list again',again===200&&fake.state.modelListReads===1,{status:again,reads:fake.state.modelListReads});

 // --- The list cannot be read ----------------------------------------------------------------------------------------
 fake.state.deepseekModelList='unavailable';
 const unread=await startDeepSeekRun();
 const unreadFacts=await factsOf(UNKNOWN,'unread');
 evidence.unread={runId:unread,status:fake.state.runs.get(unread).status,facts:unreadFacts.rows,reads:fake.state.modelListReads,record:fake.state.runs.get(unread).readerVersion};
 check('a model list that cannot be read never stops the run: it starts, and the version is recorded as not known',
  ['running','complete'].includes(fake.state.runs.get(unread).status)&&fake.state.modelListReads===2&&fake.state.runs.get(unread).readerVersion?.name===null,evidence.unread);
 check('the run facts say "DeepSeek Flash: version not recorded (DeepSeek\'s model list couldn\'t be read)"',unreadFacts.rows.includes(UNKNOWN),unreadFacts.rows);
 check('Details keeps the reason it is not known',/"name": null/.test(unreadFacts.technical)&&/"reason": "status"/.test(unreadFacts.technical),unreadFacts.technical);
 evidence.unreadShot=unreadFacts.file;

 check('no request leaves the local app origin',watch.record.external.length===0,watch.record.external);
 check('no uncaught page errors or console errors',watch.record.pageErrors.length===0&&watch.record.consoleErrors.length===0,{pages:watch.record.pageErrors,console:watch.record.consoleErrors});
 check('the fixture stays within the real wire contracts',fake.problems.length===0,fake.problems);
 evidence.api=fake.requests.map(r=>({method:r.method,path:r.path,status:r.status}));
});
