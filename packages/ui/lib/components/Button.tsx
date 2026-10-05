import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../utils';

export type ButtonProps = {
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
} & ComponentPropsWithoutRef<'button'>;

// Colors come from the --nb-* tokens (packages/tailwind-config), so light/dark follows the system
// scheme without a theme prop.
export function Button({ variant = 'primary', className, disabled, children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        // one size for every button, so buttons side by side line up whatever the call site passes
        'nb-btn inline-flex h-7 items-center justify-center gap-1 rounded-md border px-3 text-[12.5px] font-medium leading-none transition-colors',
        {
          'border-transparent bg-nb-llm text-white hover:opacity-90': variant === 'primary' && !disabled,
          'border-nb-line bg-nb-tile-2 text-nb-ink-2 hover:bg-nb-tile hover:text-nb-ink':
            variant === 'secondary' && !disabled,
          'border-nb-line bg-nb-tile-2 text-nb-critical hover:border-nb-critical': variant === 'danger' && !disabled,
          'cursor-not-allowed border-nb-hair bg-nb-track text-nb-muted': disabled,
        },
        className,
      )}
      disabled={disabled}
      {...props}>
      {children}
    </button>
  );
}
