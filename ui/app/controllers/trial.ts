import { signal, type Read } from '../../../core/ui/reactive.ts';
import { presentError } from '../../../core/ui/error-copy.ts';
import type { PilotView, PilotVerdict } from '../../../core/ui/trial-wire.ts';
import { isLatest } from '../api/client.ts';
import type { ControllerRegistry } from './registry.ts';
import { initialSelection, cloneTrialRecord, readTrialSelection } from '../../../core/ui/trial-plan.ts';
import { activeUiCopy } from '../../../core/ui/project-copy.ts';
import { getPilot, getProject, reviewPilot, confirmPilot } from '../api/endpoints.ts';
import { beginDraft, draftReference, readLocalForRun, readTrialEvidence, writeTrialEvidence } from '../persist/local-keys.ts';
import { listLocalRecords, openLocalRunStore } from '../persist/local-records.ts';
import { journeyDb } from '../persist/journey-db.ts';
import { HANDLE_KEYS, readHandle, saveHandle } from '../persist/handles.ts';
import type { AppStore } from '../state/types.ts';

/** Explicit local preparation only. No quote, cloud run, upload, vendor output or spending decision is reused. */
export async function prepareAfterTrial(store:AppStore,runId:string,role:'pilot'|'full'):Promise<string> {
 const review=(await getPilot(runId)).value;
 if(role==='full'&&(!review.confirmation||!review.categoryVersion.matches))throw new Error(activeUiCopy.trial.stale);
 const linked=readLocalForRun(runId);
 if(!linked)throw new Error(activeUiCopy.trial.missingCollection);
 const prior=await journeyDb.get('trials',linked);
 if(!prior)throw new Error(activeUiCopy.trial.missingCollection);
 const selection=readTrialSelection(prior);
 const source=selection.sourceLocalId;
 const records=await listLocalRecords(source);
 if(records.length!==selection.order.length)throw new Error(activeUiCopy.trial.missingCollection);
 const pack=(await getProject(selection.selectedReaderModel)).value;
 // Stale category revisions never inherit an old feedback reference implicitly.
 const localId=beginDraft(crypto.randomUUID(),role==='full'?draftReference(source):null);
 const db=await openLocalRunStore();
 try {for(const record of records)await db.put(cloneTrialRecord(record,localId));}finally{db.close();}
 const next=initialSelection(source,records,pack.settings.pilotSize!,selection.order);
 await store.draftStore(localId).setTrial({...next,role,campaignId:role==='full'?review.campaignId:null,
   trialRunId:role==='full'?runId:null,...(selection.selectedReaderModel===undefined?{}:{selectedReaderModel:selection.selectedReaderModel}),selected:role==='full'?[...next.order]:next.order.slice(0,pack.settings.pilotSize!)});
 const handle=await readHandle(HANDLE_KEYS.source(source));if(handle)await saveHandle(HANDLE_KEYS.source(localId),handle);
 await store.draftStore(localId).loadFiles();
 return localId;
}

export interface TrialDraftController {
  size: Read<number | null>;
  loadSize(): Promise<void>;
}
export interface TrialController {
  view: Read<PilotView | null>;
  error: Read<string | null>;
  load(): Promise<void>;
  review(fingerprint: string, verdict: PilotVerdict): Promise<void>;
  confirm(): Promise<void>;
  prepare(role: 'pilot' | 'full'): Promise<string>;
  rememberEvidence(fingerprint: string): void;
  editorEvidence(): string | null;
}
declare module './registry.ts' {
  interface ControllerKinds { trial: TrialController; trialDraft: TrialDraftController }
}
export function register(registry: ControllerRegistry): void {
  registry.register('trialDraft', () => {
    const size=signal<number|null>(null);
    return {
      size,
      async loadSize() {
        const pack=(await getProject()).value,value=pack.settings.pilotSize;
        if(!Number.isSafeInteger(value)||Number(value)<1)throw new Error('The configured trial size is invalid.');
        size.set(value!);
      }
    };
  });
  registry.register('trial', ctx => {
    const view=signal<PilotView|null>(null),error=signal<string|null>(null);
    let read=0;
    const load=async()=>{
      const current=++read;
      try {
        const fetched=await getPilot(ctx.id);
        if(current===read&&isLatest(fetched.key,fetched.seq)){view.set(fetched.value);error.set(null);}
      } catch(e) {
        if(current===read)error.set(presentError(e,'read').headline);
        throw e;
      }
    };
    return {
      view,error,load,
      async review(fingerprint,verdict){await reviewPilot(ctx.id,fingerprint,verdict);await load();},
      async confirm(){try{await confirmPilot(ctx.id);await load();}catch(e){await load().catch(()=>{});throw e;}},
      prepare: role=>prepareAfterTrial(ctx.store,ctx.id,role),
      rememberEvidence: fingerprint=>writeTrialEvidence(ctx.id,fingerprint),
      editorEvidence: ()=>readTrialEvidence(ctx.id)
    };
  });
}
