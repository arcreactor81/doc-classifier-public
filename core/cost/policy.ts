/** Shared enforced call-attempt ceilings used by execution and local/server cost estimates. */
export const EXECUTION_ATTEMPTS = {confidence:3,recovery:3,readerTransport:3,readerSchema:2} as const;
