/**
 * The practice app: the real screens on this computer, answered by the fake service (fake-api.mjs) instead of the
 * Worker and the two vendors. Nothing leaves this computer and nothing is spent; the outcomes are made up by the
 * fake's planner. Runs move on by themselves (one step per status check). Everything the fake holds is lost when
 * it stops.
 *
 * It starts with four placeholder categories active and one example run that has already been through the folder
 * review, with saved answers and a second run compared against them (the owner asked to see the last steps
 * without doing the folder review first). A run the person starts themselves goes through every step.
 *
 *   node scripts/ui-harness/practice.mjs      then open the address it prints in Edge or Chrome
 */
import { startApp } from './app.mjs';
import { createFakeApi } from './fake-api.mjs';

const fake = createFakeApi();
fake.firstRun();
const example = fake.completed({ total: 12, agoMs: 3 * 3_600_000 });
fake.linkedRun(example, { moves: [{ index: 0, to: 'explainers' }], either: [{ index: 2, labels: ['procedures', 'explainers'] }] });
fake.autoAdvance = { steps: 1 };
const app = await startApp({ fake, port: Number(process.env.PRACTICE_PORT ?? 5199), logLevel: 'warn' });
console.log(`Practice app: ${app.url('#/')}  (Ctrl+C stops it)`);
