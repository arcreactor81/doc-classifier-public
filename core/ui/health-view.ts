/**
 * Health (R1) → what the shell, Welcome, Confirm and System show (SPEC §6.2). Pure: no DOM, no I/O, no timers.
 *
 * READY means configuration readiness only (AGENTS §8). Blocker codes and server sentences stay in `technical`;
 * each blocker gets one plain line and who can act (error-copy.ts `blockerLine`). An unknown threshold status is
 * labelled "Unknown status: …", never guessed.
 */
import { blockerLine, meansNoCategories, type BlockerLine } from './error-copy.ts';
import { percent } from './format.ts';
import { phraseText, type Phrase } from './journey.ts';
import {
  THRESHOLD_STATUSES, readHealth, type HealthBlockerWire, type HealthProjectWire, type HealthWire, type ThresholdBasisWire,
  type VendorHistoryWire
} from './wire.ts';
import type { ThresholdStatus } from '../config/definitions.ts';

export interface HealthBlockerView extends BlockerLine {
  /** Details only: the server's code, sentences and details as sent. */
  technical: HealthBlockerWire;
}

export interface FilingView {
  /** The decimal the server recorded (Details: `decimal3`). */
  value: number;
  /** Whole percent for the normal path: "90%". */
  percent: string;
  status: ThresholdStatus | 'unknown';
  /** The status text as the server sent it (Details). */
  rawStatus: string;
  /** "untested", "unverified", "provisional", "confirmed", or "Unknown status: …". */
  statusPhrase: Phrase;
  /** The chip: "Filing certainty 90% · untested". */
  label: Phrase;
  /** VL R-6: dashed for untested, unverified, provisional and unknown; accent for calibrated. */
  chipStyle: 'dashed' | 'accent';
  /** S5; null until the server resolves the justification. */
  basis: ThresholdBasisWire | null;
  /** Details only: the raw justification id. */
  justification: string;
}

export interface HealthView {
  capacity?: import('./wire.ts').CategoryCapacityWire | null;
  /** Each reader on the menu: usable here or not, and why (DECISIONS 136). Empty when the service does not say. */
  readerOptions: readonly import('./wire.ts').ReaderReadinessWire[];
  /** Configuration readiness only. */
  ready: boolean;
  blockers: readonly HealthBlockerView[];
  /** Categories exist and are readable: false when none are active, the category file is empty, or unreadable. */
  categoriesActive: boolean;
  productName: string | null;
  /** Pass to `configureProjectCopy` before mounting the shell; null when the project names no product. */
  copyConfig: { productName: string; copyOverrides?: unknown } | null;
  filing: FilingView | null;
  /** The emergency stop is on (an `E_KILL_SWITCH` blocker). */
  emergencyStop: boolean;
  modelCallsEnabled: boolean;
  /**
   * Runs still holding uploaded text, across everyone's runs. Null when the database check failed (`E_STORAGE_D1`):
   * the server then sends its starting value 0, which is not a count (core/server/health.ts).
   */
  textHeldAllRuns: number | null;
  /** Vendor calls with unknown spend, across all runs; null when the record is unavailable. */
  unknownSpendAllRuns: number | null;
  /** The active revision (runtime mode); null in git mode or when none is active. */
  activeRevisionId: string | null;
  displayNames: Record<string, string> | null;
  typeVersion: string | null;
  /** Details and the A4 slot. */
  vendorHistory: VendorHistoryWire;
  /** Details only. */
  versions: { build: string | null; pins: unknown; vendors?: 'live' | 'fake' | null };
  project: HealthProjectWire;
}

const P = (key: string, args?: Readonly<Record<string, string | number>>): Phrase => (args ? { key, args } : { key });

function isThresholdStatus(value: string): value is ThresholdStatus {
  return (THRESHOLD_STATUSES as readonly string[]).includes(value);
}

/** The filing certainty for chips and System; also used for a run's frozen threshold and status. */
export function filingView(value: number, rawStatus: string, basis: ThresholdBasisWire | null, justification: string): FilingView {
  const status = isThresholdStatus(rawStatus) ? rawStatus : 'unknown';
  const statusPhrase = status === 'unknown'
    ? P('journey.certainty.unknown', { value: rawStatus })
    : P(`journey.certainty.${status}`);
  const shown = percent(value);
  return {
    value,
    percent: shown,
    status,
    rawStatus,
    statusPhrase,
    label: P('journey.certainty.chip', { percent: shown, status: phraseText(statusPhrase) }),
    chipStyle: status === 'calibrated' ? 'accent' : 'dashed',
    basis,
    justification
  };
}

function blockerView(wire: HealthBlockerWire): HealthBlockerView {
  return { ...blockerLine(wire.code, wire.details), technical: wire };
}

function categoriesActive(wire: HealthWire): boolean {
  const missing = wire.blockers.some(blocker => meansNoCategories(blocker.code, blocker.details));
  return !missing && wire.project.types !== null && wire.project.types.length > 0;
}

export function toHealthView(wire: HealthWire): HealthView {
  const project = wire.project;
  const threshold = wire.threshold;
  return {
    ...(Object.hasOwn(wire, 'capacity') ? { capacity: wire.capacity! } : {}),
    readerOptions: wire.readerOptions ?? [],
    ready: wire.status === 'READY',
    blockers: wire.blockers.map(blockerView),
    categoriesActive: categoriesActive(wire),
    productName: project.productName,
    copyConfig: project.productName === null ? null : {
      productName: project.productName,
      ...(Object.hasOwn(project, 'copyOverrides') ? { copyOverrides: project.copyOverrides } : {})
    },
    filing: threshold === null ? null : filingView(threshold.value, threshold.status, threshold.basis, threshold.justification),
    emergencyStop: wire.blockers.some(blocker => blocker.code === 'E_KILL_SWITCH'),
    modelCallsEnabled: wire.modelCallsEnabled,
    textHeldAllRuns: wire.blockers.some(blocker => blocker.code === 'E_STORAGE_D1') ? null : wire.textHeldRuns,
    unknownSpendAllRuns: wire.vendorHistory.unknownSpendCount,
    activeRevisionId: project.definitionRevisionId,
    displayNames: project.displayNames,
    typeVersion: project.typeVersion,
    vendorHistory: wire.vendorHistory,
    versions: wire.versions,
    project
  };
}

/** Validates an R1 body (wire.ts) and maps it. Throws `UiShapeError` on a body the UI cannot rely on. */
export function readHealthView(raw: unknown): HealthView {
  return toHealthView(readHealth(raw));
}
