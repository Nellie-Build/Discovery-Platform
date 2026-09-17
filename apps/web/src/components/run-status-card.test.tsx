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

  it('shows Branche/Regio/Kandidaatbronnen for a branch-search run', () => {
    render(<RunStatusCard run={run({
      stats: { searchMode: 'branch', branch: 'Security', region: 'Nederland', candidatesFound: 12, candidatesCrawled: 8, pagesVisited: 8, factsFound: 3, recordsCreated: 3 },
    })} />);
    expect(screen.getByText('Branche')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
    expect(screen.getByText('Regio')).toBeInTheDocument();
    expect(screen.getByText('Nederland')).toBeInTheDocument();
    expect(screen.getByText('Kandidaatbronnen')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('never shows Branche/Regio/Kandidaatbronnen for a website-mode run', () => {
    render(<RunStatusCard run={run({ stats: { searchMode: 'website', pagesVisited: 10, factsFound: 5, recordsCreated: 3 } })} />);
    expect(screen.queryByText('Branche')).not.toBeInTheDocument();
    expect(screen.queryByText('Kandidaatbronnen')).not.toBeInTheDocument();
  });

  it('shows a compact Sources section per provider for a branch-search run, including a disabled entry for a source that never ran', () => {
    render(<RunStatusCard run={run({
      stats: {
        searchMode: 'branch', branch: 'Security', recordsCreated: 3,
        sources: [
          { provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 12, durationMs: 500, error: null },
          { provider: 'ts-jobspy', site: 'linkedin', status: 'ok', candidates: 8, durationMs: 400, error: null },
        ],
      },
    })} />);
    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(screen.getByText('Indeed')).toBeInTheDocument();
    expect(screen.getByText('12 results')).toBeInTheDocument();
    expect(screen.getByText('LinkedIn')).toBeInTheDocument();
    expect(screen.getByText('8 results')).toBeInTheDocument();
    expect(screen.getByText('Web Search')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('does not show a Sources section when a branch-search run has no stats.sources at all', () => {
    render(<RunStatusCard run={run({ stats: { searchMode: 'branch', branch: 'Security', recordsCreated: 0 } })} />);
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });

  it('never shows a Sources section for a website-mode run', () => {
    render(<RunStatusCard run={run({ stats: { searchMode: 'website', pagesVisited: 10, factsFound: 5, recordsCreated: 3 } })} />);
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
  });

  it('shows Doel/Gevonden/Kandidaten/Verwerkt and a Dutch "Gestopt omdat" label when the target was reached', () => {
    render(<RunStatusCard run={run({
      stats: {
        pagesVisited: 126, factsFound: 100, recordsCreated: 100,
        targetRecords: 100, recordsAccepted: 100, candidatesDiscovered: 217, candidatesProcessed: 126,
        duplicates: 14, stopReason: 'target_reached',
      },
    })} />);
    expect(screen.getByText('Doel')?.closest('div')?.textContent).toBe('Doel100');
    expect(screen.getByText('Gevonden')?.closest('div')?.textContent).toBe('Gevonden100');
    expect(screen.getByText('Kandidaten')?.closest('div')?.textContent).toBe('Kandidaten217');
    expect(screen.getByText('Verwerkt')?.closest('div')?.textContent).toBe('Verwerkt126');
    expect(screen.getByText('Gestopt omdat')?.closest('div')?.textContent).toBe('Gestopt omdatDoel bereikt');
  });

  it('shows the Dutch label for a run that stopped before reaching its target', () => {
    render(<RunStatusCard run={run({
      stats: { targetRecords: 100, recordsAccepted: 63, stopReason: 'no_more_candidates' },
    })} />);
    expect(screen.getByText('63')).toBeInTheDocument();
    expect(screen.getByText('Geen kandidaten meer')).toBeInTheDocument();
  });

  it('falls back to the raw code for an unrecognized stopReason rather than hiding the field', () => {
    render(<RunStatusCard run={run({ stats: { stopReason: 'something_new' } })} />);
    expect(screen.getByText('something_new')).toBeInTheDocument();
  });
});
