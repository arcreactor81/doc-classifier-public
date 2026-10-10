/**
 * Registers every controller factory with the registry, once at boot (main.ts). Each controller package owns its
 * own file and its `register` function; this list only names the files, so packages never edit a shared file.
 */
import type { ControllerRegistry } from './registry.ts';
import { register as registerExtraction } from './extraction.ts';
import { register as registerConfirm } from './confirm.ts';
import { register as registerSend } from './send.ts';
import { register as registerBuild } from './build.ts';
import { register as registerTrial } from './trial.ts';
import { register as registerSaveCopy } from './save-copy.ts';
import { register as registerWalk } from './walk.ts';
import { register as registerBakeoff } from './bakeoff.ts';

export function registerControllers(registry: ControllerRegistry): void {
  registerExtraction(registry);
  registerConfirm(registry);
  registerSend(registry);
  registerBuild(registry);
  registerWalk(registry);
  registerTrial(registry);
  registerSaveCopy(registry);
  registerBakeoff(registry);
}
