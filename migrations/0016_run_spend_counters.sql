ALTER TABLE runs ADD COLUMN spend_openai_nano INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN spend_typesafe_nano INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN unknown_calls INTEGER NOT NULL DEFAULT 0;
UPDATE runs SET spend_openai_nano = (SELECT COALESCE(SUM(CAST(cost_nano AS INTEGER)), 0) FROM vendor_calls WHERE run_id = runs.id AND cost_nano IS NOT NULL AND role IN ('reader', 'recovery')), spend_typesafe_nano = (SELECT COALESCE(SUM(CAST(cost_nano AS INTEGER)), 0) FROM vendor_calls WHERE run_id = runs.id AND cost_nano IS NOT NULL AND role = 'confidence'), unknown_calls = (SELECT COUNT(*) FROM vendor_calls WHERE run_id = runs.id AND cost_nano IS NULL AND role != 'batch_metadata');
