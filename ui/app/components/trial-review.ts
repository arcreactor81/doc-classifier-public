import { arrayShallowEqual, computed, signal, effect, onCleanup } from '../../../core/ui/reactive.ts';
import './trial-review.css';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { presentError } from '../../../core/ui/error-copy.ts';
import { categoryNames } from '../../../core/ui/result-presenter.ts';
import { formatRoute } from '../../../core/ui/routes.ts';
import type { PilotVerdict } from '../../../core/ui/trial-wire.ts';
import { action } from '../view/action.ts';
import { h, each, show } from '../view/dom.ts';
import { navigate } from '../router.ts';
import { evidencePanel, type EvidenceLoad } from './evidence-panel.ts';
import type { ViewContext } from '../shell/view-context.ts';
import type { RunStore } from '../state/types.ts';

export function trialEvidence(run:RunStore,fingerprint:string):HTMLElement {
 const load=signal<EvidenceLoad>({state:'loading'});
 effect(()=>{const abort=new AbortController();void run.loadEvidence(fingerprint,abort.signal).then(result=>{
  if(result.kind==='ok')load.set({state:'ready',answers:result.value});
 },error=>{if(!abort.signal.aborted)load.set({state:'error',error:presentError(error,'evidence')});});onCleanup(()=>abort.abort());});
 const p=run.plan.peek();if(p.state!=='ready')throw new Error('Trial evidence needs the frozen categories.');
 const doc=run.docs.get(fingerprint)?.peek();
 return evidencePanel({filename:doc?.filename??'',names:categoryNames(p.value.typeFile,p.value.displayNames),types:p.value.typeFile.types,
  threshold:p.value.threshold,decision:doc?.ruleId?{ruleId:doc.ruleId,typeId:doc.typeId,destinationFolder:doc.destinationFolder,notes:doc.notes}:null,load});
}

export function trialReview(ctx:ViewContext,run:RunStore):HTMLElement {
 const c=activeUiCopy.trial,controller=ctx.controllers.trial(run.id),view=controller.view,error=controller.error;
 const reload=()=>controller.load();
 void reload().catch(()=>{ /* The read failure is displayed beneath the explicit read-again action. */ });
 const verdictId=(fp:string,v:PilotVerdict)=>'trial:verdict:'+run.id+':'+fp+':'+v;
 const busy=(fp:string)=>['right','wrong'].some(v=>ctx.store.operations.get(verdictId(fp,v as PilotVerdict))().state==='working');
 const names=computed(()=>{const p=run.plan();return p.state==='ready'?categoryNames(p.value.typeFile,p.value.displayNames):{};});
 const prepare=(role:'pilot'|'full')=>action({id:'trial:prepare-'+role+':'+run.id,label:role==='full'?c.prepareFull:c.newTrial,kind:'primary',primary:true,
  note:role==='full'?c.fullNote:c.newTrialReference,run:async fb=>{
   const localId=await controller.prepare(role);fb.done(c.prepared);navigate(formatRoute({view:'confirm',localId}));
  }});
 return h('section',{class:'panel stack-v trial-review',testid:'trial-review'},
  h('h3',null,c.reviewTitle),h('p',{class:'hint'},c.reviewLead),
  action({id:'trial:read:'+run.id,label:c.readAgain,kind:'quiet',note:error,errorContext:'read',run:async()=>{await reload();}}),
  show(computed(()=>view()!==null),()=>h('div',{class:'stack'},
   h('p',{testid:'trial-reviewed-count'},computed(()=>c.complete(view()!.counts.right,view()!.counts.filed))),
   show(computed(()=>view()!.counts.filed===0),()=>h('p',null,c.zero)),
   each(computed(()=>view()!.filed.map(e=>e.fingerprint),{equals:arrayShallowEqual}),fp=>computed(()=>view()!.filed.find(e=>e.fingerprint===fp)!),entry=>{
    const fp=entry.peek().fingerprint;
    return h('article',{class:'trial-file stack-v',testid:'trial-file'},
     h('h4',null,entry.peek().originalFilename),h('p',{class:'hint'},computed(()=>names()[entry().destinationFolder]??entry().destinationFolder)),
     h('p',{testid:'trial-verdict'},computed(()=>entry().verdict===null?c.unreviewed:c[entry().verdict!])),
     h('details',null,h('summary',null,activeUiCopy.details),trialEvidence(run,fp)),
     h('div',{class:'quiet-actions'},...(['right','wrong'] as const).map(verdict=>action({
      id:verdictId(fp,verdict),label:c[verdict],kind:'secondary',
      blockedBy:computed(()=>view()?.confirmation?{key:'trial.reviewClosed'}:busy(fp)?{key:'trial.recording'}:null),
      run:async fb=>{await controller.review(fp,verdict);fb.done(c.reviewed);}
     }))),
     show(computed(()=>entry().verdict==='wrong'),()=>action({id:'trial:editor:'+run.id+':'+fp,label:c.editor,kind:'secondary',
      run:async()=>{controller.rememberEvidence(fp);navigate(formatRoute({view:'category-edit',fromRunId:run.id,correctionId:null}));}})));
   }),
   show(computed(()=>!view()!.categoryVersion.matches),()=>h('p',null,c.stale)),
   show(computed(()=>view()!.counts.wrong>0),()=>h('p',null,c.wrongNote)),
   show(computed(()=>view()!.confirmation===null&&view()!.categoryVersion.matches&&view()!.counts.wrong===0),()=>action({
    id:'trial:confirm:'+run.id,label:c.confirm,kind:'primary',primary:true,note:c.confirmNote,
    blockedBy:computed(()=>view()!.filed.some(entry=>busy(entry.fingerprint))?{key:'trial.recording'}:view()!.counts.reviewed!==view()!.counts.filed?{key:'trial.reviewEvery'}:null),
    run:async fb=>{await controller.confirm();fb.done(c.confirmed);}
   })),
   show(computed(()=>view()!.confirmation!==null&&view()!.categoryVersion.matches),()=>h('div',{class:'stack'},h('p',null,c.confirmed),prepare('full'))),
   show(computed(()=>!view()!.categoryVersion.matches||view()!.counts.wrong>0),()=>prepare('pilot'))
  )));
}
