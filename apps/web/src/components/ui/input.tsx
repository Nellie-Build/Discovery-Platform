import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes } from 'react';
import { clsx } from 'clsx';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props }, ref,
) {
  return (
    <input
      ref={ref}
      className={clsx(
        'block w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-500 transition-colors duration-200',
        'focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-1',
        'hover:border-slate-400',
        'disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed',
        className,
      )}
      {...props}
    />
  );
});

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={clsx('mb-2 block text-sm font-semibold text-slate-700', className)} {...props} />;
}

export function FieldError({ children }: { children?: string | null }) {
  if (!children) return null;
  return <p className="mt-1.5 text-sm text-red-600">{children}</p>;
}
