import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { DiscoveryRun } from '@discovery-platform/client';
import { RunStatusCard } from './run-status-card';

function run(overrides: Partial<DiscoveryRun> = {}): DiscoveryRun {
  return {
    id: 'r1', project_id: 'p1', status: 'succeeded',
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    stats: { pagesVisited: 10, factsFound: 5, recordsCreated: 3 },
    error: null, created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('RunStatusCard', () => {
  it('shows "New records" from stats.recordsCreated — the field every run endpoint actually returns (GET /runs/:id and GET /projects/:id/runs included), never only the POST-response-only top-level recordsCreated', () => {
    // GET /runs/:id and GET /projects/:id/runs return the raw DB row: no top-level
    // recordsCreated at all, only the persisted stats.recordsCreated.
    render(<RunStatusCard run={run({ recordsCreated: undefined })} />);
    expect(screen.getByText('New records')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('still shows the right count when the POST /projects/:id/runs response is rendered directly (both the top-level and stats field agree)', () => {
    render(<RunStatusCard run={run({ recordsCreated: 3 })} />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('falls back to the placeholder, never a raw "undefined" or "NaN", when stats has no recordsCreated at all', () => {
    render(<RunStatusCard run={run({ stats: { pagesVisited: 10, factsFound: 5 } })} />);
    const field = screen.getByText('New records').closest('div');
    expect(field).not.toBeNull();
    expect(field?.textContent).toContain('—');
  });
});
