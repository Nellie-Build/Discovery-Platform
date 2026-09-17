-- Soft delete for projects: a deleted project disappears from every normal listing and can never
-- start a new Discovery Run, but its records/runs stay in the database untouched — a full
-- "recycle bin" restore capability can be built on top of this later (see docs/architecture.md).
-- deleted_by is nullable: a dev-key caller (no associated user) can still soft-delete a project.

ALTER TABLE projects ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Every "normal" project query filters on deleted_at IS NULL — this partial index keeps that
-- filter cheap without ever indexing the (larger, growing) set of deleted rows.
CREATE INDEX projects_workspace_id_active_idx ON projects(workspace_id) WHERE deleted_at IS NULL;
