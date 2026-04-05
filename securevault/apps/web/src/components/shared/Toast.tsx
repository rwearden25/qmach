import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  /** Auto-dismiss duration in ms. Defaults to 5000. Pass 0 to disable. */
  duration?: number;
}

interface ToastContextValue {
  addToast: (toast: Omit<Toast, 'id'>) => string;
  removeToast: (id: string) => void;
}

/* ------------------------------------------------------------------ */
/* Context                                                              */
/* ------------------------------------------------------------------ */

const ToastContext = createContext<ToastContextValue | null>(null);

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function generateId(): string {
  return `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const TYPE_CONFIG: Record<
  ToastType,
  { bg: string; border: string; icon: React.ReactNode; iconColor: string; label: string }
> = {
  success: {
    bg: 'bg-[#141416]',
    border: 'border-[#00FF88]/40',
    iconColor: 'text-[#00FF88]',
    label: 'Success',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
  },
  error: {
    bg: 'bg-[#141416]',
    border: 'border-[#EF4444]/40',
    iconColor: 'text-[#EF4444]',
    label: 'Error',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
  },
  warning: {
    bg: 'bg-[#141416]',
    border: 'border-[#F59E0B]/40',
    iconColor: 'text-[#F59E0B]',
    label: 'Warning',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
  },
  info: {
    bg: 'bg-[#141416]',
    border: 'border-[#6366F1]/40',
    iconColor: 'text-[#6366F1]',
    label: 'Info',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    ),
  },
};

/* ------------------------------------------------------------------ */
/* Individual Toast item                                                */
/* ------------------------------------------------------------------ */

interface ToastItemProps {
  toast: Toast;
  onRemove: (id: string) => void;
}

function ToastItem({ toast, onRemove }: ToastItemProps) {
  const [visible, setVisible] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const config = TYPE_CONFIG[toast.type];
  const duration = toast.duration ?? 5000;

  const dismiss = useCallback(() => {
    setLeaving(true);
    setTimeout(() => onRemove(toast.id), 300);
  }, [toast.id, onRemove]);

  useEffect(() => {
    // Mount → trigger slide-in
    requestAnimationFrame(() => setVisible(true));

    if (duration > 0) {
      timerRef.current = setTimeout(dismiss, duration);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [dismiss, duration]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-label={`${config.label}: ${toast.title}`}
      className={[
        'flex items-start gap-3 w-full max-w-sm',
        'rounded-xl border px-4 py-3.5 shadow-xl',
        config.bg,
        config.border,
        'transition-all duration-300 ease-out',
        visible && !leaving
          ? 'translate-x-0 opacity-100'
          : leaving
          ? 'translate-x-8 opacity-0'
          : 'translate-x-8 opacity-0',
      ].join(' ')}
    >
      {/* Icon */}
      <span className={`shrink-0 mt-0.5 ${config.iconColor}`}>
        {config.icon}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[#FAFAFA] leading-tight">
          {toast.title}
        </p>
        {toast.message && (
          <p className="mt-0.5 text-xs text-[#71717A] leading-snug">
            {toast.message}
          </p>
        )}
      </div>

      {/* Close button */}
      <button
        onClick={dismiss}
        className="shrink-0 p-1 -mr-1 text-[#71717A] hover:text-[#FAFAFA] transition-colors rounded-md
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary min-w-[32px] min-h-[32px] flex items-center justify-center"
        aria-label="Dismiss notification"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toast Container                                                      */
/* ------------------------------------------------------------------ */

const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((toast: Omit<Toast, 'id'>): string => {
    const id = generateId();
    setToasts((prev) => {
      const next = [...prev, { ...toast, id }];
      // Keep only the last MAX_VISIBLE + a small buffer
      return next.slice(-MAX_VISIBLE);
    });
    return id;
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}

      {/* Portal-like fixed container */}
      <div
        aria-label="Notifications"
        className={[
          'fixed z-[9999] flex flex-col gap-2 pointer-events-none',
          // Mobile: bottom-center
          'bottom-4 left-1/2 -translate-x-1/2 items-center w-[calc(100vw-2rem)]',
          // Desktop: bottom-right
          'tablet:left-auto tablet:right-4 tablet:translate-x-0 tablet:items-end tablet:w-auto',
        ].join(' ')}
      >
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto w-full tablet:w-auto">
            <ToastItem toast={toast} onRemove={removeToast} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Hook                                                                 */
/* ------------------------------------------------------------------ */

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }

  const { addToast, removeToast } = ctx;

  return {
    toast: addToast,
    dismiss: removeToast,
    success: (title: string, message?: string, duration?: number) =>
      addToast({ type: 'success', title, message, duration }),
    error: (title: string, message?: string, duration?: number) =>
      addToast({ type: 'error', title, message, duration }),
    warning: (title: string, message?: string, duration?: number) =>
      addToast({ type: 'warning', title, message, duration }),
    info: (title: string, message?: string, duration?: number) =>
      addToast({ type: 'info', title, message, duration }),
  };
}

export default ToastProvider;
