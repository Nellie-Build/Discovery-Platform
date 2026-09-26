import type { DiscoveryRecord, DiscoveryRun, Project, WorkspaceModule } from '@discovery-platform/client';
import { api } from './api';
import { getDomainRenderer } from '../domains/registry';
export interface DashboardData {
  workspaceId: string;
  modules: WorkspaceModule[];
  projects: Project[];
  records: DiscoveryRecord[];
  runs: DiscoveryRun[];
  unavailable: string[];
}
/** Use the server's effective global + package + workspace decision. Fail closed. */
export async function loadDashboard(workspaceId: string): Promise<DashboardData> {
  const [access, allProjects] = await Promise.all([
    api.workspaces.modules(workspaceId),
    api.projects.listByWorkspace(workspaceId),
  ]);
  const modules = access.filter((module) => module.enabled);
  const projects = allProjects.filter(
    (project) =>
      project.workspace_id === workspaceId &&
      !project.deleted_at &&
      modules.some((module) => module.module_id === project.domain),
  );
  const unavailable: string[] = [];
  const items = await Promise.all(
    projects.map(async (project) => {
      const [records, runs] = await Promise.allSettled([
        api.records.listByProject(project.id),
        api.runs.listByProject(project.id),
      ]);
      if (records.status === 'rejected') unavailable.push(`Resultaten van ${project.name}`);
      if (runs.status === 'rejected') unavailable.push(`Zoekruns van ${project.name}`);
      return {
        records:
          records.status === 'fulfilled'
            ? records.value.filter((record) => record.project_id === project.id && record.domain === project.domain)
            : [],
        runs: runs.status === 'fulfilled' ? runs.value.filter((run) => run.project_id === project.id) : [],
      };
    }),
  );
  return {
    workspaceId,
    modules,
    projects,
    unavailable,
    records: items.flatMap((item) => item.records),
    runs: items.flatMap((item) => item.runs),
  };
}
/** Domain grouping is scoped to the project; original records remain untouched. */
export function dashboardRecordGroups(records: DiscoveryRecord[]): DiscoveryRecord[][] {
  const buckets = new Map<string, DiscoveryRecord[]>();
  for (const record of records) {
    const key = JSON.stringify([record.project_id, record.domain]);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }
  return [...buckets.values()].flatMap(
    (bucket) => getDomainRenderer(bucket[0].domain).groupRecords?.(bucket) ?? bucket.map((record) => [record]),
  );
}
export const runUrl = (run: DiscoveryRun) => `/projects/${run.project_id}?run=${encodeURIComponent(run.id)}`;
export const activityTime = (project: Project, runs: DiscoveryRun[], records: DiscoveryRecord[]) =>
  Math.max(
    Date.parse(project.updated_at),
    Date.parse(project.created_at),
    ...runs
      .filter((run) => run.project_id === project.id)
      .map((run) => Date.parse(run.completed_at ?? run.started_at ?? run.created_at)),
    ...records.filter((record) => record.project_id === project.id).map((record) => Date.parse(record.updated_at)),
  );
