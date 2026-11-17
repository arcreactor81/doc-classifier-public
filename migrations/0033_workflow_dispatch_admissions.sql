CREATE TABLE workflow_dispatch_admissions (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,fingerprint TEXT NOT NULL,workflow_id TEXT NOT NULL,admitted_ms INTEGER NOT NULL CHECK(typeof(admitted_ms)='integer' AND admitted_ms BETWEEN 0 AND 9007199254740991),FOREIGN KEY(run_id,fingerprint) REFERENCES documents(run_id,fingerprint));
CREATE INDEX workflow_dispatch_admissions_time ON workflow_dispatch_admissions(admitted_ms);
CREATE INDEX workflow_dispatch_admissions_document ON workflow_dispatch_admissions(run_id,fingerprint,admitted_ms DESC);
