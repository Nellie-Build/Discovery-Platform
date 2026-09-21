-- Registers the tenders (aanbestedingen) module in the Module Registry, DISABLED by default: it exists as
-- an adapter (apps/api/src/domains/tenders-adapter.ts) but is not offered until an admin enables it
-- (PATCH /admin/modules/tenders). No table or column is added — tender facts live in the generic
-- discovery_records.domain_data like every other domain's. Idempotent on purpose.
INSERT INTO modules (id, name, description, enabled, status, version, capabilities) VALUES
  ('tenders', 'Aanbestedingen', 'Discovery of public procurement notices (aanbestedingen) from API sources such as TenderNed.', false, 'coming_soon', '0.1.0', '["source_api"]'::jsonb)
ON CONFLICT (id) DO NOTHING;
