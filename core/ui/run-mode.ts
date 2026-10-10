/**
 * The mode a run was recorded with. Every new run is Interactive: nothing chooses or suggests a mode any more. The
 * type keeps both values because the owner's older runs stay in the database as `batch` and are read, listed and
 * named as they were (the RunHeader's "How it runs" chip is honest history, never a choice).
 */
export type RunMode = 'interactive' | 'batch';
