import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../cn';

const VARIANTS = {
  primary: 'bg-accent text-paper hover:bg-accent/90',
  ghost: 'border border-border bg-transparent text-ink hover:bg-ink/5',
  danger: 'bg-highlight text-paper hover:bg-highlight/90',
} as const;

const SIZES = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2.5 text-sm',
  /** Square utility button; the label is supplied through `aria-label`. */
  icon: 'size-9 shrink-0 p-0 [@media(pointer:coarse)]:size-11',
} as const;
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  type = 'button',
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading}
      className={cn(
        'inline-flex min-h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium tracking-wide transition',
        '[@media(pointer:coarse)]:min-h-11',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-60',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}
