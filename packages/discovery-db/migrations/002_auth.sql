-- Authentication and workspace membership. Deliberately minimal: two roles ('owner', 'member'),
-- no invitations, no teams, no RBAC beyond that — see docs/architecture.md's multi-tenancy note.
-- A user's password is never stored in this table directly readable — only a bcrypt hash.

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every workspace access check in apps/api goes through this table — see
-- apps/api/src/workspace-access.ts. A user sees only the workspaces/projects/runs/records this
-- table says they belong to; there is deliberately no "list every workspace" query anywhere.
CREATE TABLE workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_id_idx ON workspace_members(user_id);

-- connect-pg-simple's own expected schema (session store for apps/api's cookie-based auth) —
-- created here, explicitly, rather than left to that library's own auto-create-on-boot option,
-- so this migration is the single source of truth for the whole schema.
CREATE TABLE session (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX session_expire_idx ON session(expire);
