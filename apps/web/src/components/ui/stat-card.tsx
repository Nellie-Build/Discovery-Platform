import { Card, CardContent } from './card';
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
      <CardContent className="py-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-slate-600">{label}</p>
          <span className="rounded-lg bg-brand-50 p-2 text-brand-600">
            <Icon name={icon} />
          </span>
        </div>
        <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 tabular-nums">
          {typeof value === 'number' ? value.toLocaleString('nl-NL') : value}
        </p>
        <p className="mt-2 text-xs leading-5 text-slate-500">{description}</p>
      </CardContent>
    </Card>
  );
}
