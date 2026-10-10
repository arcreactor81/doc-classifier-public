/**
 * The one place vendor HTTP leaves the Worker. Production delegates to the global `fetch` at call time (so a local
 * runtime's outbound interception still sees every request). A separate build entry may install a replacement once,
 * before any request, which also marks the build as one whose vendors are pretend. No setting, header, variable or
 * request field can install anything: `installOutbound` is a code call, and its only caller is that separate entry.
 */
/** In-process simulation context only. Never a header/body field, and never forwarded to global fetch. */
export interface OutboundContext { readonly confidenceTypeIds: readonly string[] }
export type OutboundFetch = (input: string | URL, init?: RequestInit, context?: OutboundContext) => Promise<Response>;

/** Run-level note recorded at creation on every run made under a pretend-vendor build. Never a document note. */
export const FAKE_VENDORS_NOTE = 'N_FAKE_VENDORS';

/** Plain sentence shown wherever the label appears. */
export const FAKE_VENDORS_SENTENCE =
  'This deployment answers every model call itself with made-up results. Nothing here says anything about real documents.';

export const outbound: { fetch: OutboundFetch; vendors: 'live' | 'fake' } = {
  fetch: (input, init) => globalThis.fetch(input, init),
  vendors: 'live'
};

let installed = false;

/** Installs the pretend vendors. A second call is a defect and throws. */
export function installOutbound(fetchLike: OutboundFetch): void {
  if (installed) throw new Error('Pretend vendors were already installed in this build; they can be installed once.');
  if (typeof fetchLike !== 'function') throw new Error('Installing pretend vendors needs a function that answers requests.');
  installed = true;
  outbound.fetch = fetchLike;
  outbound.vendors = 'fake';
}

/** 'fake' when the run's recorded notes say it was made under a pretend-vendor build; otherwise nothing. */
export function runVendors(notes: readonly string[]): { vendors: 'fake' } | Record<string, never> {
  return notes.includes(FAKE_VENDORS_NOTE) ? { vendors: 'fake' } : {};
}
