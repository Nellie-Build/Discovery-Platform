import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes } from 'react';
import { clsx } from 'clsx';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props }, ref,
) {
  return (
    <input
      ref={ref}
      className={clsx(
        'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400',
        'focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500',
        'disabled:bg-slate-50 disabled:text-slate-500',
        className,
      )}
      {...props}
    />
  );
});

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={clsx('mb-1.5 block text-sm font-medium text-slate-700', className)} {...props} />;
}

export function FieldError({ children }: { children?: string | null }) {
  if (!children) return null;
  return <p className="mt-1.5 text-sm text-red-600">{children}</p>;
}
