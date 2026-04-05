import React, { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface ContextMenuAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  variant?: 'default' | 'danger';
  disabled?: boolean;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onAction: (actionId: string) => void;
  actions?: ContextMenuAction[];
}

/* ------------------------------------------------------------------ */
/* Default action set (consumers can override via props)               */
/* ------------------------------------------------------------------ */

export const DEFAULT_FILE_ACTIONS: ContextMenuAction[] = [
  {
    id: 'download',
    label: 'Download',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    ),
  },
  {
    id: 'share',
    label: 'Share',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="18" cy="5" r="3"/>
        <circle cx="6" cy="12" r="3"/>
        <circle cx="18" cy="19" r="3"/>
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
      </svg>
    ),
  },
  {
    id: 'rename',
    label: 'Rename',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
      </svg>
    ),
  },
  {
    id: 'move',
    label: 'Move to Folder',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        <polyline points="8 13 12 17 16 13"/>
        <line x1="12" y1="17" x2="12" y2="9"/>
      </svg>
    ),
  },
  {
    id: 'versions',
    label: 'Version History',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="1 4 1 10 7 10"/>
        <path d="M3.51 15a9 9 0 1 0 .49-4.95"/>
      </svg>
    ),
  },
  {
    id: 'delete',
    label: 'Delete',
    variant: 'danger' as const,
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6"/>
        <path d="M14 11v6"/>
        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
      </svg>
    ),
  },
];

/* ------------------------------------------------------------------ */
/* Separator marker                                                     */
/* ------------------------------------------------------------------ */

const SEPARATOR_BEFORE = new Set(['delete']);

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

export function ContextMenu({
  x,
  y,
  onClose,
  onAction,
  actions = DEFAULT_FILE_ACTIONS,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = React.useState<number>(0);
  const [position, setPosition] = React.useState({ x, y });

  /* ---- Adjust position to stay inside viewport ---- */
  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let adjX = x;
    let adjY = y;

    if (x + rect.width > vw - 8) {
      adjX = vw - rect.width - 8;
    }
    if (y + rect.height > vh - 8) {
      adjY = vh - rect.height - 8;
    }
    if (adjX < 8) adjX = 8;
    if (adjY < 8) adjY = 8;

    setPosition({ x: adjX, y: adjY });
  }, [x, y]);

  /* ---- Click-outside / scroll to close ---- */
  useEffect(() => {
    const handleOutside = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleScroll = () => onClose();

    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside, { passive: true });
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [onClose]);

  /* ---- Keyboard navigation ---- */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const enabledActions = actions.filter((a) => !a.disabled);
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex((prev) => (prev + 1) % enabledActions.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex((prev) =>
            prev === 0 ? enabledActions.length - 1 : prev - 1,
          );
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (enabledActions[focusedIndex]) {
            onAction(enabledActions[focusedIndex].id);
            onClose();
          }
          break;
        case 'Tab':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [actions, focusedIndex, onAction, onClose],
  );

  /* ---- Focus management ---- */
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const buttons = menu.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
    buttons[focusedIndex]?.focus();
  }, [focusedIndex]);

  /* ---- Initial focus on mount ---- */
  useEffect(() => {
    requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (!menu) return;
      const firstBtn = menu.querySelector<HTMLButtonElement>('button:not([disabled])');
      firstBtn?.focus();
    });
  }, []);

  const enabledActions = actions.filter((a) => !a.disabled);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="File actions"
      onKeyDown={handleKeyDown}
      className="fixed z-[200] min-w-[200px] py-1.5 bg-[#141416] border border-[#1F1F23] rounded-card shadow-[0_8px_32px_rgba(0,0,0,0.6)] animate-[contextMenuIn_120ms_ease-out]"
      style={{ left: position.x, top: position.y }}
    >
      {actions.map((action, idx) => {
        const enabledIdx = enabledActions.indexOf(action);
        const isFocused = enabledIdx === focusedIndex && !action.disabled;

        return (
          <React.Fragment key={action.id}>
            {SEPARATOR_BEFORE.has(action.id) && (
              <div
                className="my-1 h-px bg-[#1F1F23]"
                role="separator"
                aria-hidden="true"
              />
            )}
            <button
              role="menuitem"
              disabled={action.disabled}
              tabIndex={isFocused ? 0 : -1}
              onClick={() => {
                if (!action.disabled) {
                  onAction(action.id);
                  onClose();
                }
              }}
              onMouseEnter={() => {
                if (!action.disabled) setFocusedIndex(enabledIdx);
              }}
              className={[
                'w-full flex items-center gap-3 px-4 py-2.5',
                'text-sm font-medium text-left',
                'transition-colors duration-100',
                'min-h-[44px]',
                action.disabled
                  ? 'text-[#71717A] cursor-not-allowed opacity-50'
                  : action.variant === 'danger'
                  ? 'text-[#EF4444] hover:bg-[#EF4444]/10 focus-visible:bg-[#EF4444]/10'
                  : 'text-[#FAFAFA] hover:bg-white/5 focus-visible:bg-white/5',
                'focus-visible:outline-none focus-visible:ring-0',
                isFocused && !action.disabled
                  ? action.variant === 'danger'
                    ? 'bg-[#EF4444]/10'
                    : 'bg-white/5'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span
                className={
                  action.variant === 'danger'
                    ? 'text-[#EF4444]'
                    : 'text-[#71717A]'
                }
              >
                {action.icon}
              </span>
              {action.label}
            </button>
          </React.Fragment>
        );
      })}

      <style>{`
        @keyframes contextMenuIn {
          from { opacity: 0; transform: scale(0.95) translateY(-4px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>,
    document.body,
  );
}

export default ContextMenu;
