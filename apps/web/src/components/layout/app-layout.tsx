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
          'block rounded-lg px-3.5 py-2.5 text-sm font-medium transition-all duration-200',
          isActive
            ? 'bg-brand-600 text-white shadow-md'
            : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 hover:shadow-sm',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-0',
        )
      }
    >
      {label}
    </NavLink>
  );
}

function WorkspaceSelector() {
  const { workspaces, current, setCurrentId, loading } = useWorkspace();
  if (loading) return <div className="h-10 w-full animate-pulse rounded-lg bg-slate-100" />;
  if (!current) return null;
  return (
    <select
      value={current.id}
      onChange={event => setCurrentId(event.target.value)}
      className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-700 shadow-sm hover:border-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-1 transition-colors duration-200"
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
  // Never a hardcoded email — this reads the session's own is_admin flag (see
  // migrations/004_admin_modules.sql). The server independently enforces the same check on every
  // /admin/* request (see apps/api/src/admin-access.ts); this only controls whether the link
  // appears at all.
  const navItemsWithAdmin = user?.is_admin ? [...navItems, { to: '/admin/modules', label: 'Admin' }] : navItems;

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
          {navItemsWithAdmin.map(item => <NavItem key={item.to} {...item} />)}
          <div className="my-3 border-t border-slate-100" />
          {secondaryNavItems.map(item => <NavItem key={item.to} {...item} />)}
        </nav>
        <div className="mt-6 border-t border-slate-100 pt-4">
          <p className="truncate px-2 text-xs text-slate-400">{user?.email}</p>
          <button
            type="button"
            onClick={() => { void logout(); }}
            className="mt-2 w-full rounded-lg px-3.5 py-2.5 text-left text-sm font-medium text-slate-600 hover:bg-slate-100 hover:shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
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
            className="rounded-lg px-3.5 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
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
