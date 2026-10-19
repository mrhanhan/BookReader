import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes } from 'react';
import { cn } from '../cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, hint, id, className, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const descriptionId = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        {...props}
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={descriptionId}
        className={cn(
          'min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-base text-ink sm:min-h-9 sm:text-sm',
          'placeholder:text-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-60',
          error && 'border-highlight focus:border-highlight focus:ring-highlight/20',
          className,
        )}
      />
      {error ? (
        <p id={descriptionId} className="text-xs text-highlight">
          {error}
        </p>
      ) : hint ? (
        <p id={descriptionId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
});
