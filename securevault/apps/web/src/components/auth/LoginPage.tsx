import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { Button } from '../shared/Button';
import { Input } from '../shared/Input';

/* ------------------------------------------------------------------ */
/* Inline Zod-like validation (no extra dep needed)                     */
/* ------------------------------------------------------------------ */

function validateEmail(email: string): string | null {
  if (!email.trim()) return 'Email is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return 'Enter a valid email address';
  return null;
}

function validatePassword(password: string): string | null {
  if (!password) return 'Password is required';
  return null;
}

/* ------------------------------------------------------------------ */
/* Email icon                                                           */
/* ------------------------------------------------------------------ */

function EmailIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Logo                                                                 */
/* ------------------------------------------------------------------ */

function SecureVaultLogo() {
  return (
    <div className="flex flex-col items-center gap-2 mb-8">
      {/* Shield icon */}
      <div className="w-14 h-14 rounded-card bg-primary/10 border border-primary/30 flex items-center justify-center">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#00FF88"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      </div>
      <h1 className="text-2xl font-heading font-bold text-[#FAFAFA] tracking-tight">
        SecureVault
      </h1>
      <p className="text-sm text-[#71717A]">Sign in to your secure vault</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useAuthStore((s) => s.login);

  const from = (location.state as { from?: { pathname: string } })?.from
    ?.pathname;

  /* ---- form state ---- */
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* ---- real-time validation ---- */
  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
    if (emailError) setEmailError(validateEmail(e.target.value));
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    if (passwordError) setPasswordError(validatePassword(e.target.value));
  };

  /* ---- submit ---- */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    const eErr = validateEmail(email);
    const pErr = validatePassword(password);
    setEmailError(eErr);
    setPasswordError(pErr);
    if (eErr || pErr) return;

    setLoading(true);
    try {
      await login(email, password);
      // After login, check store for MFA requirement
      const { mfaPending, isAuthenticated } = useAuthStore.getState();
      if (mfaPending) {
        navigate('/mfa-verify', { replace: true });
      } else if (isAuthenticated) {
        navigate(from ?? '/vault', { replace: true });
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Login failed. Please try again.';
      setServerError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-dvh bg-[#0A0A0B] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm animate-slide-up">
        {/* Card */}
        <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-8 shadow-card">
          <SecureVaultLogo />

          {/* Server error */}
          {serverError && (
            <div
              role="alert"
              className="mb-5 px-4 py-3 rounded-input bg-danger/10 border border-danger/30 text-sm text-danger"
            >
              {serverError}
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <Input
              label="Email address"
              type="email"
              id="login-email"
              placeholder="you@example.com"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={handleEmailChange}
              onBlur={() => setEmailError(validateEmail(email))}
              error={emailError ?? undefined}
              icon={<EmailIcon />}
              required
            />

            <Input
              label="Password"
              type="password"
              id="login-password"
              placeholder="Enter your password"
              autoComplete="current-password"
              value={password}
              onChange={handlePasswordChange}
              onBlur={() => setPasswordError(validatePassword(password))}
              error={passwordError ?? undefined}
              icon={<LockIcon />}
              required
            />

            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              loading={loading}
              className="mt-2"
            >
              Log In
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-[#71717A]">
            Don't have an account?{' '}
            <Link
              to="/register"
              className="text-primary hover:underline font-medium"
            >
              Create one
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
