import { clsx } from 'clsx';

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
}

/** A small two-or-more-way toggle, styled like a row of Button variants (the active option
 * looks like a primary Button, the rest like secondary ones) — for choosing between a handful of
 * mutually exclusive modes, e.g. "Website" vs. "Branche" when starting a Discovery run. */
export function SegmentedControl<T extends string>({ options, value, onChange, name }: {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  name: string;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1 shadow-sm">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={clsx(
            'rounded-md px-4 py-2 text-sm font-semibold transition-all duration-200',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-0',
            option.value === value
              ? 'bg-white text-brand-700 shadow-md'
              : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/50',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
