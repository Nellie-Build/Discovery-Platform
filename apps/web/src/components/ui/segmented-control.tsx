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
    <div role="radiogroup" aria-label={name} className="inline-flex rounded-md border border-slate-300 bg-white p-0.5">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={clsx(
            'rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-1',
            option.value === value ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-100',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
