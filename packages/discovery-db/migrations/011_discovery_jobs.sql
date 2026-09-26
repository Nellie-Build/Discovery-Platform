-- Extended processing: a discovery job runs one user-started search as a series of bounded batches (discovery runs) in
-- the background, instead of one long HTTP request. Only a user creates a job (POST /projects/:id/jobs); nothing is
-- ever scheduled or repeated by itself. The job row is the durable state: the original request, the user's hard limits,
-- what has been used so far, and the last run whose continuation the next batch picks up. A worker claims a job with a
-- lease (lease_owner/lease_until) so two processes never run the same job at once; an expired lease after a crash is
-- claimed again and continues from the last run that finished, so no work is repeated without bound (attempts) and no
-- record is stored twice (records are deduplicated by the domain, as for any run).
CREATE TABLE discovery_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  -- queued: waiting for a worker; running: a worker holds it (or held it, until the lease expires); paused/stopping/
  -- stopped/completed/failed as the user or the limits decide. Only queued and running jobs are ever claimed.
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'paused', 'stopping', 'stopped', 'completed', 'failed')),
  request JSONB NOT NULL,
  limits JSONB NOT NULL,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The last batch that finished (its stats.continuation is the next batch's work) and the batch in progress, if any.
  last_run_id UUID REFERENCES discovery_runs(id) ON DELETE SET NULL,
  current_run_id UUID REFERENCES discovery_runs(id) ON DELETE SET NULL,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX discovery_jobs_project_idx ON discovery_jobs(project_id, created_at DESC);
CREATE INDEX discovery_jobs_claimable_idx ON discovery_jobs(updated_at) WHERE status IN ('queued', 'running');
-- At most one unfinished job per project: a second start request is refused by the database itself, not only by the API.
CREATE UNIQUE INDEX discovery_jobs_one_active_per_project ON discovery_jobs(project_id) WHERE status IN ('queued', 'running', 'paused', 'stopping');
