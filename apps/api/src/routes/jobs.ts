import { Router, type Request } from 'express';
import {
  ActiveJobExistsError, DiscoveryJobsRepository, DiscoveryRunsRepository, ProjectsRepository,
  type DiscoveryJob, type TransactionCapable,
} from '@discovery-platform/db';
import { asyncHandler, badRequest, notFound, HttpError } from '../http-errors.js';
import { assertWorkspaceAccess } from '../workspace-access.js';
import { assertModuleEnabled } from '../module-registry.js';
import { defaultDomainRegistry, type DomainRegistry } from '../domain-registry.js';
import { discoveryInputFrom } from '../run-executor.js';
import { jobLimits, jobUsage, resolveJobLimits } from '../jobs/job-runner.js';

/**
 * Extended processing (see jobs/job-runner.ts): start a search as a background job with the user's own limits, follow
 * its progress, and pause, resume or stop it. Every route resolves the job's project and checks workspace access and
 * module access, exactly as for runs; a job id alone is never enough. Starting returns 202 at once: the batches run in
 * the background, and their results are visible as each batch finishes.
 */
export function createJobsRouter(pool: TransactionCapable, domainRegistry: DomainRegistry = defaultDomainRegistry): Router {
  const router = Router();
  const projects = new ProjectsRepository(pool);
  const jobs = new DiscoveryJobsRepository(pool);
  const runs = new DiscoveryRunsRepository(pool);

  /** A job as the client sees it: state, limits, usage so far and its batches (runs), newest first. */
  async function present(job: DiscoveryJob) {
    const batches = (await runs.listRunsByProject(job.project_id)).filter(run => (run.stats as Record<string, unknown> | null)?.jobId === job.id);
    const usage = jobUsage(job);
    const limits = jobLimits(job);
    return {
      id: job.id, projectId: job.project_id, status: job.status, message: job.message,
      limits, usage,
      progress: { candidatesResearched: usage.candidatesResearched, maxCandidates: limits.maxCandidates, candidatesRemaining: usage.candidatesRemaining },
      batches: batches.map(run => {
        const stats = (run.stats ?? {}) as Record<string, unknown>;
        return {
          runId: run.id, status: run.status, batch: typeof stats.batch === 'number' ? stats.batch : 1, error: run.error,
          companiesResearched: stats.companiesResearched ?? 0, recordsCreated: stats.recordsCreated ?? 0, recordsUpdated: stats.recordsUpdated ?? 0,
          searchQueries: Array.isArray(stats.queries) ? stats.queries.length : 0, createdAt: run.created_at, completedAt: run.completed_at,
        };
      }),
      createdAt: job.created_at, updatedAt: job.updated_at, finishedAt: job.finished_at,
    };
  }

  async function projectFor(req: Request, projectId: string) {
    const project = await projects.getProjectById(projectId);
    if (!project) throw notFound('Project not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    return project;
  }

  /** A job id resolves to its project, then that project's workspace, before anything about the job is returned. */
  async function jobFor(req: Request) {
    const job = await jobs.getJobById(req.params.id);
    if (!job) throw notFound('Job not found.');
    const project = await projects.getProjectById(job.project_id);
    if (!project) throw notFound('Job not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    return { job, project };
  }

  router.post('/projects/:id/jobs', asyncHandler(async (req, res) => {
    const project = await projectFor(req, req.params.id);
    res.locals.projectId = project.id;
    const adapter = domainRegistry[project.domain];
    if (!adapter?.backgroundJobs) throw badRequest('jobs_not_supported', 'Uitgebreide verwerking is niet beschikbaar voor deze module.');
    await assertModuleEnabled(pool, project.domain, project.workspace_id);
    const body = req.body ?? {};
    const raw = body.request && typeof body.request === 'object' && !Array.isArray(body.request) ? body.request as Record<string, unknown> : null;
    if (!raw) throw badRequest('invalid_request', 'request is required.');
    // Only the fields of a run request are kept; a continuation or anything else is never part of a job's request.
    const { continueFromRunId: _ignored, ...request } = raw;
    const input = discoveryInputFrom(request, project.domain);
    const problem = adapter.backgroundJobs.validateRequest({ ...input, existingRecords: [] });
    if (problem) throw badRequest('invalid_request', problem);
    const limits = resolveJobLimits(body.limits);
    try {
      const job = await jobs.createJob({ projectId: project.id, createdBy: req.auth?.type === 'user' ? req.auth.userId : null, request, limits: { ...limits } });
      res.status(202).json(await present(job));
    } catch (error) {
      if (error instanceof ActiveJobExistsError) throw new HttpError(409, 'job_active', 'Er loopt al een uitgebreide verwerking voor dit project; pauzeer of stop die eerst.');
      throw error;
    }
  }));

  router.get('/projects/:id/jobs', asyncHandler(async (req, res) => {
    const project = await projectFor(req, req.params.id);
    res.json(await Promise.all((await jobs.listJobsByProject(project.id)).map(present)));
  }));

  router.get('/jobs/:id', asyncHandler(async (req, res) => {
    const { job } = await jobFor(req);
    res.json(await present(job));
  }));

  const action = (name: 'pause' | 'resume' | 'stop') => asyncHandler(async (req, res) => {
    const { job, project } = await jobFor(req);
    // Resuming spends budget again: the module must still be enabled for the workspace.
    if (name === 'resume') await assertModuleEnabled(pool, project.domain, project.workspace_id);
    const updated = await jobs[name](job.id);
    if (!updated) throw new HttpError(409, 'invalid_job_state', `Deze verwerking kan in de status "${job.status}" niet worden ${name === 'pause' ? 'gepauzeerd' : name === 'resume' ? 'hervat' : 'gestopt'}.`);
    res.json(await present(updated));
  });
  router.post('/jobs/:id/pause', action('pause'));
  router.post('/jobs/:id/resume', action('resume'));
  router.post('/jobs/:id/stop', action('stop'));

  return router;
}
