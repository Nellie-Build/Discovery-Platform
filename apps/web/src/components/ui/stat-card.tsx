import { Card } from './card';
import { Icon, type IconName } from './icon';
export function StatCard({
  label,
  value,
  description,
  icon,
}: {
  label: string;
  value: number | string;
  description: string;
  icon: IconName;
}) {
  return (
    <Card>
      <div className="p-3 sm:px-6 sm:py-5">
        <div className="flex items-center justify-between gap-2 sm:gap-3">
          <p className="text-xs font-medium leading-4 text-slate-600 sm:text-sm sm:leading-5">{label}</p>
          <span className="shrink-0 rounded-lg bg-brand-50 p-1.5 text-brand-600 sm:p-2">
            <Icon name={icon} className="h-4 w-4 sm:h-5 sm:w-5" />
          </span>
        </div>
        <p className="mt-2 text-2xl sm:mt-3 sm:text-3xl font-semibold tracking-tight text-slate-900 tabular-nums">
          {typeof value === 'number' ? value.toLocaleString('nl-NL') : value}
        </p>
        <p className="mt-1 text-[11px] leading-4 sm:mt-2 sm:text-xs sm:leading-5 text-slate-500">{description}</p>
      </div>
    </Card>
  );
}
