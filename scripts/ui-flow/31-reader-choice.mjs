/**
 * Reader choice: real confirmation UI, persisted selection, unknown daily estimates, the site's refusals and an uncertain
 * create reply. DECISIONS 136: the two experimental readers are offered and labelled as such, DeepSeek carries the
 * owner's data notice beside it, each freezes its own exact model id, the shared spending limit names who is paid, and
 * the Workers AI allowance is shown in Neurons.
 */
import {readFileSync} from 'node:fs';
import {createFakeApi} from '../ui-harness/fake-api.mjs';
import {startApp,openApp} from '../ui-harness/app.mjs';
import {corpus,opfsRoot,writeFolder} from '../ui-harness/opfs.mjs';
import {runScript,screenshot} from '../ui-harness/evidence.mjs';
import {until,slotReady} from './05-loop.mjs';
import {usageCopy} from '../../core/ui/copy-usage.ts';
import {confirmCopy} from '../../core/ui/copy-confirm.ts';
const SCRIPT='31-reader-choice';
await runScript(SCRIPT,'Explicit reader choice survives reload, freezes with confirmation, and never guesses unmeasured daily capacity',async({checks,evidence,defer})=>{
 const {check}=checks,fake=createFakeApi();fake.categories(['procedures','explainers']);
 const owner=JSON.parse(readFileSync(new URL('../../projects/owner/project.json',import.meta.url),'utf8'));
 fake.state.seed={...owner,id:fake.state.seed.id,typeFile:fake.state.seed.typeFile,structuralVocabulary:[]};
 const app=await startApp({fake});defer(()=>app.close());
 const session=await openApp(app,{hash:'#/'});defer(()=>session.close());
 const {page,picker,watch}=session,root=opfsRoot('reader-choice');await writeFolder(page,root,corpus(2));
 await page.goto(app.url('#/new'));await page.waitForSelector('[data-testid="files"]');
 const localId=await page.evaluate(()=>location.hash.split('/')[2]);picker.queue(root);
 await page.locator(`button[data-op="files:choose-folder:${localId}"]`).click();
 await page.locator('[data-testid="files-primary"] [data-feedback][data-state="done"]').waitFor({timeout:30000});
 await page.locator('[data-testid="files-primary"] button').click();await page.waitForSelector('[data-testid="confirm-reader-selected"]');
 const selected=()=>page.locator('[data-testid="confirm-reader-selected"]').textContent();
 const mini=()=>page.locator(`button[data-op="confirm:reader:${localId}:mini"]`),standard=()=>page.locator(`button[data-op="confirm:reader:${localId}:standard"]`);
 const savedSelection=()=>page.evaluate(async id=>{const {journeyDb}=await import('/persist/journey-db.ts');return journeyDb.get('trials',id);},localId);
 check('the configured standard reader is shown and saved before any quote',await selected()==='GPT-5.4'&&(await savedSelection()).selectedReaderModel==='standard'&&fake.requestsTo({method:'POST',path:'/api/quote'}).length===0);
 await page.locator('#confirm-limit-blended').fill('5');await slotReady(page,'confirm-primary',/^Start run$/i);
 // Hold the first storage read to test the gap before setTrial acquires its existing cross-tab lock.
 await page.evaluate(async id=>{
  const {journeyDb}=await import('/persist/journey-db.ts'),original=journeyDb.get.bind(journeyDb);
  let release,first=true;const gate=new Promise(resolve=>release=resolve);
  window.__readerChoiceGate={reached:false,release:()=>{release();journeyDb.get=original;}};
  journeyDb.get=async(store,key)=>{if(first&&store==='trials'&&key===id){first=false;window.__readerChoiceGate.reached=true;await gate;}return original(store,key);};
 },localId);
 await mini().click();await page.waitForFunction(()=>window.__readerChoiceGate.reached);
 const startDuringChoice=page.locator(`button[data-op="confirm:start:${localId}"]`);
 check('Start cannot use the old reader while a model choice is awaiting its first storage read',await startDuringChoice.count()===0||await startDuringChoice.isDisabled());
 await page.evaluate(()=>window.__readerChoiceGate.release());
 await until(async()=>await selected()==='GPT-5.4 mini','mini preparation');
 check('choosing mini changes its recorded version and persists the choice',(await savedSelection()).selectedReaderModel==='mini'&&(await page.locator('[data-testid="confirm-reader-pin"]').textContent())==='gpt-5.4-mini');
 await page.locator('[data-testid="confirm-usage-per-day"]').waitFor();
 check('unmeasured costs and document capacity remain unknown',/Not measured yet/.test(await page.locator('[data-testid="confirm-usage-cost"]').textContent())&&/Not measured yet/.test(await page.locator('[data-testid="confirm-usage-per-day"]').textContent()));
 fake.respondNext({method:'GET',path:'/api/usage'},{status:200,value:{enabled:true,resetsAt:'invalid'}});
 await page.locator(`button[data-op="confirm:usage:${localId}"]`).click();await page.locator('[data-testid="confirm-usage-error"]').waitFor();
 check('unreadable usage is shown without inventing remaining capacity or disabling model choice',await page.locator('[data-testid="confirm-usage-remaining"]').count()===0&&!await standard().isDisabled());
 await page.locator(`button[data-op="confirm:usage:${localId}"]`).click();await page.locator('[data-testid="confirm-usage-per-day"]').waitFor();
 // The site's own limits refuse in plain words before anything is created; the reader stays a free choice.
 const refusedStart=async(code,headline,status)=>{
  fake.failNext({method:'POST',path:'/api/quote'},code,headline,{status,kind:'request'});
  await page.locator('#confirm-limit-blended').fill('5');
  await (await slotReady(page,'confirm-primary',/^Start run$/i)).click();
  // The earlier refusal can still be on screen: wait for this one's own words.
  const feedback=page.locator(`[data-feedback="confirm:start:${localId}"][data-state="problem"]`).filter({hasText:headline});await feedback.waitFor();
  return (await feedback.textContent())??'';
 };
 // DECISIONS 136: four readers in the owner's order; the two experimental ones are labelled; every reader says who sees the text.
 const optionIds=await page.locator('[data-testid^="confirm-reader-option-"]').evaluateAll(nodes=>nodes.map(node=>node.dataset.testid.replace('confirm-reader-option-','')));
 check('the menu offers GPT-5.4, GPT-5.4 mini, Qwen 3.8 27B (Cloudflare) and DeepSeek Flash, in that order',JSON.stringify(optionIds)===JSON.stringify(['standard','mini','qwen','deepseek']),optionIds);
 const experimental=async id=>page.locator(`[data-testid="confirm-reader-experimental-${id}"]`).count();
 check('only the two new readers are labelled experimental',await experimental('qwen')===1&&await experimental('deepseek')===1&&await experimental('standard')===0&&await experimental('mini')===0&&
   (await page.locator('[data-testid="confirm-reader-experimental-qwen"]').textContent()).trim()===confirmCopy.readerExperimental);
 // Owner decision of 7 October 2026: a data line beside every option, in the owner's words, and one for the confidence check.
 // The OpenAI line describes the owner's account, so the owner pack supplies it as a copy override (core says only
 // "Processed by OpenAI under this site's OpenAI account terms."); the fake serves this pack, so the override is shown.
 const ownerOpenai=owner.copyOverrides?.['screenConfirm.readerDataNote.openai']??null;
 const noteOf=async id=>{const note=page.locator(`[data-testid="confirm-reader-option-${id}"] [data-testid="confirm-reader-note-${id}"]`);return await note.count()===1?(await note.textContent()).trim():null;};
 const notes={standard:await noteOf('standard'),mini:await noteOf('mini'),qwen:await noteOf('qwen'),deepseek:await noteOf('deepseek')};
 check('every reader option carries its provider\'s data line; the OpenAI one is the owner pack\'s own wording, not core\'s',
   ownerOpenai!==null&&ownerOpenai!==confirmCopy.readerDataNote.openai&&notes.standard===ownerOpenai&&notes.mini===ownerOpenai&&
   notes.qwen===confirmCopy.readerDataNote.cloudflare&&notes.deepseek===confirmCopy.readerDataNote.deepseek,{notes,ownerOpenai});
 const confidenceNote=page.locator('[data-testid="confirm-confidence-note"]');
 check('the confirmation says the text also goes to TypeSafe for the confidence check, in the owner\'s words',await confidenceNote.count()===1&&(await confidenceNote.textContent()).trim()===confirmCopy.confidenceDataNote);
 check('the chosen reader repeats its data line',(await page.locator('[data-testid="confirm-reader-note"]').textContent()).trim()===ownerOpenai);
 check('the Workers AI allowance is shown in Neurons beside the other daily pools',/9,000 Neurons/.test(await page.locator('[data-testid="confirm-usage"]').textContent()));
 const choose=async(id,label)=>{await page.locator(`button[data-op="confirm:reader:${localId}:${id}"]`).click();await until(async()=>await selected()===label,id+' preparation');};
 await choose('qwen','Qwen 3.8 27B (Cloudflare)');
 await page.locator('[data-testid="confirm-more"] summary').first().click();
 const readerLimitLabel=()=>page.locator('#confirm-limit-openai-label').textContent();
 check('choosing Qwen freezes its exact undated id, shows it as experimental, and names who the shared limit pays',
   (await savedSelection()).selectedReaderModel==='qwen'&&(await page.locator('[data-testid="confirm-reader-pin"]').textContent())==='@cf/qwen/qwen3.8-27b'&&
   await page.locator('[data-testid="confirm-reader-experimental"]').count()===1&&(await readerLimitLabel()).trim()===confirmCopy.readerLimit.cloudflare,await readerLimitLabel());
 await choose('deepseek','DeepSeek Flash');
 check('choosing DeepSeek freezes deepseek-flash and repeats its data line beside the choice',
   (await page.locator('[data-testid="confirm-reader-pin"]').textContent())==='deepseek-flash'&&
   (await page.locator('[data-testid="confirm-reader-note"]').textContent()).trim()===confirmCopy.readerDataNote.deepseek&&
   (await readerLimitLabel()).trim()===confirmCopy.readerLimit.deepseek);
 evidence.deepseekShot=await screenshot(page,SCRIPT+'-deepseek');
 // The service's backstop, if a reader becomes unusable after the page read Health.
 const unavailable=await refusedStart('E_READER_UNAVAILABLE',usageCopy.readerUnavailable('DeepSeek Flash'),409);
 check('a reader this site cannot use is still refused at Start as written, creates no run and leaves the choice open',unavailable.includes(usageCopy.readerUnavailable('DeepSeek Flash'))&&fake.state.runs.size===0&&!await standard().isDisabled(),unavailable);
 await choose('standard','GPT-5.4');
 check('an OpenAI reader keeps the OpenAI limit label and no experimental label',(await readerLimitLabel()).trim()===confirmCopy.openaiLimit&&await page.locator('[data-testid="confirm-reader-experimental"]').count()===0);
 await choose('mini','GPT-5.4 mini');
 const runLimit=await refusedStart('E_DAILY_RUN_LIMIT',usageCopy.runs(3),429);
 check('the daily run count refusal is shown as written and creates no run',runLimit.includes(usageCopy.runs(3))&&fake.state.runs.size===0&&!await standard().isDisabled()&&!await mini().isDisabled(),runLimit);
 const documentLimit=await refusedStart('E_RUN_DOCUMENT_LIMIT',usageCopy.documents(60),409);
 check('the per-run document cap refusal is shown as written and creates no run',documentLimit.includes(usageCopy.documents(60))&&fake.state.runs.size===0&&!await standard().isDisabled(),documentLimit);
 // Owner decision of 7 October 2026: a reader this site cannot use is greyed out with its reason, from Health.
 fake.state.unavailableReaders={qwen:'E_READER_BINDING',deepseek:'E_VENDOR_KEY'};
 await page.reload();await page.waitForSelector('[data-testid="confirm-reader-selected"]');
 const qwenButton=()=>page.locator(`button[data-op="confirm:reader:${localId}:qwen"]`),deepseekButton=()=>page.locator(`button[data-op="confirm:reader:${localId}:deepseek"]`);
 await until(async()=>await qwenButton().isDisabled()&&await deepseekButton().isDisabled(),'unavailable readers greyed out');
 const optionText=id=>page.locator(`[data-testid="confirm-reader-option-${id}"]`).textContent();
 check('readers this site cannot use are greyed out with their reason, the others stay available',
   (await optionText('qwen')).includes(confirmCopy.readerUnavailable.binding)&&(await optionText('deepseek')).includes(confirmCopy.readerUnavailable.key)&&
   await page.locator('[data-testid="confirm-reader-option-qwen"][data-unavailable="true"]').count()===1&&!await standard().isDisabled()&&!await mini().isDisabled()&&
   !(await optionText('mini')).includes(confirmCopy.readerUnavailable.key));
 evidence.unavailableShot=await screenshot(page,SCRIPT+'-unavailable');
 check('reloading keeps mini rather than the menu default',await selected()==='GPT-5.4 mini'&&(await savedSelection()).selectedReaderModel==='mini');
 evidence.choiceShot=await screenshot(page,SCRIPT+'-mini');
 await page.locator('#confirm-limit-blended').fill('5');
 // A 200 response with no run identity is uncertain; no transport retry or actual vendor call is involved.
 const quotesBeforeStart=fake.requestsTo({method:'POST',path:'/api/quote'}).length;
 fake.respondNext({method:'POST',path:'/api/runs'},{status:200,value:{unreadable:true}});
 await (await slotReady(page,'confirm-primary',/^Start run$/i)).click();
 await slotReady(page,'confirm-primary',/Finish starting/i);
 const intent=await page.evaluate(id=>JSON.parse(localStorage.getItem('confirm-intent:'+id)),localId);
 check('an uncertain confirmation freezes the exact reader and disables both choices',intent.readerModel?.id==='mini'&&intent.readerModel?.pin==='gpt-5.4-mini'&&await mini().isDisabled()&&await standard().isDisabled(),intent);
 const guarded=await page.evaluate(async id=>{
  const {createDraftStore}=await import('/state/draft-store.ts');const store=createDraftStore(id,{note(){},linked(){}});
  const saved=await store.loadTrial();try{await store.setTrial({...saved,selectedReaderModel:'standard'});return false;}catch{return true;}
 },localId);
 check('the shared store guard also refuses a programmatic reader change while the intent is pending',guarded&&(await savedSelection()).selectedReaderModel==='mini');
 await page.reload();await slotReady(page,'confirm-primary',/Finish starting/i);await page.waitForSelector('[data-testid="confirm-reader-selected"]');
 check('reload preserves the frozen reader and does not silently request another quote',await selected()==='GPT-5.4 mini'&&await standard().isDisabled()&&fake.requestsTo({method:'POST',path:'/api/quote'}).length===quotesBeforeStart+1);
 evidence.pendingShot=await screenshot(page,SCRIPT+'-pending');
 await (await slotReady(page,'confirm-primary',/Finish starting/i)).click();await page.waitForURL(url=>/\/progress$/.test(url.hash));
 const run=[...fake.state.runs.values()][0],requests=fake.requestsTo({method:'POST',path:'/api/runs'});
 check('Finish posts the same confirmation and creates one run with mini frozen',requests.length===2&&JSON.stringify(requests[0].body)===JSON.stringify(requests[1].body)&&fake.state.runs.size===1&&run.pack.selectedReaderModel==='mini'&&run.pack.pins.reader.id==='gpt-5.4-mini');
 await until(()=>fake.requestsTo({method:'GET',path:`/api/runs/${run.id}/plan`}).length>0,'frozen plan read');
 const plan=fake.requestsTo({method:'GET',path:`/api/runs/${run.id}/plan`}).at(-1)?.response;
 check('the frozen plan exposes the same selected reader for inspection',plan?.selectedReaderModel==='mini'&&plan?.readerModel?.pin==='gpt-5.4-mini',plan?.readerModel);
 check('no request leaves the local app origin',watch.record.external.length===0,watch.record.external);
 // The browser's own log line for the three site refusals this script injects on the quote (409 reader unavailable, 429 run count, 409 document cap).
 const pathOf=entry=>new URL(entry.location?.url??'http://x.invalid/').pathname;
 const injected=entry=>/^Failed to load resource: the server responded with a status of (429|409) /.test(entry.text)&&pathOf(entry)==='/api/quote';
 evidence.expectedConsoleErrors=watch.record.consoleErrors.filter(injected).map(entry=>({...entry,reason:'a refusal this script causes on purpose'}));
 const consoleErrors=watch.record.consoleErrors.filter(entry=>!injected(entry));
 check('no uncaught page errors or console errors',watch.record.pageErrors.length===0&&consoleErrors.length===0&&evidence.expectedConsoleErrors.length===3,{pages:watch.record.pageErrors,console:consoleErrors});
 check('the fixture stays within the real wire contracts',fake.problems.length===0,fake.problems);
 evidence.api=fake.requests.map(r=>({method:r.method,path:r.path,query:r.query,status:r.status}));
});