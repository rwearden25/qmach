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

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00FF88" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>
  );
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'security', label: 'Security' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'data', label: 'Data' },
];

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

  // Sessions state
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  // Data state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteMfaCode, setDeleteMfaCode] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Storage
  const [storageUsed, setStorageUsed] = useState(0);
  const [storageLimit, setStorageLimit] = useState(5368709120);

  // WebAuthn availability
  const webAuthnAvailable = typeof window !== 'undefined' && 'PublicKeyCredential' in window;

  useEffect(() => {
    apiClient.get('/files/storage').then((res: unknown) => {
      const data = res as { used: number; limit: number };
      setStorageUsed(data.used ?? 0);
      setStorageLimit(data.limit ?? 5368709120);
    }).catch(() => {});
  }, []);

  const fetchSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const res = await apiClient.get('/account/sessions') as { sessions: SessionInfo[] };
      setSessions(res.sessions ?? []);
    } catch { /* ignore */ }
    setLoadingSessions(false);
  }, []);

  useEffect(() => {
    if (tab === 'sessions') fetchSessions();
  }, [tab, fetchSessions]);

  const handleChangePassword = async () => {
    if (newPassword !== confirmPassword) { toastError('Passwords do not match'); return; }
    if (newPassword.length < 12) { toastError('Password must be at least 12 characters'); return; }
    setChangingPassword(true);
    try {
      await apiClient.put('/account/password', { currentPassword, newPassword });
      success('Password changed. Your vault keys have been re-wrapped.');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    } catch { toastError('Failed to change password'); }
    setChangingPassword(false);
  };

  const handleRevokeSession = async (id: string) => {
    try {
      await apiClient.delete(`/account/sessions/${id}`);
      success('Session revoked');
      fetchSessions();
    } catch { toastError('Failed to revoke session'); }
  };

  const handleRevokeAll = async () => {
    try {
      await apiClient.delete('/account/sessions');
      success('All other sessions revoked');
      fetchSessions();
    } catch { toastError('Failed to revoke sessions'); }
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    try {
      await apiClient.delete('/account', { data: { password: deletePassword, mfaCode: deleteMfaCode } });
      await logout();
      navigate('/');
    } catch { toastError('Failed to delete account'); }
    setDeleting(false);
  };

  return (
    <div className="min-h-dvh bg-[#0A0A0B]">
      {/* Header */}
      <header className="border-b border-[#1F1F23]">
        <div className="max-w-screen-xl mx-auto px-4 tv:px-12 h-16 flex items-center gap-3">
          <button onClick={() => navigate('/vault')} className="text-[#71717A] hover:text-[#FAFAFA] transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center focus-visible:outline-2 focus-visible:outline-[#00FF88]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <ShieldIcon />
          <h1 className="text-lg font-heading font-bold text-[#FAFAFA]">Settings</h1>
        </div>
      </header>

      <div className="max-w-screen-xl mx-auto px-4 tv:px-12 py-8 flex flex-col md:flex-row gap-8">
        {/* Sidebar / top tabs */}
        <nav className="md:w-48 shrink-0">
          <div className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible">
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-4 py-2.5 rounded-input text-sm font-medium whitespace-nowrap transition-colors min-h-[44px] focus-visible:outline-2 focus-visible:outline-[#00FF88] ${
                  tab === t.id ? 'bg-[#00FF88]/10 text-[#00FF88]' : 'text-[#71717A] hover:text-[#FAFAFA] hover:bg-white/5'
                }`}
              >{t.label}</button>
            ))}
          </div>
        </nav>

        {/* Content */}
        <main className="flex-1 max-w-2xl">
          {/* Profile */}
          {tab === 'profile' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-heading font-bold text-[#FAFAFA] mb-1">Profile</h2>
                <p className="text-sm text-[#71717A]">Your account information.</p>
              </div>
              <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-6 space-y-4">
                <div>
                  <label className="text-xs text-[#71717A] uppercase tracking-wider">Email</label>
                  <p className="text-[#FAFAFA] mt-1">{user?.email ?? '—'}</p>
                </div>
                <div>
                  <label className="text-xs text-[#71717A] uppercase tracking-wider">Member Since</label>
                  <p className="text-[#FAFAFA] mt-1">{user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}</p>
                </div>
                <div>
                  <label className="text-xs text-[#71717A] uppercase tracking-wider mb-2 block">Storage</label>
                  <StorageBar used={storageUsed} limit={storageLimit} />
                </div>
              </div>
            </div>
          )}

          {/* Security */}
          {tab === 'security' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-heading font-bold text-[#FAFAFA] mb-1">Security</h2>
                <p className="text-sm text-[#71717A]">Manage your password and authentication.</p>
              </div>

              {/* Change password */}
              <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-6 space-y-4">
                <h3 className="text-base font-semibold text-[#FAFAFA]">Change Password</h3>
                <div className="p-3 rounded-input bg-[#F59E0B]/10 border border-[#F59E0B]/20">
                  <p className="text-xs text-[#F59E0B]">Changing your password will re-encrypt your vault keys. Do not close the browser during this process.</p>
                </div>
                <Input label="Current password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
                <div>
                  <Input label="New password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                  {newPassword && <PasswordStrength password={newPassword} />}
                </div>
                <Input label="Confirm new password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} error={confirmPassword && newPassword !== confirmPassword ? 'Passwords do not match' : undefined} />
                <Button variant="primary" onClick={handleChangePassword} loading={changingPassword} disabled={!currentPassword || !newPassword || !confirmPassword}>
                  Update Password
                </Button>
              </div>

              {/* MFA */}
              <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-6 space-y-4">
                <h3 className="text-base font-semibold text-[#FAFAFA]">Multi-Factor Authentication</h3>
                <div className="flex items-center gap-3">
                  <span className="px-2.5 py-1 rounded-pill text-xs font-medium bg-[#00FF88]/10 text-[#00FF88] border border-[#00FF88]/20">TOTP Enabled</span>
                </div>
                <Button variant="outline" size="sm">Regenerate Backup Codes</Button>
              </div>

              {/* WebAuthn */}
              {webAuthnAvailable && (
                <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-6 space-y-4">
                  <h3 className="text-base font-semibold text-[#FAFAFA]">Passkeys & Security Keys</h3>
                  <p className="text-sm text-[#71717A]">Add hardware keys or passkeys as additional authentication factors.</p>
                  <Button variant="outline" size="sm">Register New Device</Button>
                </div>
              )}
            </div>
          )}

          {/* Sessions */}
          {tab === 'sessions' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-heading font-bold text-[#FAFAFA] mb-1">Active Sessions</h2>
                  <p className="text-sm text-[#71717A]">Manage your active login sessions.</p>
                </div>
                <Button variant="outline" size="sm" onClick={handleRevokeAll}>Revoke All Others</Button>
              </div>

              <div className="space-y-3">
                {loadingSessions ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="bg-[#141416] border border-[#1F1F23] rounded-card p-4 animate-pulse h-20" />
                  ))
                ) : sessions.length === 0 ? (
                  <p className="text-sm text-[#71717A]">No active sessions found.</p>
                ) : sessions.map((s) => (
                  <div key={s.id} className={`bg-[#141416] border rounded-card p-4 flex items-center gap-4 ${s.isCurrent ? 'border-[#00FF88]/30' : 'border-[#1F1F23]'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-[#FAFAFA] truncate">{s.deviceInfo ?? 'Unknown device'}</p>
                        {s.isCurrent && <span className="px-2 py-0.5 rounded-pill text-[10px] font-medium bg-[#00FF88]/10 text-[#00FF88]">Current</span>}
                      </div>
                      <p className="text-xs text-[#71717A] mt-1">{s.ipAddress ?? 'Unknown IP'} &middot; {new Date(s.createdAt).toLocaleDateString()}</p>
                    </div>
                    {!s.isCurrent && (
                      <Button variant="outline" size="sm" onClick={() => handleRevokeSession(s.id)}>Revoke</Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Data */}
          {tab === 'data' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-heading font-bold text-[#FAFAFA] mb-1">Your Data</h2>
                <p className="text-sm text-[#71717A]">Export or delete your data.</p>
              </div>

              <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-6 space-y-4">
                <h3 className="text-base font-semibold text-[#FAFAFA]">Export Data (GDPR)</h3>
                <p className="text-sm text-[#71717A]">Download a copy of all your data including encrypted files and metadata.</p>
                <Button variant="outline">Download All Data</Button>
              </div>

              <div className="bg-[#141416] border border-[#EF4444]/20 rounded-card p-6 space-y-4">
                <h3 className="text-base font-semibold text-[#EF4444]">Delete Account</h3>
                <p className="text-sm text-[#71717A]">Permanently delete your account and all associated data. This action cannot be undone.</p>
                <Button variant="danger" onClick={() => setDeleteModalOpen(true)}>Delete My Account</Button>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Delete confirmation modal */}
      <Modal isOpen={deleteModalOpen} onClose={() => setDeleteModalOpen(false)} size="sm">
        <div className="p-6 space-y-4">
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-[#EF4444]/10 border border-[#EF4444]/20 flex items-center justify-center mx-auto mb-3">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            </div>
            <h3 className="text-lg font-semibold text-[#FAFAFA]">Delete Account</h3>
            <p className="text-sm text-[#71717A] mt-2">This will permanently delete your account, all files, and all encryption keys. This cannot be undone.</p>
          </div>
          <Input label="Confirm password" type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} />
          <Input label="MFA code" placeholder="6-digit code" value={deleteMfaCode} onChange={(e) => setDeleteMfaCode(e.target.value)} />
          <div className="flex gap-3">
            <Button variant="outline" fullWidth onClick={() => setDeleteModalOpen(false)}>Cancel</Button>
            <Button variant="danger" fullWidth loading={deleting} onClick={handleDeleteAccount} disabled={!deletePassword || !deleteMfaCode}>Delete Forever</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
