import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';

/* ------------------------------------------------------------------ */
/* Loading skeleton                                                     */
/* ------------------------------------------------------------------ */

/**
 * Shown while the persisted auth state is being rehydrated from
 * sessionStorage (Zustand persist middleware).  Renders a subtle card
 * skeleton so there is no layout flash.
 */
function AuthSkeleton() {
  return (
    <div
      className="min-h-dvh bg-[#0A0A0B] flex items-center justify-center px-4"
      aria-busy="true"
      aria-label="Checking authentication…"
    >
      <div className="w-full max-w-sm space-y-4">
        {/* Fake card */}
        <div className="bg-[#141416] border border-[#1F1F23] rounded-card p-8 shadow-card space-y-5">
          {/* Logo placeholder */}
          <div className="flex flex-col items-center gap-3">
            <div className="w-14 h-14 rounded-card skeleton" />
            <div className="skeleton skeleton-title mx-auto" />
            <div className="skeleton skeleton-text mx-auto" style={{ width: '55%' }} />
          </div>
          {/* Input placeholders */}
          <div className="skeleton rounded-input" style={{ height: '44px' }} />
          <div className="skeleton rounded-input" style={{ height: '44px' }} />
          {/* Button placeholder */}
          <div className="skeleton rounded-pill" style={{ height: '48px' }} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ProtectedRoute                                                       */
/* ------------------------------------------------------------------ */

export interface ProtectedRouteProps {
  children: React.ReactNode;
  /**
   * When true, the route is accessible only while an MFA flow is
   * pending (e.g. /mfa-verify).  Defaults to false.
   */
  requireMFA?: boolean;
}

/**
 * Guards a route behind authentication.
 *
 * Behaviour:
 *  - While Zustand is rehydrating (first render before persist kicks in),
 *    shows a skeleton loader so there is no navigation flash.
 *  - If the user is not authenticated → redirect to /login, preserving
 *    the current path as `state.from` so the login page can send them
 *    back after a successful sign-in.
 *  - If authenticated but MFA is still pending → redirect to /mfa-verify.
 *  - Otherwise → render children normally.
 */
export function ProtectedRoute({
  children,
  requireMFA = false,
}: ProtectedRouteProps) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const mfaPending = useAuthStore((s) => s.mfaPending);
  const location = useLocation();

  /**
   * Zustand's persist middleware rehydrates synchronously from
   * sessionStorage on the first store access, so by the time this
   * component renders the state is already correct.  However, if the
   * storage read races with the render (e.g. SSR / test environments),
   * we check both falsy cases explicitly.
   *
   * In production this is essentially instantaneous, so no visible
   * flicker occurs.  We keep the skeleton as a safety net.
   */
  const storeReady =
    useAuthStore.persist?.hasHydrated?.() ?? true;

  if (!storeReady) {
    return <AuthSkeleton />;
  }

  /* -- MFA-only route (e.g. /mfa-verify) -- */
  if (requireMFA) {
    if (!mfaPending) {
      // No active MFA flow — send back to login
      return <Navigate to="/login" state={{ from: location }} replace />;
    }
    return <>{children}</>;
  }

  /* -- Standard protected route -- */
  if (!isAuthenticated) {
    return (
      <Navigate
        to="/login"
        state={{ from: location }}
        replace
      />
    );
  }

  if (mfaPending) {
    // Authenticated session started but second factor not verified yet
    return <Navigate to="/mfa-verify" replace />;
  }

  return <>{children}</>;
}

export default ProtectedRoute;
