-- Platform-level admin flag — distinct from a workspace's own 'owner'/'member' role (see
-- 002_auth.sql). An admin can manage the Module Registry and see every workspace's projects,
-- regardless of which workspaces they personally belong to. This column is the *only* source of
-- truth for "is this user an admin" anywhere in the system — see apps/api/src/admin-access.ts;
-- there is deliberately no hardcoded admin email anywhere in the frontend or backend.
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;

-- The Module Registry: which discovery modules exist, and whether each is currently enabled.
-- Generic on purpose — this table (and apps/api/src/module-registry.ts, which reads it) knows
-- nothing about vacancies/companies/housing specifically; `id` is just a domain string, matched
-- against a project's own `domain` column. A disabled module can never be used to create a new
-- project or start a new run (checked server-side, never only hidden in the UI); existing
-- projects/records for that module are left completely untouched.
CREATE TABLE modules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'coming_soon',
  version TEXT NOT NULL DEFAULT '0.1.0',
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vacancies is the only module with a real DomainAdapter today (see
-- apps/api/src/domain-registry.ts) — every other module row exists purely as registry/CMS
-- architecture, not yet functional (see docs/architecture.md's module registry note).
INSERT INTO modules (id, name, description, enabled, status, version, capabilities) VALUES
  ('vacancies', 'Vacatures', 'Discovery of job vacancies via websites, job boards and web search.', true, 'active', '1.0.0', '["website", "branch_search"]'::jsonb),
  ('companies', 'Bedrijven', 'Company discovery — not yet functional.', false, 'coming_soon', '0.1.0', '[]'::jsonb),
  ('housing', 'Woningen', 'Housing discovery — not yet functional.', false, 'coming_soon', '0.1.0', '[]'::jsonb),
  ('candidates', 'Kandidaten', 'Candidate discovery — not yet functional.', false, 'coming_soon', '0.1.0', '[]'::jsonb);
