// Public API of @discovery-platform/db. A domain-neutral Workspace -> Project -> Discovery Run
// -> Record -> Sources/Contacts schema — see migrations/001_init.sql for the exact tables and
// docs/architecture.md for why domain-specific fields only ever live inside domain_data JSONB.
export { createPool, withTransaction, type Queryable, type QueryResultLike, type TransactionCapable } from './connection.js';
export { runMigrations } from './migrate.js';

export { WorkspacesRepository, type Workspace } from './repositories/workspaces.js';
export { ProjectsRepository, type Project, type CreateProjectInput } from './repositories/projects.js';
export { DiscoveryRunsRepository, type DiscoveryRun } from './repositories/runs.js';
export {
  DiscoveryRecordsRepository,
  type DiscoveryRecord, type RecordSource, type RecordContact, type RecordWithDetails, type NewRecordInput,
} from './repositories/records.js';
