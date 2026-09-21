import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '@discovery-platform/client';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace-context';
import { useAsync } from '../hooks/use-async';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input, Label, FieldError } from '../components/ui/input';
import { Dialog } from '../components/ui/dialog';
import { LoadingState, ErrorState, EmptyState } from '../components/ui/states';
import { getDomainRenderer } from '../domains/registry';

const DOMAIN_OPTIONS = [
  { value: 'vacancies', label: 'Vacancies', available: true },
  { value: 'tenders', label: 'Tenders', available: true },
  { value: 'companies', label: 'Companies', available: false },
  { value: 'housing', label: 'Housing', available: false },
  { value: 'candidates', label: 'Candidates', available: false },
];

function NewProjectDialog({ open, onClose, workspaceId, onCreated }: {
  open: boolean; onClose: () => void; workspaceId: string; onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('vacancies');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.projects.create({ workspaceId, name, domain });
      setName('');
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the project.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="New project">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <Label htmlFor="project-name">Project name</Label>
          <Input id="project-name" required autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Marketing agencies NL" />
        </div>
        <div>
          <Label htmlFor="project-domain">Domain</Label>
          <select
            id="project-domain"
            value={domain}
            onChange={e => setDomain(e.target.value)}
            className="block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm shadow-sm hover:border-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-1 transition-colors duration-200"
          >
            {DOMAIN_OPTIONS.map(option => (
              <option key={option.value} value={option.value} disabled={!option.available}>
                {option.label}{!option.available ? ' (coming soon)' : ''}
              </option>
            ))}
          </select>
        </div>
        <FieldError>{error}</FieldError>
        <div className="mt-2 flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={submitting}>{submitting ? 'Creating…' : 'Create project'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ProjectsPage() {
  const { current } = useWorkspace();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data: projects, loading, error, refetch } = useAsync(
    () => (current ? api.projects.listByWorkspace(current.id) : Promise.resolve([])),
    [current?.id],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Projects</h1>
          <p className="mt-1 text-sm text-slate-500">Each project crawls one domain of sources for {current?.name}.</p>
        </div>
        {current && <Button onClick={() => setDialogOpen(true)}>New project</Button>}
      </div>

      {loading && <LoadingState label="Loading projects…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}
      {!loading && !error && projects && projects.length === 0 && (
        <EmptyState
          title="Make your first Discovery project"
          description="Give it a name and a domain, then start your first Discovery run from the project page."
          action={<Button onClick={() => setDialogOpen(true)}>New project</Button>}
        />
      )}
      {!loading && !error && projects && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map(project => (
            <Link key={project.id} to={`/projects/${project.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="py-5">
                  <p className="font-semibold text-slate-900">{project.name}</p>
                  <p className="mt-1 text-sm text-slate-500">{getDomainRenderer(project.domain).recordLabelPlural}</p>
                  <p className="mt-3 text-xs text-slate-400">Created {new Date(project.created_at).toLocaleDateString()}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {current && (
        <NewProjectDialog open={dialogOpen} onClose={() => setDialogOpen(false)} workspaceId={current.id} onCreated={refetch} />
      )}
    </div>
  );
}
