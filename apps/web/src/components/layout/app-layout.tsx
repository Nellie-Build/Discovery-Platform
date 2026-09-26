import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { clsx } from 'clsx';
import { useAuth } from '../../lib/auth-context';
import { useWorkspace } from '../../lib/workspace-context';
import { useAsync } from '../../hooks/use-async';
import { api } from '../../lib/api';
import { Icon, type IconName } from '../ui/icon';
import { modulePresentation, moduleUrl } from '../../lib/module-presentation';

const navItems: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' },
  { to: '/projects', label: 'Projecten', icon: 'projects' },
  { to: '/runs', label: 'Zoekruns', icon: 'runs' },
  { to: '/records', label: 'Resultaten', icon: 'records' },
];

function WorkspaceSelector() {
  const { workspaces, current, setCurrentId, loading } = useWorkspace();
  if (loading) return <div className="h-10 animate-pulse rounded-lg bg-slate-100" />;
  if (!current) return <p className="text-sm text-slate-500">Geen workspace</p>;
  return (
    <select
      value={current.id}
      onChange={(event) => setCurrentId(event.target.value)}
      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-medium text-slate-700"
      aria-label="Current workspace"
    >
      {workspaces.map((workspace) => (
        <option key={workspace.id} value={workspace.id}>
          {workspace.name}
        </option>
      ))}
    </select>
  );
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const { current } = useWorkspace();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [logoutError, setLogoutError] = useState(false);
  const {
    data: access,
    error,
    loading,
    refetch,
  } = useAsync(
    async () => ({ workspaceId: current?.id, modules: current ? await api.workspaces.modules(current.id) : [] }),
    [current?.id],
  );
  const modules =
    !loading && !error && access?.workspaceId === current?.id
      ? (access?.modules.filter((module) => module.enabled) ?? [])
      : [];
  const selectedDomain = new URLSearchParams(location.search).get('domain');
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname, location.search, current?.id]);
  useEffect(() => {
    if (mobileOpen && !drawer.current?.open) drawer.current?.showModal();
    if (!mobileOpen && drawer.current?.open) drawer.current.close();
  }, [mobileOpen]);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const close = () => {
      if (media.matches) setMobileOpen(false);
    };
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, []);
  const active = (to: string) => {
    if (to.includes('?domain='))
      return (
        location.pathname === '/projects' && selectedDomain === new URLSearchParams(to.split('?')[1]).get('domain')
      );
    if (to === '/') return location.pathname === '/';
    if (to === '/projects' && selectedDomain) return false;
    return location.pathname === to || location.pathname.startsWith(`${to}/`);
  };
  const navLink = (to: string, label: string, icon: IconName) => (
    <Link
      key={to}
      to={to}
      aria-current={active(to) ? 'page' : undefined}
      className={clsx(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
        active(to) ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
      )}
    >
      <Icon name={icon} className="h-[18px] w-[18px] shrink-0" />
      {label}
    </Link>
  );
  const navigation = (
    <>
      <Link to="/" className="mb-8 flex items-center gap-3 px-2" aria-label="Discovery Platform dashboard">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
          <Icon name="search" />
        </span>
        <span className="text-sm font-semibold tracking-tight text-slate-900">
          Discovery<span className="block text-xs font-normal tracking-normal text-slate-500">Platform</span>
        </span>
      </Link>
      <div className="mb-7">
        <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Workspace</p>
        <WorkspaceSelector />
      </div>
      <nav aria-label="Hoofdnavigatie" className="flex flex-1 flex-col gap-1">
        <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-slate-500">Overzicht</p>
        {navItems.map((item) => navLink(item.to, item.label, item.icon))}
        <p className="mb-2 mt-6 px-3 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
          Discovery modules
        </p>
        {modules.map((module) =>
          navLink(moduleUrl(module.module_id), module.module_name, modulePresentation(module.module_id).icon),
        )}
        {loading && <p className="px-3 text-xs text-slate-500">Modules laden…</p>}
        {error && (
          <button onClick={refetch} className="px-3 text-left text-xs text-red-700">
            Modules niet geladen. Opnieuw proberen
          </button>
        )}
        {!loading && !error && !modules.length && (
          <p className="px-3 text-xs text-slate-500">Geen beschikbare modules</p>
        )}
        <div className="mt-auto pt-8">
          {user?.is_admin && navLink('/admin/modules', 'Admin', 'shield')}
          {navLink('/settings', 'Instellingen', 'settings')}
          {navLink('/account', 'Account', 'account')}
        </div>
      </nav>
      <div className="mt-5 border-t border-slate-100 px-2 pt-5">
        <p className="truncate text-xs font-medium text-slate-600">{user?.email}</p>
        <button
          type="button"
          onClick={() => {
            setLogoutError(false);
            void logout().catch(() => setLogoutError(true));
          }}
          className="mt-3 flex items-center gap-2 text-xs text-slate-500 hover:text-slate-800"
        >
          <Icon name="logout" className="h-4 w-4" />
          Uitloggen
        </button>
        {logoutError && (
          <p role="alert" className="mt-2 text-xs text-red-700">
            Uitloggen mislukt. Probeer opnieuw.
          </p>
        )}
      </div>
    </>
  );
  const pageTitle =
    navItems.find((item) => active(item.to))?.label ??
    (selectedDomain ? modules.find((module) => module.module_id === selectedDomain)?.module_name : null) ??
    (location.pathname.startsWith('/admin')
      ? 'Beheer'
      : location.pathname === '/settings'
        ? 'Instellingen'
        : location.pathname === '/account'
          ? 'Account'
          : 'Discovery');
  return (
    <div className="min-h-screen bg-[#f8fafc]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:p-3"
      >
        Ga naar inhoud
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col overflow-y-auto border-r border-slate-200 bg-white px-4 py-6 md:flex">
        {navigation}
      </aside>
      <dialog
        ref={drawer}
        aria-label="Navigatie"
        onCancel={() => setMobileOpen(false)}
        onClose={() => {
          setMobileOpen(false);
          opener.current?.focus();
        }}
        className="fixed inset-y-0 left-0 right-auto m-0 h-dvh max-h-none w-72 max-w-[90vw] border-0 bg-white p-0 shadow-xl backdrop:bg-slate-900/30 md:hidden"
      >
        {mobileOpen && (
          <div className="flex min-h-full flex-col px-5 py-6">
            <button
              type="button"
              aria-label="Navigatie sluiten"
              onClick={() => setMobileOpen(false)}
              className="absolute right-4 top-5 rounded-lg p-2 text-slate-500"
            >
              <Icon name="close" />
            </button>
            {navigation}
          </div>
        )}
      </dialog>
      <div className="min-w-0 md:pl-60">
        <header className="flex min-h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              ref={opener}
              type="button"
              aria-label="Navigatie openen"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
              className="rounded-lg p-2 text-slate-600 md:hidden"
            >
              <Icon name="menu" />
            </button>
            <span className="text-sm font-medium text-slate-700">{pageTitle}</span>
            <span className="hidden text-slate-300 sm:inline">/</span>
            <span className="hidden truncate text-xs text-slate-500 sm:inline">{current?.name ?? 'Workspace'}</span>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {import.meta.env.VITE_ENV_LABEL && (
              <span className="rounded-md bg-amber-50 px-2 py-1 text-[10px] font-medium uppercase text-amber-800">
                {import.meta.env.VITE_ENV_LABEL}
              </span>
            )}
            <Link
              to="/account"
              aria-label="Mijn account"
              className="flex h-8 w-8 items-center justify-center rounded-full border border-brand-100 bg-brand-50 text-xs font-semibold text-brand-700"
            >
              {user?.email?.slice(0, 2).toUpperCase() ?? 'DP'}
            </Link>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="min-w-0 px-4 py-7 outline-none sm:px-8 lg:py-9">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
