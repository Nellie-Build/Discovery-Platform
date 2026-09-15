import { NavLink, Outlet } from 'react-router-dom';
import { clsx } from 'clsx';
import { useAuth } from '../../lib/auth-context';
import { useWorkspace } from '../../lib/workspace-context';

const navItems = [
  { to: '/', label: 'Dashboard' },
  { to: '/projects', label: 'Projects' },
  { to: '/runs', label: 'Discovery Runs' },
  { to: '/records', label: 'Records' },
];
const secondaryNavItems = [
  { to: '/settings', label: 'Settings' },
  { to: '/account', label: 'Account' },
];

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        clsx(
          'block rounded-md px-3 py-2 text-sm font-medium transition-colors',
          isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
        )
      }
    >
      {label}
    </NavLink>
  );
}

function WorkspaceSelector() {
  const { workspaces, current, setCurrentId, loading } = useWorkspace();
  if (loading) return <div className="h-9 w-full animate-pulse rounded-md bg-slate-100" />;
  if (!current) return null;
  return (
    <select
      value={current.id}
      onChange={event => setCurrentId(event.target.value)}
      className="w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
      aria-label="Current workspace"
    >
      {workspaces.map(workspace => (
        <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
      ))}
    </select>
  );
}

/** A small, deliberately subtle badge (never a big banner) so this environment is never mistaken
 * for a later production deployment — only rendered when the build sets VITE_ENV_LABEL (the
 * Dockerfile does; local dev doesn't). */
function EnvironmentBadge() {
  const label = import.meta.env.VITE_ENV_LABEL;
  if (!label) return null;
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-700">
      {label}
    </span>
  );
}

export function AppLayout() {
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="hidden w-64 flex-col border-r border-slate-200 bg-white px-4 py-6 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          {/* DISCOVERY_PLATFORM_BRAND: swap this span (and the favicon/title in index.html) for a
              final product name/logo later — nothing else in the app hardcodes "Discovery Platform". */}
          <span className="text-lg font-semibold tracking-tight text-slate-900">Discovery Platform</span>
          <EnvironmentBadge />
        </div>
        <div className="mb-6">
          <WorkspaceSelector />
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {navItems.map(item => <NavItem key={item.to} {...item} />)}
          <div className="my-3 border-t border-slate-100" />
          {secondaryNavItems.map(item => <NavItem key={item.to} {...item} />)}
        </nav>
        <div className="mt-6 border-t border-slate-100 pt-4">
          <p className="truncate px-2 text-xs text-slate-400">{user?.email}</p>
          <button
            type="button"
            onClick={() => { void logout(); }}
            className="mt-2 w-full rounded-md px-3 py-2 text-left text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Log out
          </button>
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <span className="flex items-center gap-2 text-base font-semibold text-slate-900">
            Discovery Platform
            <EnvironmentBadge />
          </span>
          <button
            type="button"
            onClick={() => { void logout(); }}
            className="text-sm font-medium text-slate-600"
          >
            Log out
          </button>
        </header>
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
