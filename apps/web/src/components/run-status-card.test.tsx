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

  describe('candidate breakdown', () => {
    const bucket = { discovered: 61, notProcessed: 0, noUsableData: 0, rejectedByRelevance: 11, relevant: 50, rejectedByDate: 3,
      duplicatesInRun: 6, alreadyKnown: 18, cutByTarget: 0, newRecords: 4, multiRecordExtra: 0 };

    it('shows how every discovered candidate ended up, and that the rows add up', () => {
      render(<RunStatusCard run={run({ stats: { searchMode: 'branch', breakdown: { ...bucket, byProvider: { indeed: { ...bucket, discovered: 40, rejectedByRelevance: 7, relevant: 33, rejectedByDate: 2, duplicatesInRun: 4, alreadyKnown: 17, newRecords: 3 } } } } })} />);
      const section = screen.getByTestId('run-breakdown');
      expect(section).toHaveTextContent('Kandidaten ontdekt61');
      expect(section).toHaveTextContent('Afgewezen op relevance11');
      expect(section).toHaveTextContent('Afgewezen op datumfilter3');
      expect(section).toHaveTextContent('Duplicaten binnen de run6');
      expect(section).toHaveTextContent('Al bekend in het project18');
      expect(section).toHaveTextContent('Nieuwe records4');
      expect(section).toHaveTextContent('Subtotaal: relevant na inhoudsfilter (staat al in de rijen hierboven)50');
      expect(section).not.toHaveTextContent('− Nieuwe records');
      expect(section).toHaveTextContent('Nieuwe records4');
      expect(section).toHaveTextContent('Per bron');
      expect(section).toHaveTextContent('Indeed');
    });

    it('is not shown for website runs or runs without a breakdown (older runs)', () => {
      render(<RunStatusCard run={run({ stats: { searchMode: 'branch' } })} />);
      expect(screen.queryByTestId('run-breakdown')).not.toBeInTheDocument();
    });

    it('does not show the breakdown for a website run even if the field were present', () => {
      render(<RunStatusCard run={run({ stats: { searchMode: 'website', breakdown: bucket } })} />);
      expect(screen.queryByTestId('run-breakdown')).not.toBeInTheDocument();
    });
  });

  describe('compact branch card', () => {
    const bucket = { discovered: 70, notProcessed: 17, noUsableData: 0, rejectedByRelevance: 2, relevant: 51, rejectedByDate: 0,
      duplicatesInRun: 1, alreadyKnown: 0, cutByTarget: 0, newRecords: 50, multiRecordExtra: 0 };
    const branchRun = () => run({ status: 'partial', stats: {
      searchMode: 'branch', targetRecords: 50, recordsAccepted: 50, candidatesFound: 70, candidatesProcessed: 53, factsFound: 53, recordsCreated: 50, duplicates: 1,
      pagesVisited: 53, stopReason: 'target_reached', breakdown: bucket, durationMs: 15000, sourcesRequested: 3, sourcesAvailable: 2, sourcesSucceeded: 2, sourcesFailed: 1,
      sources: [
        { provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 50, error: null },
        { provider: 'ts-jobspy', site: 'linkedin', status: 'partial', errorType: 'timeout', candidates: 20, error: 'x' },
        { provider: 'brave', site: 'brave', status: 'not_configured', candidates: 0, error: null },
      ],
    } });

    it('shows only the core figures on top, and separates result from source status', () => {
      render(<RunStatusCard run={branchRun()} />);
      const core = screen.getByTestId('run-core-figures');
      expect(core).toHaveTextContent('Doel50');
      expect(core).toHaveTextContent('Gevonden50');
      expect(core).toHaveTextContent('Nieuw50');
      expect(core).toHaveTextContent('Duur15s');
      expect(core).toHaveTextContent('ResultaatDoel bereikt');
      expect(core).toHaveTextContent('BronstatusGedeeltelijk — LinkedIn timeout');
    });

    it('no longer repeats candidate numbers or uses website wording outside the breakdown', () => {
      render(<RunStatusCard run={branchRun()} />);
      for (const label of ['Pages visited', 'Records found', 'New records', 'Kandidaatbronnen', 'Voortgang']) expect(screen.queryByText(label)).not.toBeInTheDocument();
      expect(screen.queryByText(/^Duplicates$/)).not.toBeInTheDocument();
      expect(screen.getByTestId('run-technical-details')).toHaveTextContent('Kandidaten verwerkt53');
    });

    it('a branch run without breakdown (older run) still shows its legacy fields', () => {
      render(<RunStatusCard run={run({ stats: { searchMode: 'branch', candidatesFound: 12, pagesVisited: 5, factsFound: 4, recordsCreated: 3 } })} />);
      expect(screen.queryByTestId('run-core-figures')).not.toBeInTheDocument();
      expect(screen.getByText('Kandidaatbronnen')).toBeInTheDocument();
    });

    it('website runs keep their own fields', () => {
      render(<RunStatusCard run={run({ stats: { searchMode: 'website', pagesVisited: 10, factsFound: 5, recordsCreated: 3, budgetSource: 'adaptive', targetRecords: 10, recordsAccepted: 3 } })} />);
      expect(screen.queryByTestId('run-core-figures')).not.toBeInTheDocument();
      expect(screen.getByText('Verwerkt')).toBeInTheDocument();
    });
  });

  describe('search location and provider queries', () => {
    const bucket = { discovered: 2, notProcessed: 0, noUsableData: 0, rejectedByRelevance: 0, relevant: 2, rejectedByDate: 0,
      duplicatesInRun: 0, alreadyKnown: 0, cutByTarget: 0, newRecords: 2, multiRecordExtra: 0 };
    const query = (location: string | null) => ({ searchTerm: 'Onderwijs', location, country: 'netherlands', resultsWanted: 30, timeoutMs: 19500 });

    it('shows Land and Regio / plaats separately for a run with a country', () => {
      render(<RunStatusCard run={run({ stats: { searchMode: 'branch', criteria: { mode: 'branch', branch: 'Onderwijs', country: 'Nederland', region: 'Zuid-Holland' } } })} />);
      expect(screen.getByText('Land')?.closest('div')?.textContent).toBe('LandNederland');
      expect(screen.getByText('Regio / plaats')?.closest('div')?.textContent).toBe('Regio / plaatsZuid-Holland');
    });

    it('an older run with only a region still shows "Regio"', () => {
      render(<RunStatusCard run={run({ stats: { searchMode: 'branch', criteria: { mode: 'branch', branch: 'Onderwijs', region: 'Nederland' } } })} />);
      expect(screen.getByText('Regio')).toBeInTheDocument();
      expect(screen.queryByText('Land')).not.toBeInTheDocument();
    });

    it('technical details list what each provider was asked and how many candidates were requested and returned', () => {
      render(<RunStatusCard run={run({ stats: { searchMode: 'branch', targetRecords: 50, recordsAccepted: 2, breakdown: bucket, stopReason: 'target_reached',
        sources: [
          { provider: 'ts-jobspy', site: 'indeed', status: 'ok', candidates: 2, error: null, query: query('Zuid-Holland'), requestedCandidates: 65, returnedCandidates: 2 },
          { provider: 'ts-jobspy', site: 'linkedin', status: 'partial', errorType: 'timeout', candidates: 19, error: 'x', query: query('Zuid-Holland, Netherlands'), requestedCandidates: 30, returnedCandidates: 19 },
        ] } })} />);
      const queries = screen.getByTestId('provider-queries');
      expect(queries).toHaveTextContent('IndeedZoektermOnderwijsLocatieZuid-HollandLandnetherlandsGevraagd / ontvangen65 / 2');
      expect(queries).toHaveTextContent('LinkedIn');
      expect(queries).toHaveTextContent('Zuid-Holland, Netherlands');
      expect(queries).toHaveTextContent('30 / 19');
      expect(queries).toHaveTextContent('Tijdslimiet20s');
    });
  });
});
