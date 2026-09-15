-- gen_random_uuid() is built into PostgreSQL 13+ (this project targets 16+); no extension needed.

-- Domain-neutral core schema: Workspace -> Project -> Discovery Run -> Record -> Sources/Contacts.
-- No domain (vacancies, companies, housing, candidates) may ever get its own column here — every
-- domain-specific fact lives inside discovery_records.domain_data (JSONB). This is the one rule
-- this migration exists to enforce structurally: adding a "salary" or "bedrooms" column later
-- would be a design mistake, not a natural evolution of this table.

CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A project always belongs to exactly one workspace, and always declares its domain up front.
-- workspace_id is present from day one (see docs/architecture.md's multi-tenancy note) even
-- though no auth/billing/team model exists yet — adding real multi-tenancy later is then a
-- product decision, never a schema migration touching every existing row.
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_workspace_id_idx ON projects(workspace_id);

-- One execution of "go discover records for this project" — a website crawl today, potentially
-- a different source kind later. stats/error capture the outcome without needing their own columns.
CREATE TABLE discovery_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX discovery_runs_project_id_idx ON discovery_runs(project_id);

-- The one generic record shape every domain module produces. `domain` is denormalized from the
-- owning project for cheap filtering; `domain_data` is the domain's own typed shape (VacancyFacts
-- today) — this table itself never interprets it. `classification`/`score` are populated by
-- whatever the domain's own scoring engine produced (see @discovery-platform/core's runScoring),
-- again opaque to this schema.
CREATE TABLE discovery_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  display_name TEXT,
  domain_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  classification JSONB NOT NULL DEFAULT '{}'::jsonb,
  score INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX discovery_records_project_id_idx ON discovery_records(project_id);
CREATE INDEX discovery_records_project_domain_idx ON discovery_records(project_id, domain);

-- Provenance: which page/source contributed to a record, and what it said. A record may have
-- several sources across several runs (a page revisited, or two different pages agreeing).
CREATE TABLE record_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id UUID NOT NULL REFERENCES discovery_records(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_url TEXT,
  source_label TEXT,
  source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX record_sources_record_id_idx ON record_sources(record_id);

-- Only explicitly discovered contact information — never inferred, never guessed. `type` is a
-- free-form label ('email', 'phone', 'whatsapp', ...) so a future domain needs no schema change
-- to add a new contact channel. `source_id` ties a contact back to the exact page it came from;
-- `confirmed` is for a future explicit human/verification step, defaulting to false.
CREATE TABLE record_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id UUID NOT NULL REFERENCES discovery_records(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  normalized_value TEXT,
  source_id UUID REFERENCES record_sources(id) ON DELETE SET NULL,
  confirmed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX record_contacts_record_id_idx ON record_contacts(record_id);
