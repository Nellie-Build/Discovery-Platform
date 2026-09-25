import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
import { Icon } from '../components/ui/icon';
import { modulePresentation } from '../lib/module-presentation';

const DOMAIN_OPTIONS = [
  { value: 'vacancies', label: 'Vacancies', available: true },
  { value: 'tenders', label: 'Tenders', available: true },
  { value: 'companies', label: 'Companies', available: true },
  { value: 'housing', label: 'Housing', available: false },
  { value: 'candidates', label: 'Candidates', available: false },
];

function NewProjectDialog({
  open,
  onClose,
  workspaceId,
  onCreated,
  initialDomain,
}: {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  onCreated: () => void;
  initialDomain?: string;
}) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState(initialDomain ?? 'vacancies');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Fail closed while access is unavailable; the server remains the authority.
  const {
    data: workspaceModules,
    error: modulesError,
    loading: modulesLoading,
    refetch: retryModules,
  } = useAsync(() => api.workspaces.modules(workspaceId), [workspaceId]);
  const notForWorkspace = (value: string) => !workspaceModules?.some((m) => m.module_id === value && m.enabled);
  const options = [
    ...DOMAIN_OPTIONS,
    ...(workspaceModules ?? [])
      .filter((module) => !DOMAIN_OPTIONS.some((option) => option.value === module.module_id))
      .map((module) => ({ value: module.module_id, label: module.module_name, available: true })),
  ];
  const usable = options.filter((option) => option.available && !notForWorkspace(option.value));
  useEffect(() => {
    if (usable.length > 0 && !usable.some((option) => option.value === domain)) setDomain(usable[0].value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceModules]);

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
          <Input
            id="project-name"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Marketing agencies NL"
          />
        </div>
        <div>
          <Label htmlFor="project-domain">Domain</Label>
          <select
            id="project-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm shadow-sm hover:border-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-1 transition-colors duration-200"
          >
            {options.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={!option.available || notForWorkspace(option.value)}
              >
                {option.label}
                {!option.available
                  ? ' (coming soon)'
                  : notForWorkspace(option.value)
                    ? ' (not enabled for this workspace)'
                    : ''}
              </option>
            ))}
          </select>
        </div>
        <FieldError>{error}</FieldError>
        {modulesError && <ErrorState message="Moduletoegang kon niet worden geladen." onRetry={retryModules} />}
        {!modulesLoading && !modulesError && !usable.length && (
          <p className="text-sm text-slate-500">Deze workspace heeft geen beschikbare modules.</p>
        )}
        <div className="mt-2 flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              submitting || modulesLoading || Boolean(modulesError) || !usable.some((option) => option.value === domain)
            }
          >
            {submitting ? 'Creating…' : 'Create project'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ProjectsPage() {
  const { current } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const domainFilter = params.get('domain');
  const [query, setQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(params.get('new') === '1');
  useEffect(() => {
    if (params.get('new') === '1') setDialogOpen(true);
  }, [params]);
  const closeDialog = () => {
    setDialogOpen(false);
    if (params.has('new')) {
      const next = new URLSearchParams(params);
      next.delete('new');
      setParams(next, { replace: true });
    }
  };
  const {
    data: projects,
    loading,
    error,
    refetch,
  } = useAsync(() => (current ? api.projects.listByWorkspace(current.id) : Promise.resolve([])), [current?.id]);

  const visible = (projects ?? []).filter(
    (project) =>
      (!domainFilter || project.domain === domainFilter) &&
      project.name.toLocaleLowerCase('nl').includes(query.toLocaleLowerCase('nl')),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            {domainFilter ? getDomainRenderer(domainFilter).recordLabelPlural : 'Projecten'}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Je zoekopdrachten en ontdekkingen, georganiseerd in {current?.name}.
          </p>
        </div>
        {current && <Button onClick={() => setDialogOpen(true)}>New project</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <div className="relative w-full max-w-sm">
          <Icon name="search" className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <Input
            aria-label="Projecten zoeken"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Zoek op projectnaam…"
            className="pl-9"
          />
        </div>
        {domainFilter && (
          <Link to="/projects" className="text-sm font-medium text-brand-700">
            Alle modules
          </Link>
        )}
        <span className="ml-auto text-xs text-slate-500">{visible.length} projecten</span>
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
      {!loading && !error && projects && projects.length > 0 && visible.length === 0 && (
        <EmptyState
          title="Geen projecten gevonden"
          description="Pas je filter aan of maak een project aan voor deze module."
        />
      )}
      {!loading && !error && visible.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((project) => (
            <Link key={project.id} to={`/projects/${project.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="py-5">
                  <span className="mb-5 inline-flex rounded-xl bg-brand-50 p-3 text-brand-600">
                    <Icon name={modulePresentation(project.domain).icon} />
                  </span>
                  <p className="font-semibold text-slate-900">{project.name}</p>
                  <p className="mt-1 text-sm text-slate-500">{getDomainRenderer(project.domain).recordLabelPlural}</p>
                  <p className="mt-3 text-xs text-slate-400">
                    Created {new Date(project.created_at).toLocaleDateString()}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {current && (
        <NewProjectDialog
          key={`${current.id}:${domainFilter ?? ''}`}
          open={dialogOpen}
          onClose={closeDialog}
          workspaceId={current.id}
          onCreated={refetch}
          initialDomain={domainFilter ?? undefined}
        />
      )}
    </div>
  );
}
