CREATE TABLE definition_active_v2(id INTEGER PRIMARY KEY CHECK(id=1),revision_id TEXT REFERENCES definition_revisions(id),threshold REAL NOT NULL CHECK(threshold>=0 AND threshold<=1),threshold_status TEXT NOT NULL CHECK(threshold_status IN('untested','unverified','provisional','calibrated')),justification TEXT NOT NULL);
INSERT INTO definition_active_v2(id,revision_id,threshold,threshold_status,justification) SELECT id,revision_id,threshold,threshold_status,justification FROM definition_active;
DROP TABLE definition_active;
ALTER TABLE definition_active_v2 RENAME TO definition_active;
