import type { HTMLAttributes } from 'react';
import { clsx } from 'clsx';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  success: 'bg-emerald-100 text-emerald-800',
  warning: 'bg-amber-100 text-amber-800',
  danger: 'bg-red-100 text-red-800',
  info: 'bg-brand-100 text-brand-800',
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={clsx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', toneClasses[tone], className)}
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
