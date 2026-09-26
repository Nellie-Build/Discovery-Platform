import { Router } from 'express';
import { ProjectsRepository, DiscoveryRecordsRepository, type TransactionCapable } from '@discovery-platform/db';
import { asyncHandler, badRequest, notFound, HttpError } from '../http-errors.js';
import { assertWorkspaceAccess } from '../workspace-access.js';
import { defaultDomainRegistry, type DomainRegistry } from '../domain-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createRecordsRouter(pool: TransactionCapable, domainRegistry: DomainRegistry = defaultDomainRegistry): Router {
  const router = Router();
  const projects = new ProjectsRepository(pool);
  const records = new DiscoveryRecordsRepository(pool);

  // Always scoped to one project — the same isolation boundary as GET /projects.
  router.get('/projects/:id/records', asyncHandler(async (req, res) => {
    const project = await projects.getProjectById(req.params.id);
    if (!project) throw notFound('Project not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    const domain = typeof req.query.domain === 'string' ? req.query.domain : undefined;
    const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
    if (runId && !/^[0-9a-f-]{36}$/i.test(runId)) throw notFound('Run not found.');
    res.json(await records.listRecordsByProject(project.id, { domain, runId }));
  }));

  // A record id alone is never enough — resolve its project, then that project's workspace,
  // before ever returning the record. This is what stops a record id from another workspace
  // being usable to read that workspace's data.
  router.get('/records/:id', asyncHandler(async (req, res) => {
    const record = await records.getRecordById(req.params.id);
    if (!record) throw notFound('Record not found.');
    const project = await projects.getProjectById(record.project_id);
    if (!project) throw notFound('Record not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    res.json(record);
  }));

  // CSV export of this project's records: all of them, or only the ones the client lists (e.g. the filtered view). Listed
  // ids that are not this project's records are ignored, never looked up elsewhere. The domain builds the file.
  router.post('/projects/:id/export', asyncHandler(async (req, res) => {
    const project = await projects.getProjectById(req.params.id);
    if (!project) throw notFound('Project not found.');
    await assertWorkspaceAccess(pool, req, project.workspace_id);
    const exporter = domainRegistry[project.domain]?.exportCsv;
    if (!exporter) throw badRequest('export_not_supported', 'Exporteren is niet beschikbaar voor deze module.');
    const ids = req.body?.recordIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > exporter.maxRows || !ids.every(id => typeof id === 'string' && UUID.test(id)))) {
      throw badRequest('invalid_record_ids', `recordIds must be a list of at most ${exporter.maxRows} record ids.`);
    }
    let rows = await records.listRecordsByProject(project.id, { domain: project.domain });
    if (ids !== undefined) { const wanted = new Set(ids as string[]); rows = rows.filter(record => wanted.has(record.id)); }
    if (rows.length > exporter.maxRows) throw new HttpError(413, 'export_too_large', `Maximaal ${exporter.maxRows} bedrijven per export; filter de resultaten eerst.`);
    const { csv, filename } = exporter.build(rows.map(record => ({ id: record.id, displayName: record.display_name, domainData: record.domain_data })));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  }));

  return router;
}
