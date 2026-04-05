import React, { useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import zxcvbn from 'zxcvbn';
import { apiClient } from '../../lib/api';
import { Button } from '../shared/Button';
import { Input } from '../shared/Input';
import { Modal } from '../shared/Modal';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

interface MFASetupData {
  qrCodeUrl: string;
  manualSecret: string;
  backupCodes: string[];
  recoveryKey: string;
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                   */
/* ------------------------------------------------------------------ */

function validateEmail(email: string): string | null {
  if (!email.trim()) return 'Email is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return 'Enter a valid email address';
  return null;
}

function validatePassword(password: string): string | null {
  if (!password) return 'Password is required';
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (!/[A-Z]/.test(password)) return 'Include at least one uppercase letter';
  if (!/[0-9]/.test(password)) return 'Include at least one number';
  return null;
}

function validateConfirmPassword(
  password: string,
  confirm: string,
): string | null {
  if (!confirm) return 'Please confirm your password';
  if (confirm !== password) return 'Passwords do not match';
  return null;
}

/* ------------------------------------------------------------------ */
/* Password strength meter                                              */
/* ------------------------------------------------------------------ */

const strengthConfig = [
  { label: 'Very weak', color: 'bg-danger', textColor: 'text-danger' },
  { label: 'Weak',      color: 'bg-orange-500', textColor: 'text-orange-500' },
  { label: 'Fair',      color: 'bg-warning', textColor: 'text-warning' },
  { label: 'Strong',    color: 'bg-primary', textColor: 'text-primary' },
  { label: 'Very strong', color: 'bg-primary', textColor: 'text-primary' },
];

function PasswordStrengthMeter({ password }: { password: string }) {
  if (!password) return null;

  const result = zxcvbn(password);
  const score = result.score; // 0–4
  const config = strengthConfig[score];

  return (
    <div className="mt-2 space-y-1.5">
      {/* Bar segments */}
      <div className="flex gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={[
              'h-1 flex-1 rounded-full transition-all duration-300',
              i <= score ? config.color : 'bg-[#1F1F23]',
            ].join(' ')}
          />
        ))}
      </div>
      {/* Label */}
      <p className={`text-xs font-medium ${config.textColor}`}>
        {config.label}
        {result.feedback.warning ? ` — ${result.feedback.warning}` : ''}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Icons                                                                */
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

function CopyIcon() {
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
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon() {
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
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function DownloadIcon() {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Copy button with feedback                                            */
/* ------------------------------------------------------------------ */

function CopyButton({
  text,
  label = 'Copy',
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for environments without clipboard API
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={[
        'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-input',
        'border transition-all duration-150 min-h-[44px]',
        copied
          ? 'border-primary/50 bg-primary/10 text-primary'
          : 'border-[#1F1F23] bg-[#0A0A0B] text-[#71717A] hover:border-[#71717A] hover:text-[#FAFAFA]',
      ].join(' ')}
      aria-label={copied ? 'Copied!' : label}
    >
      {copied ? (
        <>
          <CheckIcon />
          Copied!
        </>
      ) : (
        <>
          <CopyIcon />
          {label}
        </>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* MFA Setup Modal                                                      */
/* ------------------------------------------------------------------ */

type MFAStep = 'qrcode' | 'backup' | 'recovery';

interface MFASetupModalProps {
  open: boolean;
  data: MFASetupData | null;
  onComplete: () => void;
}

function MFASetupModal({ open, data, onComplete }: MFASetupModalProps) {
  const [step, setStep] = useState<MFAStep>('qrcode');
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [secretVisible, setSecretVisible] = useState(false);

  const handleVerify = async () => {
    if (!verifyCode || verifyCode.length !== 6) {
      setVerifyError('Enter the 6-digit code from your authenticator app');
      return;
    }
    setVerifying(true);
    setVerifyError(null);
    try {
      await apiClient.post('/auth/mfa/setup/verify', { code: verifyCode });
      setStep('backup');
    } catch (err: unknown) {
      setVerifyError(
        err instanceof Error ? err.message : 'Invalid code. Please try again.',
      );
    } finally {
      setVerifying(false);
    }
  };

  const handleDownloadRecovery = () => {
    if (!data) return;
    const content = [
      'SecureVault Recovery Key',
      '========================',
      '',
      'Store this key in a safe place. It can be used to regain access',
      'to your account if you lose your two-factor authentication device.',
      '',
      `Recovery Key: ${data.recoveryKey}`,
      '',
      `Generated: ${new Date().toISOString()}`,
    ].join('\n');

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'securevault-recovery-key.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!data) return null;

  return (
    <Modal
      open={open}
      onClose={() => {}} // persistent — user must complete setup
      title={
        step === 'qrcode'
          ? 'Set Up Two-Factor Authentication'
          : step === 'backup'
            ? 'Save Your Backup Codes'
            : 'Save Your Recovery Key'
      }
      size="md"
      persistent
    >
      {/* Step: QR Code */}
      {step === 'qrcode' && (
        <div className="space-y-5">
          <p className="text-sm text-[#71717A] leading-relaxed">
            Scan this QR code with your authenticator app (Google Authenticator,
            Authy, 1Password, etc.), then enter the 6-digit code to verify.
          </p>

          {/* QR Code */}
          <div className="flex justify-center">
            <div className="p-3 bg-white rounded-input inline-block">
              <img
                src={data.qrCodeUrl}
                alt="MFA QR code — scan with your authenticator app"
                width={160}
                height={160}
                className="block"
              />
            </div>
          </div>

          {/* Manual secret */}
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setSecretVisible((v) => !v)}
              className="text-xs text-[#71717A] hover:text-[#FAFAFA] underline transition-colors"
            >
              {secretVisible ? 'Hide' : 'Show'} manual entry key
            </button>
            {secretVisible && (
              <div className="flex items-center gap-2 p-3 bg-[#0A0A0B] border border-[#1F1F23] rounded-input">
                <code className="flex-1 text-xs text-primary font-mono break-all">
                  {data.manualSecret}
                </code>
                <CopyButton text={data.manualSecret} label="Copy key" />
              </div>
            )}
          </div>

          {/* Verify input */}
          <div className="space-y-3">
            <Input
              label="Verification code"
              type="text"
              id="mfa-verify-code"
              placeholder="000000"
              value={verifyCode}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                setVerifyCode(v);
                if (verifyError) setVerifyError(null);
              }}
              error={verifyError ?? undefined}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
            />
            <Button
              type="button"
              variant="primary"
              size="md"
              fullWidth
              loading={verifying}
              onClick={handleVerify}
              disabled={verifyCode.length !== 6}
            >
              Verify and Continue
            </Button>
          </div>
        </div>
      )}

      {/* Step: Backup codes */}
      {step === 'backup' && (
        <div className="space-y-5">
          <p className="text-sm text-[#71717A] leading-relaxed">
            Save these backup codes in a secure location. Each code can be used
            once to sign in if you lose access to your authenticator app.
          </p>

          {/* Backup codes grid */}
          <div className="bg-[#0A0A0B] border border-[#1F1F23] rounded-input p-4">
            <div className="grid grid-cols-2 gap-2">
              {data.backupCodes.map((code, i) => (
                <code
                  key={i}
                  className="text-sm font-mono text-[#FAFAFA] py-1 text-center tracking-widest"
                >
                  {code}
                </code>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <CopyButton
              text={data.backupCodes.join('\n')}
              label="Copy all codes"
            />
          </div>

          <Button
            type="button"
            variant="primary"
            size="md"
            fullWidth
            onClick={() => setStep('recovery')}
          >
            I've saved my backup codes
          </Button>
        </div>
      )}

      {/* Step: Recovery key */}
      {step === 'recovery' && (
        <div className="space-y-5">
          <p className="text-sm text-[#71717A] leading-relaxed">
            This recovery key is your last resort if you lose both your
            authenticator and backup codes. Store it somewhere extremely safe —
            it cannot be regenerated.
          </p>

          {/* Recovery key display */}
          <div className="bg-[#0A0A0B] border border-primary/30 rounded-input p-4">
            <code className="block text-sm font-mono text-primary break-all text-center tracking-wider leading-loose">
              {data.recoveryKey}
            </code>
          </div>

          <div className="flex gap-2 flex-wrap">
            <CopyButton text={data.recoveryKey} label="Copy key" />
            <button
              type="button"
              onClick={handleDownloadRecovery}
              className={[
                'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-input',
                'border border-[#1F1F23] bg-[#0A0A0B] text-[#71717A]',
                'hover:border-[#71717A] hover:text-[#FAFAFA]',
                'transition-all duration-150 min-h-[44px]',
              ].join(' ')}
            >
              <DownloadIcon />
              Download as .txt
            </button>
          </div>

          {/* Confirmation checkbox */}
          <label className="flex items-start gap-3 cursor-pointer group">
            <div className="relative flex-shrink-0 mt-0.5">
              <input
                type="checkbox"
                checked={recoveryConfirmed}
                onChange={(e) => setRecoveryConfirmed(e.target.checked)}
                className="sr-only peer"
              />
              <div
                className={[
                  'w-5 h-5 rounded border-2 transition-all duration-150',
                  'flex items-center justify-center',
                  recoveryConfirmed
                    ? 'border-primary bg-primary'
                    : 'border-[#1F1F23] bg-transparent group-hover:border-[#71717A]',
                ].join(' ')}
              >
                {recoveryConfirmed && (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#0A0A0B"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </div>
            </div>
            <span className="text-sm text-[#71717A] leading-relaxed">
              I've saved my recovery key in a secure location and understand I
              cannot recover it later.
            </span>
          </label>

          <Button
            type="button"
            variant="primary"
            size="md"
            fullWidth
            disabled={!recoveryConfirmed}
            onClick={onComplete}
          >
            Complete Setup
          </Button>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Logo                                                                 */
/* ------------------------------------------------------------------ */

function SecureVaultLogo() {
  return (
    <div className="flex flex-col items-center gap-2 mb-8">
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
      <p className="text-sm text-[#71717A]">Create your secure account</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function RegisterPage() {
  const navigate = useNavigate();

  /* ---- form state ---- */
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /* ---- MFA setup modal ---- */
  const [mfaModalOpen, setMfaModalOpen] = useState(false);
  const [mfaData, setMfaData] = useState<MFASetupData | null>(null);

  /* ---- real-time validation ---- */
  const handleEmailChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setEmail(e.target.value);
      if (emailError) setEmailError(validateEmail(e.target.value));
    },
    [emailError],
  );

  const handlePasswordChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPassword(e.target.value);
      if (passwordError) setPasswordError(validatePassword(e.target.value));
      if (confirmError && confirmPassword)
        setConfirmError(
          validateConfirmPassword(e.target.value, confirmPassword),
        );
    },
    [passwordError, confirmError, confirmPassword],
  );

  const handleConfirmChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setConfirmPassword(e.target.value);
      if (confirmError)
        setConfirmError(validateConfirmPassword(password, e.target.value));
    },
    [confirmError, password],
  );

  /* ---- submit ---- */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    const eErr = validateEmail(email);
    const pErr = validatePassword(password);
    const cErr = validateConfirmPassword(password, confirmPassword);

    setEmailError(eErr);
    setPasswordError(pErr);
    setConfirmError(cErr);

    if (eErr || pErr || cErr) return;

    setLoading(true);
    try {
      const data = await apiClient.post<MFASetupData>('/auth/register', {
        email,
        password,
      });
      setMfaData(data);
      setMfaModalOpen(true);
    } catch (err: unknown) {
      setServerError(
        err instanceof Error
          ? err.message
          : 'Registration failed. Please try again.',
      );
    } finally {
      setLoading(false);
    }
  };

  const handleMFAComplete = () => {
    setMfaModalOpen(false);
    navigate('/vault', { replace: true });
  };

  return (
    <>
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
                id="register-email"
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

              <div>
                <Input
                  label="Password"
                  type="password"
                  id="register-password"
                  placeholder="At least 12 characters"
                  autoComplete="new-password"
                  value={password}
                  onChange={handlePasswordChange}
                  onBlur={() => setPasswordError(validatePassword(password))}
                  error={passwordError ?? undefined}
                  icon={<LockIcon />}
                  required
                />
                <PasswordStrengthMeter password={password} />
              </div>

              <Input
                label="Confirm password"
                type="password"
                id="register-confirm"
                placeholder="Repeat your password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={handleConfirmChange}
                onBlur={() =>
                  setConfirmError(
                    validateConfirmPassword(password, confirmPassword),
                  )
                }
                error={confirmError ?? undefined}
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
                Create Account
              </Button>
            </form>

            <p className="mt-6 text-center text-sm text-[#71717A]">
              Already have an account?{' '}
              <Link
                to="/login"
                className="text-primary hover:underline font-medium"
              >
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </main>

      {/* MFA setup modal — shown after successful registration */}
      <MFASetupModal
        open={mfaModalOpen}
        data={mfaData}
        onComplete={handleMFAComplete}
      />
    </>
  );
}
