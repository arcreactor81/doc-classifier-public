CREATE INDEX IF NOT EXISTS artifacts_run_text ON artifacts(run_id, contains_text, deleted_at);
CREATE INDEX IF NOT EXISTS vendor_calls_created ON vendor_calls(created_at, attempt_id);
CREATE INDEX IF NOT EXISTS runs_actor_created ON runs(actor, created_at);
CREATE INDEX IF NOT EXISTS runs_status_id ON runs(status, id);
CREATE INDEX IF NOT EXISTS events_run_stage_kind ON events(run_id, stage, kind, created_at);
