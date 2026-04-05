import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';

/* ------------------------------------------------------------------ */
/* Lazy-loaded page components                                          */
/* ------------------------------------------------------------------ */
const LandingPage     = lazy(() => import('./pages/LandingPage'));
const LoginPage       = lazy(() => import('./pages/LoginPage'));
const RegisterPage    = lazy(() => import('./pages/RegisterPage'));
const MFAVerifyPage   = lazy(() => import('./pages/MFAVerifyPage'));
const VaultDashboard  = lazy(() => import('./pages/VaultDashboard'));
const FilePreview     = lazy(() => import('./pages/FilePreview'));
const SettingsPage    = lazy(() => import('./pages/SettingsPage'));

/* ------------------------------------------------------------------ */
/* Route guards                                                         */
/* ------------------------------------------------------------------ */

/** Renders children only when the user is authenticated.
 *  If not, redirects to /login, preserving the intended destination. */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

/** Renders children only when MFA verification is pending.
 *  Redirects to /login if the user arrives here without a pending flow. */
function MFARoute({ children }: { children: React.ReactNode }) {
  const mfaPending = useAuthStore((s) => s.mfaPending);
  const location = useLocation();

  if (!mfaPending) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

/* ------------------------------------------------------------------ */
/* Full-page loading fallback                                            */
/* ------------------------------------------------------------------ */
function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-dvh bg-background">
      <div className="flex flex-col items-center gap-4">
        <div
          className="w-10 h-10 rounded-full border-2 border-border border-t-primary animate-spin"
          role="status"
          aria-label="Loading page"
        />
        <span className="text-text-secondary text-sm">Loading…</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                  */
/* ------------------------------------------------------------------ */
export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Public routes */}
        <Route path="/"          element={<LandingPage />} />
        <Route path="/login"     element={<LoginPage />} />
        <Route path="/register"  element={<RegisterPage />} />

        {/* MFA step — requires an active MFA flow */}
        <Route
          path="/mfa-verify"
          element={
            <MFARoute>
              <MFAVerifyPage />
            </MFARoute>
          }
        />

        {/* Protected routes — require authentication */}
        <Route
          path="/vault"
          element={
            <ProtectedRoute>
              <VaultDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/vault/:fileId"
          element={
            <ProtectedRoute>
              <FilePreview />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
