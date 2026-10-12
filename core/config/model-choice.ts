import { readerOutputCap, requireProject, type ProjectPack } from './project.ts';

/** No menu is legacy behavior; a declared menu is never selected by an inferred or substituted identity. */
export function selectReaderModel(source: ProjectPack, selectedId?: unknown): ProjectPack {
  const pack = requireProject(source);
  const refuse = (): never => { throw Object.assign(new Error('Choose one of the reader models offered for this project.'),
    { code: 'E_READER_MODEL', kind: 'request', status: 400 }); };
  if (pack.readerModels === undefined) { if (selectedId !== undefined) return refuse(); return pack; }
  if (typeof selectedId !== 'string') return refuse();
  const choice = pack.readerModels.options.find(option => option.id === selectedId);
  if (!choice) return refuse();
  // A recorded choice whose cap came from its own rule no longer carries the project cap: choose from the unselected pack.
  const recorded = pack.selectedReaderModel === undefined ? undefined : pack.readerModels.options.find(option => option.id === pack.selectedReaderModel);
  if (recorded?.outputCap !== undefined && recorded.id !== choice.id) return refuse();
  // The choice is frozen into a copy; the source pack is never changed.
  const selected = structuredClone(pack);
  selected.selectedReaderModel = choice.id;
  selected.pins.reader = structuredClone(choice.pin);
  selected.prices.interactive.reader = structuredClone(choice.rates);
  selected.settings.promptCachePolicy = choice.promptCachePolicy;
  // An experimental reader names its thinking control; an OpenAI reader keeps the pack's effort.
  if (choice.readerEffort !== undefined) selected.settings.readerEffort = choice.readerEffort;
  // The experimental readers' cap fits this run's categories (owner decision of 7 October 2026).
  if (choice.outputCap !== undefined) selected.settings.readerMaxOutputTokens = readerOutputCap(choice.outputCap, pack.typeFile.types.length);
  selected.limits.readerContextTokens = choice.contextTokens;
  return requireProject(selected);
}

export interface ReaderModelIdentity { id: string | null; label: string; pin: string }

/** Display metadata taken from the same recorded choice as its execution settings. */
export function readerModelIdentity(pack: ProjectPack): ReaderModelIdentity {
  const id = pack.selectedReaderModel ?? pack.readerModels?.defaultId ?? null;
  const option = id === null ? undefined : pack.readerModels?.options.find(value => value.id === id);
  if (id !== null && !option) throw new Error('The recorded reader choice is not in the project menu.');
  return { id, label: option?.label ?? pack.pins.reader.id, pin: pack.pins.reader.id };
}
