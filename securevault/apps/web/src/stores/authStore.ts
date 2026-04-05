import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { apiClient } from '../lib/api';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

interface LoginResponse {
  user: AuthUser;
  accessToken: string;
  mfaRequired: boolean;
  mfaToken?: string;   // short-lived token passed to the MFA step
}

interface MFAVerifyResponse {
  user: AuthUser;
  accessToken: string;
}

interface RefreshResponse {
  accessToken: string;
}

/* ------------------------------------------------------------------ */
/* Store shape                                                          */
/* ------------------------------------------------------------------ */

export interface AuthState {
  /* ---- state ---- */
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  /** True when server responded with mfaRequired=true but user hasn't
   *  completed the second factor yet.                                  */
  mfaRequired: boolean;
  /** True while the user is in the middle of the MFA flow
   *  (has a pending mfaToken from the login response).               */
  mfaPending: boolean;
  /** Opaque short-lived token exchanged at the /mfa-verify step.     */
  mfaToken: string | null;

  /* ---- actions ---- */
  login(email: string, password: string): Promise<void>;
  verifyMFA(code: string): Promise<void>;
  logout(): Promise<void>;
  refreshToken(): Promise<string | null>;
  setUser(user: AuthUser): void;
}

/* ------------------------------------------------------------------ */
/* Store implementation                                                 */
/* ------------------------------------------------------------------ */

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      /* ----- initial state ----- */
      user: null,
      accessToken: null,
      isAuthenticated: false,
      mfaRequired: false,
      mfaPending: false,
      mfaToken: null,

      /* ----- actions ----- */

      async login(email: string, password: string): Promise<void> {
        const data = await apiClient.post<LoginResponse>('/auth/login', {
          email,
          password,
        });

        if (data.mfaRequired) {
          // Partial login — MFA needed before granting full access
          set({
            user: null,
            accessToken: null,
            isAuthenticated: false,
            mfaRequired: true,
            mfaPending: true,
            mfaToken: data.mfaToken ?? null,
          });
          return;
        }

        set({
          user: data.user,
          accessToken: data.accessToken,
          isAuthenticated: true,
          mfaRequired: false,
          mfaPending: false,
          mfaToken: null,
        });
      },

      async verifyMFA(code: string): Promise<void> {
        const { mfaToken } = get();

        if (!mfaToken) {
          throw new Error('No active MFA flow. Please log in again.');
        }

        const data = await apiClient.post<MFAVerifyResponse>('/auth/mfa/verify', {
          code,
          mfaToken,
        });

        set({
          user: data.user,
          accessToken: data.accessToken,
          isAuthenticated: true,
          mfaRequired: false,
          mfaPending: false,
          mfaToken: null,
        });
      },

      async logout(): Promise<void> {
        try {
          // Best-effort server-side logout (revoke refresh token)
          await apiClient.post('/auth/logout', {});
        } catch {
          // Ignore — local state will be cleared regardless
        } finally {
          set({
            user: null,
            accessToken: null,
            isAuthenticated: false,
            mfaRequired: false,
            mfaPending: false,
            mfaToken: null,
          });
        }
      },

      async refreshToken(): Promise<string | null> {
        try {
          const data = await apiClient.post<RefreshResponse>(
            '/auth/refresh',
            {},
            { skipAuthRefresh: true },   // prevent infinite loop
          );
          set({ accessToken: data.accessToken });
          return data.accessToken;
        } catch {
          // Refresh failed — force the user to log in again
          set({
            user: null,
            accessToken: null,
            isAuthenticated: false,
            mfaRequired: false,
            mfaPending: false,
            mfaToken: null,
          });
          return null;
        }
      },

      setUser(user: AuthUser): void {
        set({ user });
      },
    }),

    {
      name: 'sv-auth',
      storage: createJSONStorage(() => sessionStorage),
      // Only persist identity; do NOT persist the access token in localStorage
      partialize: (state) => ({
        user:            state.user,
        isAuthenticated: state.isAuthenticated,
        mfaRequired:     state.mfaRequired,
        mfaPending:      state.mfaPending,
        mfaToken:        state.mfaToken,
        // accessToken is intentionally excluded — held only in memory
      }),
    },
  ),
);
