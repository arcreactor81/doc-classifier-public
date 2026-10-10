ALTER TABLE runs ADD COLUMN pilot_skipped INTEGER NOT NULL DEFAULT 0 CHECK(pilot_skipped IN (0,1));
