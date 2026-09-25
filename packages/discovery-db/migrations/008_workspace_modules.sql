-- Per-workspace module access, on top of the global Module Registry switch (004_admin_modules.sql).
-- A module is usable in a workspace only when it is enabled globally AND not switched off for that
-- workspace. Only explicit decisions are stored: a workspace without a row for a module simply follows
-- the global switch, so every existing workspace keeps exactly the access it had before this migration
-- (no backfill). Like the global switch, this only gates creating projects and starting runs (checked
-- server-side in apps/api/src/module-registry.ts); existing projects and records stay readable.
CREATE TABLE workspace_modules (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (workspace_id, module_id)
);
