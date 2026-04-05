import React, { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type ModalSize = 'sm' | 'md' | 'lg';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  size?: ModalSize;
  /** Prevent closing by clicking the backdrop or pressing Escape */
  persistent?: boolean;
  children: React.ReactNode;
}

/* ------------------------------------------------------------------ */
/* Size map                                                             */
/* ------------------------------------------------------------------ */

const sizeClasses: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
};

/* ------------------------------------------------------------------ */
/* Close icon                                                           */
/* ------------------------------------------------------------------ */

function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

export function Modal({
  open,
  onClose,
  title,
  size = 'md',
  persistent = false,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  /* -- Escape key handler -- */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !persistent) {
        onClose();
      }
      // Trap focus inside the modal
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      }
    },
    [onClose, persistent],
  );

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement;
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
      // Move focus into the modal after mount
      requestAnimationFrame(() => {
        const firstFocusable = dialogRef.current?.querySelector<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
        );
        firstFocusable?.focus();
      });
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      if (!open && previousFocusRef.current instanceof HTMLElement) {
        previousFocusRef.current.focus();
      }
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return createPortal(
    /* Overlay — uses backdrop-blur with a solid fallback */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
    >
      {/* Backdrop */}
      <div
        className={[
          'absolute inset-0',
          // Solid dark fallback first, then blur on top if supported
          'bg-black/70',
          'supports-[backdrop-filter]:bg-black/50 supports-[backdrop-filter]:backdrop-blur-sm',
          // Animate in
          'animate-fade-in',
        ].join(' ')}
        aria-hidden="true"
        onClick={persistent ? undefined : onClose}
      />

      {/* Dialog panel */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'modal-title' : undefined}
        className={[
          'relative z-10 w-full',
          sizeClasses[size],
          // Surface
          'bg-[#141416] border border-[#1F1F23]',
          'rounded-card shadow-card',
          // Entrance animation: fade + scale
          'animate-[modalIn_200ms_ease-out_forwards]',
        ].join(' ')}
        style={
          {
            '--tw-shadow': '0 25px 50px -12px rgba(0,0,0,0.8)',
          } as React.CSSProperties
        }
      >
        {/* Header */}
        {(title || !persistent) && (
          <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#1F1F23]">
            {title && (
              <h2
                id="modal-title"
                className="text-lg font-heading font-semibold text-[#FAFAFA] leading-tight"
              >
                {title}
              </h2>
            )}
            {!persistent && (
              <button
                type="button"
                onClick={onClose}
                className={[
                  'ml-auto flex items-center justify-center',
                  'w-11 h-11 rounded-full',
                  'text-[#71717A] hover:text-[#FAFAFA] hover:bg-white/5',
                  'transition-colors duration-150',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary',
                ].join(' ')}
                aria-label="Close dialog"
              >
                <CloseIcon />
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-5">{children}</div>
      </div>

      {/* Keyframe injected via style tag so we don't need a Tailwind plugin */}
      <style>{`
        @keyframes modalIn {
          from { opacity: 0; transform: scale(0.95) translateY(8px); }
          to   { opacity: 1; transform: scale(1)    translateY(0);   }
        }
      `}</style>
    </div>,
    document.body,
  );
}

export default Modal;
