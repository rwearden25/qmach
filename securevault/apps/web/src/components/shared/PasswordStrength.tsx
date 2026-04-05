import React, { useMemo } from 'react';
import zxcvbn from 'zxcvbn';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface PasswordStrengthProps {
  password: string;
  className?: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

const STRENGTH_CONFIG = [
  { label: 'Very Weak', color: 'bg-red-500',    textColor: 'text-red-400'    },
  { label: 'Weak',      color: 'bg-orange-500',  textColor: 'text-orange-400' },
  { label: 'Fair',      color: 'bg-yellow-400',  textColor: 'text-yellow-400' },
  { label: 'Strong',    color: 'bg-lime-400',    textColor: 'text-lime-400'   },
  { label: 'Very Strong', color: 'bg-primary',   textColor: 'text-primary'    },
] as const;

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

export function PasswordStrength({ password, className = '' }: PasswordStrengthProps) {
  const result = useMemo(() => {
    if (!password) return null;
    return zxcvbn(password);
  }, [password]);

  if (!password) return null;

  const score = result?.score ?? 0;
  const config = STRENGTH_CONFIG[score];
  const suggestions: string[] = result?.feedback?.suggestions ?? [];
  const warning: string = result?.feedback?.warning ?? '';

  return (
    <div className={`flex flex-col gap-2 ${className}`} role="status" aria-live="polite">
      {/* Bar track */}
      <div className="flex gap-1.5" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={[
              'h-1.5 flex-1 rounded-full transition-all duration-300',
              i <= score ? config.color : 'bg-[#1F1F23]',
            ].join(' ')}
          />
        ))}
      </div>

      {/* Label */}
      <div className="flex items-center justify-between">
        <span className={`text-xs font-semibold ${config.textColor}`}>
          {config.label}
        </span>
        <span className="text-xs text-[#71717A]">
          {score < 2 ? 'Password too weak' : score < 4 ? 'Almost there' : 'Great password'}
        </span>
      </div>

      {/* Feedback */}
      {(warning || suggestions.length > 0) && (
        <ul className="flex flex-col gap-1 mt-0.5">
          {warning && (
            <li className="text-xs text-[#F59E0B] flex items-start gap-1.5">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 mt-0.5"
                aria-hidden="true"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              {warning}
            </li>
          )}
          {suggestions.map((s, i) => (
            <li key={i} className="text-xs text-[#71717A] flex items-start gap-1.5">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 mt-0.5"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              {s}
            </li>
          ))}
        </ul>
      )}

      {/* Screen reader summary */}
      <span className="sr-only">
        Password strength: {config.label}. Score {score + 1} out of 5.
        {warning ? ` Warning: ${warning}` : ''}
        {suggestions.length > 0 ? ` Suggestions: ${suggestions.join(' ')}` : ''}
      </span>
    </div>
  );
}

export default PasswordStrength;
