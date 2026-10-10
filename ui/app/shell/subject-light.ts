/**
 * The run's live light (VISUAL-SPEC-v2 §5.3): the light model over the facts the stores already hold, re-evaluated
 * when a fact changes, at the model's own deadline (lease end, quiet period, provider wait), and on the minute clock.
 * The run header and the Progress pane read the same light, so they always say the same word.
 */
import { computed, type Read } from '../../../core/ui/reactive.ts';
import { lightDeadline, runLight, type Light, type LightFacts } from '../../../core/ui/live-light.ts';
import { SIGN_IN_EXPIRED } from '../../../core/ui/request-error.ts';
import { deadlineClock } from '../state/clock.ts';
import type { AppStore } from '../state/types.ts';
import type { JourneyState } from './view-context.ts';

export interface RunLight { light: Read<Light>; now: Read<number> }

export function runLightOf(store: AppStore, runId: string, journey: Read<JourneyState>): RunLight {
  const run = store.runStore(runId);
  const factsAt = (now: number): LightFacts => {
    const view = run.view(), state = journey();
    const facts = state.state === 'ready' && state.facts.run?.id === runId ? state.facts.run : null;
    return {
      now, visible: typeof document === 'undefined' || document.visibilityState === 'visible',
      status: view?.status ?? null, total: view?.total ?? 0, decided: view?.decided ?? 0, undispatched: view?.undispatched ?? 0,
      checkedAt: run.checkedAt(), lastEventAt: view?.lastEventAt ?? null, readProblemAt: run.readProblem()?.at ?? null,
      readProblemSignIn: run.readProblem()?.error.code === SIGN_IN_EXPIRED,
      liveToggle: run.live(), controllersHere: store.activity().filter(item => item.runId === runId).length,
      sendState: run.send().kind, situation: facts?.send ?? null,
      runtimeWait: view?.runtimeWait ?? null,
      waits: run.providerWaits(), stop: view?.stop ? { emergency: view.stop.killed } : null
    };
  };
  const tick = deadlineClock(at => lightDeadline(factsAt(at)));
  const now = computed(() => { tick(); store.minuteClock(); return Date.now(); });
  const light = computed(() => runLight(factsAt(now())), {
    equals: (a, b) => a.key === b.key && a.liveUntil === b.liveUntil && JSON.stringify(a.reason) === JSON.stringify(b.reason)
  });
  return { light, now };
}
