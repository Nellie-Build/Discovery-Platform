import type { ReactNode } from 'react';

/** A centered spinner + label — used for whole-page or whole-panel loading, never a bare
 * "Loading..." string on its own. */
export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-slate-500">
      <span
        className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"
        role="status"
        aria-label={label}
      />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-red-200 bg-red-50 py-12 px-6 text-center">
      <p className="text-sm font-medium text-red-800">Something went wrong</p>
      <p className="max-w-sm text-sm text-red-700">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="text-sm font-medium text-red-800 underline hover:text-red-900">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title, description, action, icon,
}: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50/50 py-16 px-6 text-center">
      {icon}
      <p className="text-base font-semibold text-slate-900">{title}</p>
      {description && <p className="max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
