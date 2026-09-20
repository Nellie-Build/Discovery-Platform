-- Add provenance without guessing which historical run created a legacy record.
CREATE TABLE discovery_run_records (
  run_id UUID NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES discovery_records(id) ON DELETE CASCADE,
  snapshot JSONB NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, record_id)
);
CREATE INDEX discovery_run_records_record_idx ON discovery_run_records(record_id, seen_at);
