CREATE INDEX storage_circuit_outcomes_tripped ON storage_circuit_outcomes(run_id) WHERE set_aside=1 AND failures_after>=3;
