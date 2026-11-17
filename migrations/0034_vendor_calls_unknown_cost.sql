CREATE INDEX vendor_calls_unknown_cost ON vendor_calls(run_id) WHERE cost_nano IS NULL;
