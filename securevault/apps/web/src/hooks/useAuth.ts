/**
 * useAuth – React hook that wraps the authStore with higher-level logic.
 *
 * Responsibilities:
 *  - login()      Call POST /auth/login; surface the MFA-challenge path.
 *  - verifyMFA()  Call POST /auth/mfa-verify with challenge token + code.
 *  - register()   Call POST /auth/register; return MFA setup data.
 *  - logout()     Call POST /auth/logout; clear all stores.
 *  - isAuthenticated  Derived from store state.
 *  - Auto-refresh the access token 60 s before the JWT expires.
 *
 * Token lifetime is decoded from the JWT payload so this hook is robust
 * to server-side changes without hard-coding a constant.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuthStore, type AuthUser } from '../stores/authStore';
import { apiClient } from '../lib/api';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

/** Returned by register() — caller should display these to the user. */
export interface MFASetupData {
  /** Raw TOTP secret (display as text and in the QR code). */
  mfaSecret: string;
  /** Data URL for the QR code image. */
  qrCode: string;
  /** One-time backup codes. */
  backupCodes: string[];
  /** 64-hex-char recovery key. */
  recoveryKey: string;
}

/** Shape of the login API response after credentials are verified. */
interface LoginApiResponse {
  challengeToken: string;
  mfaRequired: true;
}

/** Shape of the MFA verify API response. */
interface MfaVerifyApiResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    mfaEnabled: boolean;
  };
}

/** Shape of the register API response. */
interface RegisterApiResponse {
  mfaSecret: string;
  qrCode: string;
  backupCodes: string[];
  recoveryKey: string;
}

/* ------------------------------------------------------------------ */
/* JWT decode helper (no library needed — we only read the payload)    */
/* ------------------------------------------------------------------ */

interface JwtPayload {
  exp?: number;
  sub?: string;
  userId?: string;
}

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // Base64url → base64 → JSON
    const base64 = parts[1]!
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(parts[1]!.length + ((4 - (parts[1]!.length % 4)) % 4), '=');
    return JSON.parse(atob(base64)) as JwtPayload;
  } catch {
    return null;
  }
}

/** Return the number of milliseconds until a JWT expires (negative if expired). */
function msUntilExpiry(token: string): number {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return -1;
  return payload.exp * 1000 - Date.now();
}

/* ------------------------------------------------------------------ */
/* Hook                                                                 */
/* ------------------------------------------------------------------ */

export function useAuth() {
  const store = useAuthStore();

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ref for the auto-refresh timer
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---------------------------------------------------------------- */
  /* Auto-refresh                                                       */
  /* ---------------------------------------------------------------- */

  /** Schedule a token refresh 60 s before the current access token expires. */
  const scheduleRefresh = useCallback((token: string) => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    const remaining = msUntilExpiry(token);
    // Refresh 60 seconds before expiry; never schedule in the past
    const delay = Math.max(0, remaining - 60_000);

    refreshTimerRef.current = setTimeout(async () => {
      const newToken = await store.refreshToken();
      if (newToken) {
        scheduleRefresh(newToken);
      }
    }, delay);
  }, [store]);

  // Whenever the access token in the store changes, (re)schedule refresh
  useEffect(() => {
    const token = store.accessToken;
    if (token && store.isAuthenticated) {
      scheduleRefresh(token);
    }
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [store.accessToken, store.isAuthenticated, scheduleRefresh]);

  /* ---------------------------------------------------------------- */
  /* login                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Submit credentials to POST /auth/login.
   *
   * The server always responds with an MFA challenge (mfaRequired: true)
   * even for accounts without MFA, so the challenge-token flow is always used.
   * The store is updated to reflect the pending MFA state so the UI can
   * redirect to the MFA verification screen.
   */
  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      setIsLoading(true);
      setError(null);

      try {
        const data = await apiClient.post<LoginApiResponse>('/auth/login', {
          email,
          password,
        });

        // Update auth store — the challenge token is stored for use in verifyMFA
        useAuthStore.setState({
          user: null,
          accessToken: null,
          isAuthenticated: false,
          mfaRequired: data.mfaRequired,
          mfaPending: true,
          mfaToken: data.challengeToken,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Login failed';
        setError(message);
        throw new Error(message);
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  /* ---------------------------------------------------------------- */
  /* verifyMFA                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Submit a 6-digit TOTP code (or 8-char backup code) along with the
   * challenge token that was returned from login().
   *
   * On success, the full access token is stored in the auth store and the
   * auto-refresh timer is started.
   */
  const verifyMFA = useCallback(
    async (code: string): Promise<void> => {
      const challengeToken = useAuthStore.getState().mfaToken;

      if (!challengeToken) {
        throw new Error('No active MFA challenge. Please log in again.');
      }

      setIsLoading(true);
      setError(null);

      try {
        const data = await apiClient.post<MfaVerifyApiResponse>(
          '/auth/mfa-verify',
          { challengeToken, code },
        );

        const user: AuthUser = {
          id: data.user.id,
          email: data.user.email,
          name: data.user.email, // display name not provided at this point
        };

        useAuthStore.setState({
          user,
          accessToken: data.accessToken,
          isAuthenticated: true,
          mfaRequired: false,
          mfaPending: false,
          mfaToken: null,
        });

        // Kick off the refresh cycle
        scheduleRefresh(data.accessToken);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'MFA verification failed';
        setError(message);
        throw new Error(message);
      } finally {
        setIsLoading(false);
      }
    },
    [scheduleRefresh],
  );

  /* ---------------------------------------------------------------- */
  /* register                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Create a new account via POST /auth/register.
   *
   * The server returns the TOTP secret, QR-code data URL, backup codes, and
   * recovery key — all of which must be displayed to the user exactly once.
   *
   * The caller is responsible for generating and passing the wrappedMasterKey
   * (produced by crypto.ts wrapMasterKeyWithRecovery or deriveSubKey / wrapKey
   * before calling register).
   *
   * Note: registration does NOT issue a session — the user must complete a
   * full login + MFA flow after registering.
   */
  const register = useCallback(
    async (
      email: string,
      password: string,
      wrappedMasterKey: string,
    ): Promise<MFASetupData> => {
      setIsLoading(true);
      setError(null);

      try {
        const data = await apiClient.post<RegisterApiResponse>(
          '/auth/register',
          { email, password, wrappedMasterKey },
        );

        return {
          mfaSecret: data.mfaSecret,
          qrCode: data.qrCode,
          backupCodes: data.backupCodes,
          recoveryKey: data.recoveryKey,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Registration failed';
        setError(message);
        throw new Error(message);
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  /* ---------------------------------------------------------------- */
  /* logout                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Revoke the server-side session and clear all local state.
   * Navigating to /login is left to the caller.
   */
  const logout = useCallback(async (): Promise<void> => {
    // Cancel the pending refresh timer
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }

    setError(null);

    // Best-effort server-side logout (clears the HttpOnly refresh-token cookie)
    try {
      await apiClient.post('/auth/logout', {});
    } catch {
      // If the network request fails, still clear local state
    }

    useAuthStore.setState({
      user: null,
      accessToken: null,
      isAuthenticated: false,
      mfaRequired: false,
      mfaPending: false,
      mfaToken: null,
    });
  }, []);

  /* ---------------------------------------------------------------- */
  /* isAuthenticated                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * True when the store has both a user and an access token.
   * This mirrors the store's own isAuthenticated flag but also performs
   * a live expiry check on the token so stale in-memory state is caught
   * before making an API call.
   */
  const isAuthenticated = useCallback((): boolean => {
    const state = useAuthStore.getState();
    if (!state.isAuthenticated || !state.accessToken) return false;
    return msUntilExpiry(state.accessToken) > 0;
  }, []);

  /* ---------------------------------------------------------------- */
  /* Derived values                                                     */
  /* ---------------------------------------------------------------- */

  const user: AuthUser | null = store.user;
  const mfaPending: boolean = store.mfaPending;
  const mfaRequired: boolean = store.mfaRequired;

  return {
    /** Authenticated user or null. */
    user,
    /** True when the user has completed authentication (including MFA). */
    isAuthenticated: isAuthenticated(),
    /** True while an MFA flow has been started but not yet completed. */
    mfaPending,
    /** True when the server indicated MFA is required for this account. */
    mfaRequired,
    /** True while any async auth operation is in flight. */
    isLoading,
    /** Last error message from any auth operation. */
    error,
    /** Submit email + password credentials; transitions to MFA pending state. */
    login,
    /** Submit MFA code after a successful login(); completes the auth flow. */
    verifyMFA,
    /** Register a new account; returns MFA setup data that must be shown once. */
    register,
    /** Revoke the server session and clear all local state. */
    logout,
  };
}
