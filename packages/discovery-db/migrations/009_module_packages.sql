-- Module packages: which modules a workspace gets, as one choice per workspace, on top of the global switch
-- (004_admin_modules.sql) and the per-workspace choices (008_workspace_modules.sql). Three things stay apart:
--   * the package choice          -> workspaces.module_package_id
--   * individual deviations       -> workspace_modules (unchanged; null/absent = follow the package)
--   * the resulting access rights -> the workspace_module_access view below, the ONE definition of access
-- A module is usable in a workspace only when it is on globally AND (the workspace's own choice, or else whether
-- its package includes it). The global switch always wins: no package can make a globally disabled module
-- available. The 'custom' package includes nothing by itself: every module is chosen individually.
-- No prices, plans or billing: packages are only a technical grouping of modules.

CREATE TABLE module_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_custom BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- What a package includes. Adding a future module (companies, housing, ...) to a package is one row here.
CREATE TABLE module_package_modules (
  package_id TEXT NOT NULL REFERENCES module_packages(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, module_id)
);

INSERT INTO module_packages (id, name, description, is_custom, sort_order) VALUES
  ('vacancies', 'Vacancies', 'Alleen de module Vacancies.', false, 1),
  ('tenders', 'Tenders', 'Alleen de module Tenders.', false, 2),
  ('complete', 'Compleet', 'Vacancies en Tenders.', false, 3),
  ('custom', 'Maatwerk', 'Elke module wordt afzonderlijk ingesteld.', true, 4);

INSERT INTO module_package_modules (package_id, module_id) VALUES
  ('vacancies', 'vacancies'),
  ('tenders', 'tenders'),
  ('complete', 'vacancies'),
  ('complete', 'tenders');

-- Effective access as it is right now (008's rule), to prove below that this migration changes nothing.
CREATE TEMP TABLE access_before_009 AS
  SELECT w.id AS workspace_id, m.id AS module_id, (m.enabled AND COALESCE(wm.enabled, true)) AS enabled
  FROM workspaces w CROSS JOIN modules m
  LEFT JOIN workspace_modules wm ON wm.workspace_id = w.id AND wm.module_id = m.id;

-- New workspaces get 'complete' (Vacancies and Tenders: exactly what a new workspace could use until now).
ALTER TABLE workspaces ADD COLUMN module_package_id TEXT NOT NULL DEFAULT 'complete' REFERENCES module_packages(id);

-- Existing workspaces: the non-custom package whose modules are exactly the packaged modules this workspace has
-- not switched off itself; 'custom' when no package matches. Existing individual choices are kept as they are.
UPDATE workspaces w SET module_package_id = COALESCE((
  SELECT p.id FROM module_packages p
  WHERE NOT p.is_custom
    AND NOT EXISTS (  -- every packaged module the workspace allows is in p ...
      SELECT 1 FROM (SELECT DISTINCT module_id FROM module_package_modules) c
      LEFT JOIN workspace_modules wm ON wm.workspace_id = w.id AND wm.module_id = c.module_id
      WHERE COALESCE(wm.enabled, true)
        AND NOT EXISTS (SELECT 1 FROM module_package_modules pm WHERE pm.package_id = p.id AND pm.module_id = c.module_id))
    AND NOT EXISTS (  -- ... and p includes nothing the workspace switched off
      SELECT 1 FROM module_package_modules pm
      JOIN workspace_modules wm ON wm.workspace_id = w.id AND wm.module_id = pm.module_id
      WHERE pm.package_id = p.id AND wm.enabled = false)
  ORDER BY p.sort_order LIMIT 1
), 'custom');

CREATE VIEW workspace_module_access AS
  SELECT
    w.id AS workspace_id,
    m.id AS module_id,
    m.name AS module_name,
    p.id AS package_id,
    m.enabled AS global_enabled,
    (pm.module_id IS NOT NULL) AS package_included,
    wm.enabled AS workspace_enabled,
    -- An individual choice that differs from what the package gives (never for 'custom', where every choice is individual).
    (wm.enabled IS NOT NULL AND NOT p.is_custom AND wm.enabled <> (pm.module_id IS NOT NULL)) AS deviates,
    (m.enabled AND COALESCE(wm.enabled, pm.module_id IS NOT NULL)) AS enabled
  FROM workspaces w
  JOIN module_packages p ON p.id = w.module_package_id
  CROSS JOIN modules m
  LEFT JOIN module_package_modules pm ON pm.package_id = p.id AND pm.module_id = m.id
  LEFT JOIN workspace_modules wm ON wm.workspace_id = w.id AND wm.module_id = m.id;

-- A module a workspace could use before but its package does not include (possible only for a globally enabled
-- module outside every package) keeps working through an explicit individual choice. This only ever keeps access;
-- the new rule can never grant more than the old one, so nothing is switched on here.
INSERT INTO workspace_modules (workspace_id, module_id, enabled)
  SELECT b.workspace_id, b.module_id, true
  FROM access_before_009 b JOIN workspace_module_access a USING (workspace_id, module_id)
  WHERE b.enabled AND NOT a.enabled;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM access_before_009 b JOIN workspace_module_access a USING (workspace_id, module_id)
    WHERE a.enabled IS DISTINCT FROM b.enabled
  ) THEN
    RAISE EXCEPTION '009_module_packages would change the effective module access of an existing workspace';
  END IF;
END $$;

DROP TABLE access_before_009;
