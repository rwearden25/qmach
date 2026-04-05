import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { apiClient } from '../lib/api';
import { Button } from '../components/shared/Button';
import { Input } from '../components/shared/Input';
import { Modal } from '../components/shared/Modal';
import { PasswordStrength } from '../components/shared/PasswordStrength';
import { StorageBar } from '../components/vault/StorageBar';
import { useToast } from '../components/shared/Toast';

type SettingsTab = 'profile' | 'security' | 'sessions' | 'data';

interface SessionInfo {
  id: string;
  deviceInfo: string | null;
  ipAddress: string | null;
  createdAt: string;
  isCurrent: boolean;
}

interface MFAStatus {
  totpEnabled: boolean;
  webAuthnDevices: { id: string; name: string; createdAt: string }[];
}

/* ------------------------------------------------------------------ */
/* Icons                                                                */
/* ------------------------------------------------------------------ */

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00FF88" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="9" ry="3"/>
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
    </svg>
  );
}

function FingerprintIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 13.5V7a10 10 0 0 1 20 0v6.5"/>
      <path d="M6 12a6 6 0 0 1 6-6 6 6 0 0 1 6 6v1.5"/>
      <path d="M10 12a2 2 0 0 1 4 0v5"/>
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
      <path d="M10 11v6"/><path d="M14 11v6"/>
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Tab config                                                           */
/* ------------------------------------------------------------------ */

const TABS: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { id: 'profile',  label: 'Profile',  icon: <UserIcon /> },
  { id: 'security', label: 'Security', icon: <LockIcon /> },
  { id: 'sessions', label: 'Sessions', icon: <MonitorIcon /> },
  { id: 'data',     label: 'Data',     icon: <DatabaseIcon /> },
];

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

export default function SettingsPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<SettingsTab>('profile');

  // Security state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [pwError, setPwError] = useState('');

  // MFA state
  const [mfaStatus, setMfaStatus] = useState<MFAStatus | null>(null);
  const [mfaLoading, setMfaLoading] = useState(true);
  const [totpQr, setTotpQr] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpVerifyLoading, setTotpVerifyLoading] = useState(false);

  // Sessions state
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  // Data state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteMfaCode, setDeleteMfaCode] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [exportLoading, setExportLoading] = useState(false);

  // Storage
  const [storageUsed, setStorageUsed] = useState(0);
  const [storageLimit, setStorageLimit] = useState(5368709120);

  // WebAuthn availability
  const webAuthnAvailable = typeof window !== 'undefined' && 'PublicKeyCredential' in window;

  /* ---- Effects ---- */

  useEffect(() => {
    apiClient.get<{ used: number; limit: number }>('/vault/storage')
      .then((data) => { setStorageUsed(data.used ?? 0); setStorageLimit(data.limit ?? 5368709120); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (tab === 'security') {
      apiClient.get<MFAStatus>('/auth/mfa/status')
        .then(setMfaStatus)
        .catch(() => setMfaStatus({ totpEnabled: false, webAuthnDevices: [] }))
        .finally(() => setMfaLoading(false));
    }
  }, [tab]);

  const fetchSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const res = await apiClient.get<{ sessions: SessionInfo[] }>('/auth/sessions');
      setSessions(res.sessions ?? []);
    } catch { /* ignore */ }
    setLoadingSessions(false);
  }, []);

  useEffect(() => {
    if (tab === 'sessions') fetchSessions();
  }, [tab, fetchSessions]);

  /* ---- Handlers ---- */

  const handleChangePassword = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError('');
    if (newPassword !== confirmPassword) { setPwError('Passwords do not match'); return; }
    if (newPassword.length < 12) { setPwError('Password must be at least 12 characters'); return; }
    setChangingPassword(true);
    try {
      await apiClient.put('/auth/password', { currentPassword, newPassword });
      success('Password changed. Your vault keys have been re-wrapped.');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Failed to change password');
    }
    setChangingPassword(false);
  }, [currentPassword, newPassword, confirmPassword, success]);

  const handleEnableTOTP = useCallback(async () => {
    try {
      const { qrCodeUrl } = await apiClient.post<{ qrCodeUrl: string; secret: string }>('/auth/mfa/totp/enroll', {});
      setTotpQr(qrCodeUrl);
    } catch { toastError('Failed to start TOTP enrollment'); }
  }, [toastError]);

  const handleVerifyTOTP = useCallback(async () => {
    setTotpVerifyLoading(true);
    try {
      await apiClient.post('/auth/mfa/totp/verify', { code: totpCode });
      success('Authenticator app enabled');
      setTotpQr(null); setTotpCode('');
      setMfaStatus((prev) => prev ? { ...prev, totpEnabled: true } : prev);
    } catch { toastError('Invalid code, please try again.'); }
    setTotpVerifyLoading(false);
  }, [totpCode, success, toastError]);

  const handleDisableTOTP = useCallback(async () => {
    try {
      await apiClient.post('/auth/mfa/totp/disable', {});
      success('Authenticator app disabled');
      setMfaStatus((prev) => prev ? { ...prev, totpEnabled: false } : prev);
    } catch { toastError('Failed to disable TOTP'); }
  }, [success, toastError]);

  const handleRemoveWebAuthn = useCallback(async (deviceId: string) => {
    try {
      await apiClient.del(`/auth/mfa/webauthn/${deviceId}`);
      success('Device removed');
      setMfaStatus((prev) => prev
        ? { ...prev, webAuthnDevices: prev.webAuthnDevices.filter((d) => d.id !== deviceId) }
        : prev);
    } catch { toastError('Failed to remove device'); }
  }, [success, toastError]);

  const handleRevokeSession = useCallback(async (id: string) => {
    try {
      await apiClient.del(`/auth/sessions/${id}`);
      success('Session revoked');
      fetchSessions();
    } catch { toastError('Failed to revoke session'); }
  }, [success, toastError, fetchSessions]);

  const handleRevokeAll = useCallback(async () => {
    try {
      await apiClient.post('/auth/sessions/revoke-others', {});
      success('All other sessions revoked');
      fetchSessions();
    } catch { toastError('Failed to revoke sessions'); }
  }, [success, toastError, fetchSessions]);

  const handleExport = useCallback(async () => {
    setExportLoading(true);
    try {
      const res = await apiClient.get<{ downloadUrl: string }>('/vault/export');
      const a = document.createElement('a');
      a.href = res.downloadUrl; a.download = 'securevault-export.zip'; a.click();
      success('Export ready — download starting');
    } catch { toastError('Failed to export data'); }
    setExportLoading(false);
  }, [success, toastError]);

  const handleDeleteAccount = useCallback(async () => {
    setDeleting(true); setDeleteError('');
    try {
      await apiClient.post('/auth/account/delete', { password: deletePassword, mfaCode: deleteMfaCode || undefined });
      await logout();
      navigate('/');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete account');
    }
    setDeleting(false);
  }, [deletePassword, deleteMfaCode, logout, navigate]);

  /* ------------------------------------------------------------------ */

  return (
    <div className="min-h-dvh bg-[#0A0A0B]">

      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#0A0A0B]/95 backdrop-blur-sm border-b border-[#1F1F23]">
        <div className="max-w-screen-xl mx-auto px-4 tv:px-12 h-16 tv:h-20 flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/vault')}
            className="text-[#71717A] hover:text-[#FAFAFA] transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]"
            aria-label="Back to vault"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <ShieldIcon />
          <h1 className="text-lg font-heading font-bold text-[#FAFAFA] tv:text-2xl">Settings</h1>
        </div>
      </header>

      <div className="max-w-screen-xl mx-auto px-4 tv:px-12 py-8 tv:py-12 flex flex-col md:flex-row gap-8">

        {/* Sidebar / top tabs */}
        <nav aria-label="Settings navigation" className="md:w-52 tv:w-64 shrink-0">
          {/* Mobile: horizontal scroll */}
          <div className="flex md:hidden gap-1 overflow-x-auto pb-2 -mx-4 px-4">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={[
                  'flex items-center gap-2 px-4 py-2.5 rounded-pill text-sm font-medium whitespace-nowrap shrink-0',
                  'min-h-[44px] transition-colors duration-150',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
                  tab === t.id
                    ? 'bg-[#00FF88]/10 text-[#00FF88] border border-[#00FF88]/20'
                    : 'text-[#71717A] hover:text-[#FAFAFA] hover:bg-white/5',
                ].join(' ')}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
          {/* Desktop: vertical list */}
          <ul className="hidden md:flex flex-col gap-1">
            {TABS.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setTab(t.id)}
                  aria-current={tab === t.id ? 'page' : undefined}
                  className={[
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-input text-sm font-medium',
                    'min-h-[44px] transition-colors duration-150',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
                    tab === t.id
                      ? 'bg-[#00FF88]/10 text-[#00FF88] border border-[#00FF88]/20'
                      : 'text-[#71717A] hover:text-[#FAFAFA] hover:bg-white/[0.03]',
                  ].join(' ')}
                >
                  <span className={tab === t.id ? 'text-[#00FF88]' : ''}>{t.icon}</span>
                  {t.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Content */}
        <main className="flex-1 max-w-2xl tv:max-w-3xl space-y-4">

          {/* ---- Profile ---- */}
          {tab === 'profile' && (
            <>
              <div className="mb-6">
                <h2 className="text-xl font-heading font-bold text-[#FAFAFA] mb-1 tv:text-2xl">Profile</h2>
                <p className="text-sm text-[#71717A]">Your account information.</p>
              </div>
              <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-6 space-y-5">
                {/* Avatar + email */}
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-full bg-[#00FF88]/10 border border-[#00FF88]/20 flex items-center justify-center shrink-0">
                    <span className="text-2xl font-bold text-[#00FF88]">
                      {user?.email?.[0]?.toUpperCase() ?? 'U'}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-base font-medium text-[#FAFAFA] truncate">{user?.email ?? '—'}</p>
                    <p className="text-xs text-[#71717A] mt-0.5">Personal account</p>
                  </div>
                </div>
                <hr className="border-[#1F1F23]" />
                {/* Storage */}
                <div>
                  <p className="text-sm font-medium text-[#FAFAFA] mb-3">Storage Usage</p>
                  <StorageBar used={storageUsed} limit={storageLimit} variant="expanded" />
                </div>
              </div>
            </>
          )}

          {/* ---- Security ---- */}
          {tab === 'security' && (
            <>
              <div className="mb-6">
                <h2 className="text-xl font-heading font-bold text-[#FAFAFA] mb-1 tv:text-2xl">Security</h2>
                <p className="text-sm text-[#71717A]">Manage your password and authentication methods.</p>
              </div>

              {/* Change password */}
              <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-6 space-y-4">
                <h3 className="text-base font-semibold text-[#FAFAFA]">Change Password</h3>
                <div className="p-3 rounded-input bg-[#F59E0B]/10 border border-[#F59E0B]/20">
                  <p className="text-xs text-[#F59E0B]">Changing your password will re-wrap your vault encryption keys. Do not close the browser during this process.</p>
                </div>
                <form onSubmit={handleChangePassword} className="space-y-4">
                  <Input label="Current password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required />
                  <div className="space-y-2">
                    <Input label="New password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" hint="At least 12 characters recommended" required />
                    {newPassword && <PasswordStrength password={newPassword} />}
                  </div>
                  <Input label="Confirm new password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" error={pwError} required />
                  <Button type="submit" variant="primary" loading={changingPassword} disabled={!currentPassword || !newPassword || !confirmPassword}>
                    Update Password
                  </Button>
                </form>
              </div>

              {/* MFA */}
              <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-6 space-y-4">
                <h3 className="text-base font-semibold text-[#FAFAFA]">Multi-Factor Authentication</h3>
                {mfaLoading ? (
                  <div className="space-y-3 animate-pulse">
                    <div className="h-14 bg-[#1F1F23] rounded-input" />
                    <div className="h-14 bg-[#1F1F23] rounded-input" />
                  </div>
                ) : (
                  <div className="space-y-3">
                    {/* TOTP row */}
                    <div className="flex items-center justify-between gap-4 p-4 rounded-input border border-[#1F1F23] bg-[#0A0A0B]">
                      <div className="flex items-center gap-3 min-w-0">
                        <LockIcon />
                        <div>
                          <p className="text-sm font-medium text-[#FAFAFA]">Authenticator App (TOTP)</p>
                          <p className="text-xs text-[#71717A]">Google Authenticator, Authy, 1Password, etc.</p>
                        </div>
                      </div>
                      {mfaStatus?.totpEnabled ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[10px] font-semibold text-[#0A0A0B] bg-[#00FF88] px-2 py-0.5 rounded-full">Active</span>
                          <Button variant="ghost" size="sm" onClick={handleDisableTOTP} className="text-[#EF4444] hover:bg-[#EF4444]/10">Disable</Button>
                        </div>
                      ) : (
                        <Button variant="outline" size="sm" onClick={handleEnableTOTP}>Enable</Button>
                      )}
                    </div>
                    {/* TOTP enrollment QR */}
                    {totpQr && (
                      <div className="p-4 rounded-input border border-[#00FF88]/20 bg-[#00FF88]/5 space-y-4">
                        <p className="text-sm text-[#FAFAFA] font-medium">Scan with your authenticator app</p>
                        <img src={totpQr} alt="TOTP QR Code" className="w-40 h-40 bg-white p-2 rounded-input mx-auto" />
                        <div className="flex gap-2">
                          <Input placeholder="6-digit code" value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} className="flex-1" />
                          <Button variant="primary" size="sm" loading={totpVerifyLoading} disabled={totpCode.length !== 6} onClick={handleVerifyTOTP}>Verify</Button>
                        </div>
                      </div>
                    )}
                    {/* WebAuthn */}
                    {webAuthnAvailable && (
                      <div className="p-4 rounded-input border border-[#1F1F23] bg-[#0A0A0B] space-y-3">
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-3">
                            <FingerprintIcon />
                            <div>
                              <p className="text-sm font-medium text-[#FAFAFA]">Passkeys / Security Keys</p>
                              <p className="text-xs text-[#71717A]">Touch ID, Face ID, hardware keys (YubiKey, etc.)</p>
                            </div>
                          </div>
                          <Button variant="outline" size="sm" onClick={async () => {
                            try {
                              await apiClient.post('/auth/mfa/webauthn/register', {});
                              success('Device registered');
                            } catch { toastError('Registration failed'); }
                          }}>
                            Add device
                          </Button>
                        </div>
                        {mfaStatus && mfaStatus.webAuthnDevices.length > 0 && (
                          <ul className="space-y-1 pt-2 border-t border-[#1F1F23]">
                            {mfaStatus.webAuthnDevices.map((d) => (
                              <li key={d.id} className="flex items-center justify-between text-sm py-1.5">
                                <span className="text-[#FAFAFA] truncate">{d.name}</span>
                                <button type="button" onClick={() => handleRemoveWebAuthn(d.id)}
                                  className="text-xs text-[#EF4444] hover:underline ml-4 shrink-0 min-h-[44px] px-2 flex items-center">
                                  Remove
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ---- Sessions ---- */}
          {tab === 'sessions' && (
            <>
              <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
                <div>
                  <h2 className="text-xl font-heading font-bold text-[#FAFAFA] mb-1 tv:text-2xl">Active Sessions</h2>
                  <p className="text-sm text-[#71717A]">Manage where you're signed in.</p>
                </div>
                {sessions.filter((s) => !s.isCurrent).length > 0 && (
                  <Button variant="outline" size="sm" onClick={handleRevokeAll}>Revoke All Others</Button>
                )}
              </div>
              <div className="space-y-3">
                {loadingSessions ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="bg-[#141416] border border-[#1F1F23] rounded-card p-4 animate-pulse h-20" />
                  ))
                ) : sessions.length === 0 ? (
                  <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-6 text-center">
                    <p className="text-sm text-[#71717A]">No active sessions found.</p>
                  </div>
                ) : sessions.map((s) => (
                  <div
                    key={s.id}
                    className={[
                      'bg-[#141416] border rounded-card p-4 flex items-center gap-4',
                      s.isCurrent ? 'border-[#00FF88]/30' : 'border-[#1F1F23]',
                    ].join(' ')}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm text-[#FAFAFA] truncate font-medium">{s.deviceInfo ?? 'Unknown device'}</p>
                        {s.isCurrent && (
                          <span className="px-2 py-0.5 rounded-pill text-[10px] font-semibold text-[#0A0A0B] bg-[#00FF88] shrink-0">
                            This device
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[#71717A] mt-1">
                        {s.ipAddress ?? 'Unknown IP'} &middot; {new Date(s.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    {!s.isCurrent && (
                      <Button variant="ghost" size="sm" onClick={() => handleRevokeSession(s.id)}
                        className="text-[#EF4444] hover:bg-[#EF4444]/10 shrink-0">
                        Revoke
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ---- Data ---- */}
          {tab === 'data' && (
            <>
              <div className="mb-6">
                <h2 className="text-xl font-heading font-bold text-[#FAFAFA] mb-1 tv:text-2xl">Your Data</h2>
                <p className="text-sm text-[#71717A]">Export or permanently delete your data.</p>
              </div>

              {/* Export */}
              <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-6 space-y-4">
                <h3 className="text-base font-semibold text-[#FAFAFA]">Export Data</h3>
                <p className="text-sm text-[#71717A]">
                  Download an encrypted archive of all your vault files and metadata.
                  You will need your master password to decrypt the export.
                </p>
                <Button variant="outline" loading={exportLoading} onClick={handleExport}>
                  <DownloadIcon />
                  Export My Data
                </Button>
              </div>

              {/* Danger zone */}
              <div className="bg-[#141416] border border-[#EF4444]/20 rounded-card p-6 space-y-4">
                <h3 className="text-base font-semibold text-[#EF4444]">Danger Zone</h3>
                <p className="text-sm text-[#71717A]">
                  Permanently delete your account, all files, and all encryption keys.
                  This action cannot be undone.
                </p>
                <Button variant="danger" onClick={() => setDeleteModalOpen(true)}>
                  <TrashIcon />
                  Delete My Account
                </Button>
              </div>
            </>
          )}
        </main>
      </div>

      {/* ---- Delete confirmation modal ---- */}
      <Modal
        open={deleteModalOpen}
        onClose={() => { setDeleteModalOpen(false); setDeletePassword(''); setDeleteMfaCode(''); setDeleteError(''); }}
        title="Delete Account"
        size="sm"
      >
        <div className="space-y-4">
          <div className="p-3 rounded-input bg-[#EF4444]/10 border border-[#EF4444]/20">
            <p className="text-sm text-[#EF4444] font-medium">This is irreversible.</p>
            <p className="text-xs text-[#71717A] mt-1">All your files, folders, and encryption keys will be permanently deleted.</p>
          </div>
          <Input label="Confirm your password" type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} autoComplete="current-password" required />
          <Input label="MFA code (if enabled)" placeholder="6-digit code" value={deleteMfaCode} onChange={(e) => setDeleteMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          {deleteError && (
            <p className="text-sm text-[#EF4444] bg-[#EF4444]/10 border border-[#EF4444]/20 rounded-input px-3 py-2">{deleteError}</p>
          )}
          <div className="flex gap-3">
            <Button variant="outline" fullWidth onClick={() => { setDeleteModalOpen(false); setDeletePassword(''); setDeleteMfaCode(''); setDeleteError(''); }}>Cancel</Button>
            <Button variant="danger" fullWidth loading={deleting} disabled={!deletePassword} onClick={handleDeleteAccount}>
              Permanently Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
