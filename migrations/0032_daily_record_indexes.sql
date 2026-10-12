CREATE INDEX quotes_actor_created ON quotes(actor, created_at);
CREATE INDEX corrections_actor_created ON corrections(actor, created_at);
CREATE INDEX feedback_references_confirmed_by_created ON feedback_references(confirmed_by, created_at);
