import React from 'react';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  children: React.ReactNode;
}

/* ------------------------------------------------------------------ */
/* Variant + size maps                                                  */
/* ------------------------------------------------------------------ */

const variantClasses: Record<ButtonVariant, string> = {
  primary: [
    'bg-primary text-[#0A0A0B] font-semibold',
    'hover:opacity-90 hover:shadow-glow-primary',
    'disabled:opacity-40 disabled:shadow-none',
    'active:scale-[0.98]',
  ].join(' '),

  secondary: [
    'bg-secondary text-[#FAFAFA] font-semibold',
    'hover:opacity-90 hover:shadow-glow-secondary',
    'disabled:opacity-40 disabled:shadow-none',
    'active:scale-[0.98]',
  ].join(' '),

  outline: [
    'bg-transparent text-[#FAFAFA] font-medium',
    'border border-[#1F1F23]',
    'hover:border-primary hover:bg-primary/5',
    'disabled:opacity-40',
    'active:scale-[0.98]',
  ].join(' '),

  danger: [
    'bg-danger text-[#FAFAFA] font-semibold',
    'hover:opacity-90 hover:shadow-[0_0_20px_rgba(239,68,68,0.35)]',
    'disabled:opacity-40 disabled:shadow-none',
    'active:scale-[0.98]',
  ].join(' '),

  ghost: [
    'bg-transparent text-[#FAFAFA] font-medium',
    'hover:bg-white/5',
    'disabled:opacity-40',
    'active:scale-[0.98]',
  ].join(' '),
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-11 px-4 text-sm rounded-pill gap-1.5',
  md: 'h-12 px-5 text-base rounded-pill gap-2',
  lg: 'h-14 px-7 text-lg rounded-pill gap-2.5',
};

/* ------------------------------------------------------------------ */
/* Loading dots                                                          */
/* ------------------------------------------------------------------ */

function LoadingDots() {
  return (
    <span className="flex items-center gap-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-skeleton-pulse"
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  disabled,
  children,
  className = '',
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      disabled={isDisabled}
      aria-busy={loading}
      className={[
        // Base
        'relative inline-flex items-center justify-center',
        'transition-all duration-150 ease-out',
        'focus-visible:outline focus-visible:outline-3 focus-visible:outline-primary focus-visible:outline-offset-4',
        // Cursor
        isDisabled ? 'cursor-not-allowed' : 'cursor-pointer',
        // Variant
        variantClasses[variant],
        // Size (includes min-height of 44px via h-11 = 44px)
        sizeClasses[size],
        // Full width
        fullWidth ? 'w-full' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      {loading ? (
        <>
          <span className="sr-only">Loading…</span>
          <LoadingDots />
        </>
      ) : (
        children
      )}
    </button>
  );
}

export default Button;
