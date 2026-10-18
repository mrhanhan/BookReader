import type { ReactNode } from 'react';

export interface AuthShellProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}

/** Shared paper-ink frame for the login and register pages. */
export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-sm bg-accent font-serif text-xl text-paper shadow-sm">
            墨
          </div>
          <p className="font-serif text-2xl tracking-[0.2em] text-ink">纸墨书房</p>
          <p className="mt-2 text-xs tracking-widest text-muted">收一方纸墨，读一世清欢</p>
        </div>
        <div className="rounded-lg border border-border bg-surface px-6 py-7 shadow-[0_1px_2px_rgb(43_38_32/0.04),0_12px_32px_-20px_rgb(43_38_32/0.35)]">
          <div className="mb-6">
            <h1 className="text-xl text-ink">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
          </div>
          {children}
        </div>
        {footer ? <div className="mt-5 text-center text-sm text-muted">{footer}</div> : null}
      </div>
    </div>
  );
}
