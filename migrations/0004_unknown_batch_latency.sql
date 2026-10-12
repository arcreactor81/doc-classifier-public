CREATE TABLE vendor_calls_v2 (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), fingerprint TEXT NOT NULL, role TEXT NOT NULL, model_requested TEXT NOT NULL, model_returned TEXT, status INTEGER, latency_ms INTEGER, request_id TEXT, usage_json TEXT, cost_nano TEXT, raw_key TEXT NOT NULL REFERENCES artifacts(key), created_at TEXT NOT NULL);
INSERT INTO vendor_calls_v2 SELECT attempt_id,run_id,fingerprint,role,model_requested,model_returned,status,latency_ms,request_id,usage_json,cost_nano,raw_key,created_at FROM vendor_calls;
DROP TABLE vendor_calls;
ALTER TABLE vendor_calls_v2 RENAME TO vendor_calls;
CREATE INDEX vendor_calls_run ON vendor_calls(run_id);