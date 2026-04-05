import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  KeyboardEvent,
  ClipboardEvent,
} from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { Button } from '../shared/Button';
import { Input } from '../shared/Input';

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

/** TOTP codes are valid for 30-second windows */
const TOTP_WINDOW_SECONDS = 30;

/* ------------------------------------------------------------------ */
/* Countdown timer hook                                                 */
/* ------------------------------------------------------------------ */

function useTOTPCountdown() {
  const [secondsLeft, setSecondsLeft] = useState<number>(() => {
    const now = Math.floor(Date.now() / 1000);
    return TOTP_WINDOW_SECONDS - (now % TOTP_WINDOW_SECONDS);
  });

  useEffect(() => {
    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      setSecondsLeft(TOTP_WINDOW_SECONDS - (now % TOTP_WINDOW_SECONDS));
    };

    // Align to the next second boundary
    const msUntilNextSecond = 1000 - (Date.now() % 1000);
    const initial = setTimeout(() => {
      tick();
      const interval = setInterval(tick, 1000);
      return () => clearInterval(interval);
    }, msUntilNextSecond);

    return () => clearTimeout(initial);
  }, []);

  return secondsLeft;
}

/* ------------------------------------------------------------------ */
/* Countdown display                                                    */
/* ------------------------------------------------------------------ */

function CountdownTimer() {
  const secondsLeft = useTOTPCountdown();
  const pct = (secondsLeft / TOTP_WINDOW_SECONDS) * 100;
  const isUrgent = secondsLeft <= 5;

  return (
    <div className="flex flex-col items-center gap-2 mt-2" aria-live="polite">
      {/* Arc-style progress bar */}
      <div className="w-full h-1 bg-[#1F1F23] rounded-full overflow-hidden">
        <div
          className={[
            'h-full rounded-full transition-all duration-1000 ease-linear',
            isUrgent ? 'bg-danger' : 'bg-primary',
          ].join(' ')}
          style={{ width: `${pct}%` }}
          aria-hidden="true"
        />
      </div>
      <p
        className={`text-xs tabular-nums ${isUrgent ? 'text-danger' : 'text-[#71717A]'}`}
      >
        Code valid for{' '}
        <span className="font-medium">{secondsLeft}s</span>
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 6-digit OTP input                                                    */
/* ------------------------------------------------------------------ */

interface OTPInputProps {
  value: string[]; // Array of 6 single-digit strings
  onChange: (value: string[]) => void;
  error: boolean;
  disabled?: boolean;
}

function OTPInput({ value, onChange, error, disabled }: OTPInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>(Array(6).fill(null));

  const focusCell = (index: number) => {
    refs.current[index]?.focus();
  };

  const handleChange = useCallback(
    (index: number, raw: string) => {
      // Accept only one digit
      const digit = raw.replace(/\D/g, '').slice(-1);
      if (!digit && raw !== '') return; // Non-digit key, ignore

      const next = [...value];
      next[index] = digit;
      onChange(next);

      // Auto-advance
      if (digit && index < 5) {
        focusCell(index + 1);
      }
    },
    [value, onChange],
  );

  const handleKeyDown = useCallback(
    (index: number, e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Backspace') {
        if (value[index]) {
          // Clear current cell
          const next = [...value];
          next[index] = '';
          onChange(next);
        } else if (index > 0) {
          // Move back and clear
          const next = [...value];
          next[index - 1] = '';
          onChange(next);
          focusCell(index - 1);
        }
        e.preventDefault();
      } else if (e.key === 'ArrowLeft' && index > 0) {
        focusCell(index - 1);
        e.preventDefault();
      } else if (e.key === 'ArrowRight' && index < 5) {
        focusCell(index + 1);
        e.preventDefault();
      } else if (e.key === 'Home') {
        focusCell(0);
        e.preventDefault();
      } else if (e.key === 'End') {
        focusCell(5);
        e.preventDefault();
      }
    },
    [value, onChange],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
      if (!pasted) return;

      const next = Array(6).fill('');
      for (let i = 0; i < pasted.length; i++) {
        next[i] = pasted[i];
      }
      onChange(next);

      // Focus the cell after the last pasted digit
      const lastIndex = Math.min(pasted.length, 5);
      focusCell(lastIndex);
    },
    [onChange],
  );

  return (
    <div
      className="flex gap-2 justify-center"
      role="group"
      aria-label="One-time verification code"
    >
      {value.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          value={digit}
          disabled={disabled}
          aria-label={`Digit ${i + 1} of 6`}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.target.select()}
          className={[
            // Dimensions — 48px wide, 56px tall
            'w-12 h-14 text-center text-xl font-semibold font-mono',
            'bg-[#141416] text-[#FAFAFA]',
            'border-2 rounded-input',
            'transition-all duration-150',
            'focus:outline-none',
            // Border states
            error
              ? 'border-danger focus:border-danger focus:ring-2 focus:ring-danger/20'
              : digit
                ? 'border-primary/60 focus:border-primary focus:ring-2 focus:ring-primary/20'
                : 'border-[#1F1F23] focus:border-primary focus:ring-2 focus:ring-primary/20',
            // Touch target: ensure minimum via padding
            'tablet:w-14',
            disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-text',
          ].join(' ')}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shake animation wrapper                                             */
/* ------------------------------------------------------------------ */

interface ShakeWrapperProps {
  shake: boolean;
  children: React.ReactNode;
}

function ShakeWrapper({ shake, children }: ShakeWrapperProps) {
  return (
    <div
      className={shake ? 'animate-[shake_0.4s_ease-in-out]' : ''}
      style={
        shake
          ? undefined
          : undefined
      }
    >
      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
          15%      { transform: translateX(-6px); }
          30%      { transform: translateX(6px); }
          45%      { transform: translateX(-4px); }
          60%      { transform: translateX(4px); }
          75%      { transform: translateX(-2px); }
          90%      { transform: translateX(2px); }
        }
      `}</style>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

type InputMode = 'otp' | 'backup';

export default function MFAVerifyPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const verifyMFA = useAuthStore((s) => s.verifyMFA);

  const from = (location.state as { from?: { pathname: string } })?.from
    ?.pathname;

  /* ---- mode ---- */
  const [inputMode, setInputMode] = useState<InputMode>('otp');

  /* ---- OTP digits ---- */
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const otpValue = digits.join('');

  /* ---- backup code ---- */
  const [backupCode, setBackupCode] = useState('');

  /* ---- UI state ---- */
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);

  /* ---- auto-submit when all 6 digits filled ---- */
  useEffect(() => {
    if (inputMode === 'otp' && otpValue.length === 6 && !loading && !error) {
      handleSubmit(otpValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otpValue]);

  const triggerShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 450);
  };

  const handleSubmit = async (code: string) => {
    setError(null);
    setLoading(true);
    try {
      await verifyMFA(code);
      navigate(from ?? '/vault', { replace: true });
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : 'Invalid code. Please try again.';
      setError(message);
      triggerShake();
      // Clear OTP digits on error so user can re-enter
      if (inputMode === 'otp') {
        setDigits(Array(6).fill(''));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleBackupSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = backupCode.trim().toUpperCase().replace(/-/g, '');
    if (!normalized) {
      setError('Please enter your backup code');
      return;
    }
    handleSubmit(normalized);
  };

  const handleModeSwitch = (mode: InputMode) => {
    setInputMode(mode);
    setError(null);
    setDigits(Array(6).fill(''));
    setBackupCode('');
  };

  return (
    <main className="min-h-dvh bg-[#0A0A0B] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-8 shadow-card">
          {/* Header */}
          <div className="flex flex-col items-center gap-2 mb-8">
            <div className="w-14 h-14 rounded-card bg-secondary/10 border border-secondary/30 flex items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6366F1"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <h1 className="text-2xl font-heading font-bold text-[#FAFAFA] tracking-tight text-center">
              Two-Factor Authentication
            </h1>
            <p className="text-sm text-[#71717A] text-center">
              {inputMode === 'otp'
                ? 'Enter the 6-digit code from your authenticator app'
                : 'Enter one of your backup codes'}
            </p>
          </div>

          {/* OTP mode */}
          {inputMode === 'otp' && (
            <div className="space-y-5">
              <ShakeWrapper shake={shake}>
                <OTPInput
                  value={digits}
                  onChange={(next) => {
                    setDigits(next);
                    if (error) setError(null);
                  }}
                  error={Boolean(error)}
                  disabled={loading}
                />
              </ShakeWrapper>

              {/* Error */}
              {error && (
                <p
                  role="alert"
                  className="text-sm text-danger text-center flex items-center justify-center gap-1.5"
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

              {/* Countdown */}
              <CountdownTimer />

              {/* Manual submit (also auto-submits on 6th digit) */}
              <Button
                type="button"
                variant="primary"
                size="lg"
                fullWidth
                loading={loading}
                disabled={otpValue.length !== 6}
                onClick={() => handleSubmit(otpValue)}
              >
                Verify
              </Button>

              {/* Switch to backup code */}
              <div className="text-center">
                <button
                  type="button"
                  onClick={() => handleModeSwitch('backup')}
                  className="text-sm text-[#71717A] hover:text-[#FAFAFA] underline transition-colors min-h-[44px] px-2"
                >
                  Use a backup code instead
                </button>
              </div>
            </div>
          )}

          {/* Backup code mode */}
          {inputMode === 'backup' && (
            <form onSubmit={handleBackupSubmit} noValidate className="space-y-5">
              <ShakeWrapper shake={shake}>
                <Input
                  label="Backup code"
                  type="text"
                  id="backup-code"
                  placeholder="XXXX-XXXX or XXXXXXXX"
                  autoComplete="off"
                  autoFocus
                  value={backupCode}
                  onChange={(e) => {
                    setBackupCode(e.target.value);
                    if (error) setError(null);
                  }}
                  error={error ?? undefined}
                />
              </ShakeWrapper>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                loading={loading}
                disabled={!backupCode.trim()}
              >
                Verify Backup Code
              </Button>

              {/* Switch back to OTP */}
              <div className="text-center">
                <button
                  type="button"
                  onClick={() => handleModeSwitch('otp')}
                  className="text-sm text-[#71717A] hover:text-[#FAFAFA] underline transition-colors min-h-[44px] px-2"
                >
                  Use authenticator app instead
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
