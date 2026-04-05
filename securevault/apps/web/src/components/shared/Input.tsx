import React, { useId, useState } from 'react';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
  error?: string;
  hint?: string;
  type?: 'text' | 'email' | 'password' | 'search' | 'url' | 'tel';
  /** Optional icon rendered on the left side of the input */
  icon?: React.ReactNode;
}

/* ------------------------------------------------------------------ */
/* Eye icons (inline SVG — no icon lib dependency)                      */
/* ------------------------------------------------------------------ */

function EyeOpenIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeClosedIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

export function Input({
  label,
  error,
  hint,
  type = 'text',
  icon,
  className = '',
  id: idProp,
  ...props
}: InputProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  const [showPassword, setShowPassword] = useState(false);

  const isPassword = type === 'password';
  const resolvedType = isPassword ? (showPassword ? 'text' : 'password') : type;

  const hasError = Boolean(error);
  const hasLeftPadding = Boolean(icon);
  const hasRightPadding = isPassword;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      {/* Label */}
      {label && (
        <label
          htmlFor={id}
          className="text-sm font-medium text-[#FAFAFA] leading-tight select-none"
        >
          {label}
        </label>
      )}

      {/* Input wrapper */}
      <div className="relative flex items-center">
        {/* Left icon */}
        {icon && (
          <span
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#71717A]"
            aria-hidden="true"
          >
            {icon}
          </span>
        )}

        {/* Input element
            - text-[16px] prevents iOS auto-zoom
            - min-h-[44px] for touch targets
        */}
        <input
          id={id}
          type={resolvedType}
          aria-invalid={hasError ? 'true' : undefined}
          aria-describedby={
            [hasError ? errorId : null, hint ? hintId : null]
              .filter(Boolean)
              .join(' ') || undefined
          }
          className={[
            // Layout
            'w-full min-h-[44px] px-3.5 py-2.5',
            'text-[16px] leading-normal',
            // Colors
            'bg-[#141416] text-[#FAFAFA] placeholder:text-[#71717A]',
            // Border
            'border rounded-input',
            hasError
              ? 'border-danger focus:border-danger focus:ring-danger/20'
              : 'border-[#1F1F23] hover:border-[#71717A] focus:border-primary focus:ring-primary/20',
            // Ring on focus (no outline — global :focus-visible handles keyboard)
            'focus:outline-none focus:ring-2',
            // Transition
            'transition-all duration-150 ease-out',
            // Padding adjustments for icons
            hasLeftPadding ? 'pl-10' : '',
            hasRightPadding ? 'pr-11' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          {...props}
        />

        {/* Password show/hide toggle */}
        {isPassword && (
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className={[
              'absolute right-3 top-1/2 -translate-y-1/2',
              'p-1 text-[#71717A] hover:text-[#FAFAFA]',
              'transition-colors duration-150',
              // Minimum 44px touch area via padding hack
              'min-w-[44px] min-h-[44px] flex items-center justify-center',
              '-mr-2',
            ].join(' ')}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            tabIndex={0}
          >
            {showPassword ? <EyeClosedIcon /> : <EyeOpenIcon />}
          </button>
        )}
      </div>

      {/* Hint text */}
      {hint && !error && (
        <p id={hintId} className="text-xs text-[#71717A]">
          {hint}
        </p>
      )}

      {/* Error message */}
      {error && (
        <p
          id={errorId}
          role="alert"
          className="flex items-center gap-1.5 text-sm text-danger"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" x2="12" y1="8" y2="12" />
            <line x1="12" x2="12.01" y1="16" y2="16" />
          </svg>
          {error}
        </p>
      )}
    </div>
  );
}

export default Input;
