import { presentError } from '../../../core/ui/error-copy.ts';
import { arrayShallowEqual, computed, effect, signal, untrack } from '../../../core/ui/reactive.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { readTrialSelection } from '../../../core/ui/trial-plan.ts';
import { h, each, show } from '../view/dom.ts';
import { action } from '../view/action.ts';
import type { DraftStore } from '../state/types.ts';
import './trial-selection.css';
import type { ViewContext } from '../shell/view-context.ts';

/** Selection is reviewed before spending. Edits invalidate Start until the explicit selection action succeeds. */
export function trialSelection(ctx: ViewContext, draft: DraftStore): HTMLElement {
 const problem=signal<string|null>(null);
 const controller=ctx.controllers.trialDraft(draft.localId),limit=controller.size;
 const c=activeUiCopy.trial, choice=signal(draft.trial.peek()), search=signal(''), shown=signal(100);
 const frozen=draft.inputsLocked;
 const readSize=async()=>{try{await controller.loadSize();problem.set(null);}catch(e){problem.set(presentError(e,'read').headline);throw e;}};
 void readSize().catch(()=>{ /* Shown next to the read-again action. */ });
 effect(()=>{const saved=draft.trial();untrack(()=>choice.set(saved));});
 const change=(patch:Partial<NonNullable<ReturnType<typeof choice>>>)=>{
  if(frozen.peek())return;
  const current=choice.peek();if(!current)return;
  choice.set({...current,...patch});draft.prepared.set(null);draft.acknowledgeUnlimited.set(false);
 };
 const byId=computed(()=>new Map(draft.files.keys().map(key=>draft.files.get(key)!()).map(file=>[file.fingerprint,file])));
 const filtered=computed(()=>{const s=choice();if(!s)return [];const q=search().toLowerCase();return s.order.filter(fp=>(byId().get(fp)?.name??'').toLowerCase().includes(q));});
 const selected=computed(()=>new Set(choice()?.selected??[]));
 const saveMode=async(skip:boolean,fb:Parameters<NonNullable<import('../view/action.ts').ActionSpec['run']>>[0])=>{
  if(frozen.peek())throw new Error(c.selectionPending);
  const current=choice.peek();if(!current||limit.peek()===null)return;
  const {skipPilot:_prior,...base}=current;
  const next=readTrialSelection({...base,role:skip?'ordinary':'pilot',campaignId:null,trialRunId:null,
   selected:skip?[...base.order]:base.order.slice(0,limit.peek()!),...(skip?{skipPilot:true}:{})});
  await draft.setTrial(next);choice.set(next);
  if(await ctx.controllers.confirm(draft.localId).prepare(fb)!==null)fb.done(c.savedSelection);
 };
 return h('section',{class:'panel trial-selection',attrs:{'aria-labelledby':'trial-selection-title'},testid:'trial-selection'},
  h('h3',{attrs:{id:'trial-selection-title'}},c.selectionTitle),
  show(computed(()=>problem()!==null),()=>action({id:'trial:read-size:'+draft.localId,label:c.readAgain,kind:'quiet',note:problem,run:async()=>{await readSize();}})),
  h('p',{class:'hint'},computed(()=>c.collection(choice()?.order.length??0))),
  show(computed(()=>choice()?.role==='full'),()=>h('p',null,c.fullNote)),
  show(computed(()=>choice()?.skipPilot===true),()=>h('p',{testid:'trial-skipped-note'},c.skipNote)),
  show(computed(()=>choice()!==null&&choice()!.role!=='full'&&limit()!==null&&choice()!.order.length>limit()!),()=>h('div',null,
   action({id:'trial:choose-mode:'+draft.localId,label:computed(()=>choice()?.skipPilot?c.useTrial:c.skipAction),kind:'secondary',
    blockedBy:computed(()=>frozen()?{key:'trial.selectionPending'}:null),
    run:async fb=>{await saveMode(choice.peek()?.skipPilot!==true,fb);}}))),
  show(computed(()=>choice()!==null&&choice()!.role!=='full'&&(choice()!.order.length<=(limit()??0))),()=>h('label',{class:'check trial-selection__trial'},
   h('input',{attrs:{type:'checkbox'},props:{checked:computed(()=>choice()?.role==='pilot'),disabled:frozen},on:{change:event=>{
    if(frozen.peek()){(event.target as HTMLInputElement).checked=choice.peek()?.role==='pilot';return;}
    const checked=(event.target as HTMLInputElement).checked;const s=choice.peek()!;change({role:checked?'pilot':'ordinary',selected:checked?s.selected.slice(0,limit.peek()!):[...s.order]});
   }}}),h('span',null,h('b',null,c.chooseTrial),' ',h('span',{class:'trial-selection__sub'},c.chooseTrialNote)))),
  show(computed(()=>choice()?.role==='pilot'&&limit()!==null),()=>h('p',null,computed(()=>c.max(limit()!)))),
  h('p',{class:'trial-selection__count',testid:'trial-selection-count'},computed(()=>c.selected(choice()?.selected.length??0,choice()?.order.length??0))),
  h('p',{class:'hint'},c.keepCollection),
  h('details',{class:'trial-selection__choose'},h('summary',null,c.choose),
   h('div',{class:'trial-selection__docs'},
    h('input',{class:'input',attrs:{type:'search','aria-label':c.search,placeholder:c.search},props:{value:search},on:{input:event=>{search.set((event.target as HTMLInputElement).value);shown.set(100);}}}),
    action({id:'trial:select-default:'+draft.localId,label:computed(()=>choice()?.role==='pilot'?c.first(limit()??0):c.selectAll),kind:'secondary',
     blockedBy:computed(()=>frozen()?{key:'trial.selectionPending'}:null),run:async()=>{const s=choice.peek();if(s)change({selected:s.role==='pilot'?s.order.slice(0,limit.peek()!):[...s.order]});}}),
    each(computed(()=>filtered().slice(0,shown()),{equals:arrayShallowEqual}),fp=>computed(()=>fp),item=>{
     const fp=item.peek();return h('label',{class:'check trial-selection__doc'},
      h('input',{attrs:{type:'checkbox','data-trial-document':fp},props:{checked:computed(()=>selected().has(fp)),disabled:frozen},on:{change:event=>{
       if(frozen.peek()){(event.target as HTMLInputElement).checked=selected.peek().has(fp);return;}
       const s=choice.peek()!,set=new Set(s.selected);if((event.target as HTMLInputElement).checked)set.add(fp);else set.delete(fp);
       change({selected:s.order.filter(id=>set.has(id))});
      }}}),computed(()=>byId().get(fp)?.name??''));
    }),
    show(computed(()=>filtered().length>shown()),()=>action({id:'trial:more:'+draft.localId,label:activeUiCopy.common.showMore(100),kind:'quiet',run:async()=>{shown.update(n=>n+100);}})))),
  action({id:'trial:save-selection:'+draft.localId,label:c.applySelection,kind:'secondary',
   blockedBy:computed(()=>{const s=choice();if(frozen())return {key:'trial.selectionPending'};if(!s||limit()===null)return {key:'screenConfirm.blockers.preparing'};
    if(s.selected.length===0)return {key:'trial.empty'};if(s.role==='pilot'&&s.selected.length>limit()!)return {key:'trial.max',args:{n:limit()!}};return null;}),
   run:async fb=>{await draft.setTrial(readTrialSelection(choice.peek()));const ready=await ctx.controllers.confirm(draft.localId).prepare(fb);if(ready!==null)fb.done(c.savedSelection);}}));
}
