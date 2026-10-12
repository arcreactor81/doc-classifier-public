ALTER TABLE feedback_references ADD COLUMN carried_from TEXT REFERENCES feedback_references(id);
