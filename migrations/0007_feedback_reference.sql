CREATE TABLE IF NOT EXISTS feedback_references (id TEXT PRIMARY KEY, source_run_id TEXT NOT NULL REFERENCES runs(id), correction_id TEXT NOT NULL REFERENCES corrections(id), definition_revision_id TEXT NOT NULL REFERENCES definition_revisions(id), created_at TEXT NOT NULL, confirmed_by TEXT NOT NULL, labels_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feedback_run_links (run_id TEXT PRIMARY KEY REFERENCES runs(id), reference_id TEXT NOT NULL REFERENCES feedback_references(id));
CREATE TRIGGER IF NOT EXISTS feedback_references_no_update BEFORE UPDATE ON feedback_references BEGIN SELECT RAISE(ABORT,'Feedback references are immutable'); END;
CREATE TRIGGER IF NOT EXISTS feedback_references_no_delete BEFORE DELETE ON feedback_references BEGIN SELECT RAISE(ABORT,'Feedback references are immutable'); END;
CREATE TRIGGER IF NOT EXISTS feedback_run_links_no_update BEFORE UPDATE ON feedback_run_links BEGIN SELECT RAISE(ABORT,'Feedback run links are immutable'); END;
CREATE TRIGGER IF NOT EXISTS feedback_run_links_no_delete BEFORE DELETE ON feedback_run_links BEGIN SELECT RAISE(ABORT,'Feedback run links are immutable'); END;
