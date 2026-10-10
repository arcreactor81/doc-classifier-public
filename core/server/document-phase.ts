/**
 * A plain, measured stage for one document, derived from its durable checkpoints (D1), never from timers.
 * It says where the document is in the pipeline; it is not a progress estimate.
 */
export type DocumentPhase =
  | 'waiting_to_start'
  | 'starting'
  | 'finding_headings'
  | 'preparing_text'
  | 'confidence_check'
  | 'reader'
  | 'deciding'
  | 'done';

const ORDER: readonly DocumentPhase[] = [
  'waiting_to_start', 'starting', 'finding_headings', 'preparing_text', 'confidence_check', 'reader',
  'deciding', 'done'
];

function phaseOf(checkpoint: string): DocumentPhase | null {
  if (checkpoint === 'started') return 'starting';
  if (checkpoint.startsWith('recovery')) return 'finding_headings';
  if (checkpoint === 'digest') return 'preparing_text';
  if (checkpoint.startsWith('confidence')) return 'confidence_check';
  if (checkpoint.startsWith('reader')) return 'reader';
  if (checkpoint === 'decide' || checkpoint === 'record-decision') return 'deciding';
  return null;
}

export function documentPhase(
  status: string,
  checkpoints: readonly { name: string; status: string }[]
): DocumentPhase {
  if (status === 'complete') return 'done';
  let furthest: DocumentPhase = 'waiting_to_start';
  for (const checkpoint of checkpoints) {
    const phase = phaseOf(checkpoint.name);
    if (phase && ORDER.indexOf(phase) > ORDER.indexOf(furthest)) furthest = phase;
  }
  return furthest;
}
