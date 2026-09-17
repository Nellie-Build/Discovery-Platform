import type { HTMLAttributes } from 'react';
import { clsx } from 'clsx';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 border border-slate-200',
  success: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  warning: 'bg-amber-50 text-amber-700 border border-amber-200',
  danger: 'bg-red-50 text-red-700 border border-red-200',
  info: 'bg-blue-50 text-blue-700 border border-blue-200',
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={clsx('inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold', toneClasses[tone], className)}
      {...props}
    />
  );
}

/** Maps a discovery_runs.status / discovery_records.status value to a badge tone+label —
 * the one place that mapping lives, so a status color is never invented ad hoc per screen. */
export function statusBadgeTone(status: string): BadgeTone {
  switch (status) {
    case 'succeeded': case 'active': case 'ready': return 'success';
    case 'running': case 'pending': case 'queued': return 'info';
    case 'failed': return 'danger';
    default: return 'neutral';
  }
}
