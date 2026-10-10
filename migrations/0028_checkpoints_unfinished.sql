CREATE INDEX IF NOT EXISTS checkpoints_unfinished ON checkpoints(run_id, fingerprint, name) WHERE status!='complete';
