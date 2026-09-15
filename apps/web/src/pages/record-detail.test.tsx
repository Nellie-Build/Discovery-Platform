import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RecordDetailPage } from './record-detail';
import '../domains';

// RecordDetailPage's only data dependency is useAsync(() => api.records.get(id)) — mocking that
// hook directly (rather than a rejecting api.records.get inside a live effect) tests the same
// loading/error/success rendering without depending on exactly when a promise settles relative
// to render (see protected-route.test.tsx for the same reasoning, and the fase 2.2 report for
// why: this sidesteps a jsdom/Vitest test-environment timing quirk, not a product behavior).
const useAsyncMock = vi.fn();
vi.mock('../hooks/use-async', () => ({ useAsync: () => useAsyncMock() }));

function renderRecordDetail() {
  return render(
    <MemoryRouter initialEntries={['/records/r1']}>
      <Routes>
        <Route path="/records/:id" element={<RecordDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RecordDetailPage', () => {
  it('shows the summary, found information, sources (provenance) and contact — never raw JSON as the primary view', () => {
    useAsyncMock.mockReturnValue({
      loading: false, error: null, refetch: vi.fn(),
      data: {
        id: 'r1', project_id: 'p1', domain: 'vacancies', status: 'new', display_name: 'Frontend Developer',
        domain_data: { title: 'Frontend Developer', company: 'Acme', location: 'Utrecht', salary: null, email: 'jobs@acme.example' },
        classification: { presentSignals: ['title', 'company'], missingSignals: ['salary'] },
        score: 60, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        sources: [{
          id: 's1', record_id: 'r1', source_type: 'website', source_url: 'https://acme.example/careers/frontend',
          source_label: null, source_data: {}, discovered_at: new Date().toISOString(),
        }],
        contacts: [{ id: 'c1', record_id: 'r1', type: 'email', value: 'jobs@acme.example', normalized_value: null, source_id: 's1', confirmed: false, created_at: new Date().toISOString() }],
      },
    });
    renderRecordDetail();

    expect(screen.getByRole('heading', { name: 'Frontend Developer' })).toBeInTheDocument();
    expect(screen.getAllByText('60').length).toBeGreaterThan(0); // score (may also appear as a data point elsewhere)

    // Found information
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Utrecht')).toBeInTheDocument();
    // Unknown value (salary) renders as an em-dash placeholder, never a fabricated default.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);

    // Provenance is a first-class section with a clickable link, not hidden JSON.
    expect(screen.getByText(/found on company website/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://acme.example/careers/frontend' })).toHaveAttribute(
      'href', 'https://acme.example/careers/frontend',
    );

    // Contact is clickable — shown both in "Found information" and the dedicated "Contact" card.
    const emailLinks = screen.getAllByRole('link', { name: 'jobs@acme.example' });
    expect(emailLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of emailLinks) expect(link).toHaveAttribute('href', 'mailto:jobs@acme.example');

    // Raw JSON exists but only inside a collapsed debug accordion, not as the main view.
    const debugSummary = screen.getByText('Raw data (debug)');
    expect(debugSummary.closest('details')).not.toHaveAttribute('open');
  });

  it('shows a loading state while the record is being fetched', () => {
    useAsyncMock.mockReturnValue({ loading: true, error: null, data: null, refetch: vi.fn() });
    renderRecordDetail();
    expect(screen.getByText(/loading record/i)).toBeInTheDocument();
  });

  it('shows an error state when the record cannot be loaded', () => {
    useAsyncMock.mockReturnValue({ loading: false, error: 'Record not found.', data: null, refetch: vi.fn() });
    renderRecordDetail();
    expect(screen.getByText('Record not found.')).toBeInTheDocument();
  });
});
