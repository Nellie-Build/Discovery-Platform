-- Source Registry — data model only for this phase (see docs/architecture.md): a generic place to
-- later register *known* sources (a specific job board, a "werken-bij" site, a government portal,
-- ...) for any module, not just search-engine-driven discovery. Deliberately left unseeded — no
-- large manual source list is filled in yet, only the shape a future admin screen and a module's
-- own provider registry can both build on. `module` is a plain string (matches `modules.id`),
-- never a domain-specific column — this table stays reusable by companies/housing/candidates
-- later with no schema change.
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT,
  type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  priority INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_successful_run TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'unknown',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sources_module_idx ON sources(module);
