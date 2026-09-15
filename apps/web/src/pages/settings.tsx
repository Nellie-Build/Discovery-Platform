import { useWorkspace } from '../lib/workspace-context';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { LoadingState } from '../components/ui/states';

export function SettingsPage() {
  const { current, loading } = useWorkspace();

  if (loading) return <LoadingState label="Loading workspace…" />;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">Workspace-level settings.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>Basic information about your current workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Name</dt>
              <dd className="mt-0.5 text-sm text-slate-800">{current?.name ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Your role</dt>
              <dd className="mt-0.5 text-sm capitalize text-slate-800">{current?.role ?? '—'}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Coming later</CardTitle>
          <CardDescription>
            Team invitations, billing, and white-label branding aren't built yet — this phase is
            deliberately just the technical foundation. See the project's architecture notes for
            what's planned.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
