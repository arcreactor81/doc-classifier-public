CREATE TABLE definition_revisions(id TEXT PRIMARY KEY,base_revision_id TEXT REFERENCES definition_revisions(id),type_version TEXT NOT NULL,type_file_json TEXT NOT NULL,display_names_json TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL);
CREATE TRIGGER definition_revisions_no_update BEFORE UPDATE ON definition_revisions BEGIN SELECT RAISE(ABORT,'Definition revisions are immutable'); END;
CREATE TRIGGER definition_revisions_no_delete BEFORE DELETE ON definition_revisions BEGIN SELECT RAISE(ABORT,'Definition revisions are immutable'); END;
CREATE TABLE definition_active(id INTEGER PRIMARY KEY CHECK(id=1),revision_id TEXT REFERENCES definition_revisions(id),threshold REAL NOT NULL CHECK(threshold>=0 AND threshold<=1),threshold_status TEXT NOT NULL CHECK(threshold_status IN('untested','unverified','calibrated')),justification TEXT NOT NULL);
INSERT INTO definition_active VALUES(1,NULL,0.90,'untested','initial_design_threshold');
CREATE TABLE definition_activations(id TEXT PRIMARY KEY,revision_id TEXT NOT NULL UNIQUE REFERENCES definition_revisions(id),previous_revision_id TEXT,actor TEXT NOT NULL,created_at TEXT NOT NULL,threshold REAL NOT NULL,threshold_status TEXT NOT NULL,change_kind TEXT NOT NULL,justification TEXT NOT NULL);
CREATE TRIGGER definition_activations_no_update BEFORE UPDATE ON definition_activations BEGIN SELECT RAISE(ABORT,'Definition activations are immutable'); END;
CREATE TRIGGER definition_activations_no_delete BEFORE DELETE ON definition_activations BEGIN SELECT RAISE(ABORT,'Definition activations are immutable'); END;
