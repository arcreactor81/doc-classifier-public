PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS bakeoff_campaigns (
  id TEXT PRIMARY KEY,
  plan_sha256 TEXT NOT NULL,
  init_sha256 TEXT NOT NULL,
  max_liquid_nano INTEGER CHECK(max_liquid_nano IS NULL OR max_liquid_nano=2000000000),
  max_typesafe_nano INTEGER CHECK(max_typesafe_nano IS NULL OR max_typesafe_nano=1000000000),
  budget_json TEXT CHECK(budget_json IS NULL OR json_valid(budget_json)),
  unknown_spend_policy TEXT,
  allowed_arm_id TEXT,
  allowed_model TEXT,
  liquid_nano INTEGER NOT NULL DEFAULT 0 CHECK(liquid_nano>=0),
  typesafe_nano INTEGER NOT NULL DEFAULT 0 CHECK(typesafe_nano>=0),
  halted INTEGER NOT NULL DEFAULT 0 CHECK(halted IN (0,1)),
  halt_reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bakeoff_requests (
  campaign_id TEXT NOT NULL REFERENCES bakeoff_campaigns(id),
  arm_id TEXT NOT NULL,
  opaque_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('typesafe','liquid')),
  headers_json TEXT NOT NULL,
  PRIMARY KEY(campaign_id,arm_id,opaque_id)
);
CREATE TABLE IF NOT EXISTS bakeoff_attempts (
  campaign_id TEXT NOT NULL,
  arm_id TEXT NOT NULL,
  opaque_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('typesafe','liquid')),
  state TEXT NOT NULL CHECK(state IN ('claimed','started','complete','refused','failed','uncertain')),
  http_status INTEGER,
  cost_nano INTEGER CHECK(cost_nano>=0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY(campaign_id,arm_id,opaque_id),
  FOREIGN KEY(campaign_id,arm_id,opaque_id) REFERENCES bakeoff_requests(campaign_id,arm_id,opaque_id)
);
-- One fixed in-flight call per independent campaign, never an automatic concurrency increase.
-- Fresh full-test databases use this index; do not replace the earlier limited-campaign database/index.
CREATE UNIQUE INDEX IF NOT EXISTS bakeoff_one_in_flight ON bakeoff_attempts(campaign_id) WHERE state IN ('claimed','started');
CREATE TABLE IF NOT EXISTS bakeoff_continuations (
  campaign_id TEXT PRIMARY KEY REFERENCES bakeoff_campaigns(id),
  kind TEXT NOT NULL CHECK(kind='typesafe-only'),
  source_halt_reason TEXT NOT NULL,
  authorization TEXT NOT NULL CHECK(length(authorization)>0),
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS bakeoff_continuations_no_update BEFORE UPDATE ON bakeoff_continuations
BEGIN SELECT RAISE(ABORT,'Continuation receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS bakeoff_continuations_no_delete BEFORE DELETE ON bakeoff_continuations
BEGIN SELECT RAISE(ABORT,'Continuation receipts are immutable'); END;
