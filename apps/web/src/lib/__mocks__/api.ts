import { vi } from 'vitest';

// A hand-written mock of ../api's shape — every test that needs the API mocked calls
// `vi.mock('../lib/api')` (or a relative path to this file) and then sets up return values on
// these vi.fn()s directly, instead of each test file inventing its own ad hoc fetch mock.
export const api = {
  auth: { register: vi.fn(), login: vi.fn(), logout: vi.fn(), me: vi.fn() },
  workspaces: { listMine: vi.fn(), get: vi.fn(), create: vi.fn(), modules: vi.fn() },
  projects: { listByWorkspace: vi.fn(), get: vi.fn(), create: vi.fn(), delete: vi.fn() },
  runs: { start: vi.fn(), startBranchSearch: vi.fn(), startSourceRun: vi.fn(), continueRun: vi.fn(), listByProject: vi.fn(), get: vi.fn() },
  records: { listByProject: vi.fn(), get: vi.fn(), exportCsv: vi.fn() },
  jobs: { start: vi.fn(), listByProject: vi.fn(), get: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn() },
  admin: {
    modules: { list: vi.fn(), setEnabled: vi.fn() },
    modulePackages: { list: vi.fn() },
    workspaceModules: { list: vi.fn(), set: vi.fn(), setPackage: vi.fn() },
    projects: { list: vi.fn(), restore: vi.fn() },
  },
};
