import React, { useState, useCallback } from 'react';
import { useUpload, type UploadQueueItem, type UploadStatus } from '../../hooks/useUpload';

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function getStatusLabel(status: UploadStatus, progress: number): string {
  switch (status) {
    case 'pending':    return 'Waiting…';
    case 'encrypting': return `Encrypting… ${progress}%`;
    case 'uploading':  return `Uploading… ${progress}%`;
    case 'done':       return 'Done';
    case 'error':      return 'Failed';
    case 'cancelled':  return 'Cancelled';
  }
}

function getStatusColor(status: UploadStatus): string {
  switch (status) {
    case 'done':      return 'bg-[#00FF88]';
    case 'error':     return 'bg-[#EF4444]';
    case 'cancelled': return 'bg-[#71717A]';
    case 'encrypting':return 'bg-[#6366F1]';
    case 'uploading': return 'bg-[#00FF88]';
    default:          return 'bg-[#1F1F23]';
  }
}

/* ------------------------------------------------------------------ */
/* Icons                                                                */
/* ------------------------------------------------------------------ */

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function ErrorXIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={`transition-transform duration-200 ${up ? 'rotate-180' : ''}`}>
      <polyline points="18 15 12 9 6 15"/>
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Per-file row                                                         */
/* ------------------------------------------------------------------ */

interface FileRowProps {
  item: UploadQueueItem;
  index: number;
  onCancel: (index: number) => void;
}

function FileRow({ item, index, onCancel }: FileRowProps) {
  const isActive = item.status === 'encrypting' || item.status === 'uploading';
  const isDone = item.status === 'done';
  const isError = item.status === 'error';
  const isCancelled = item.status === 'cancelled';
  const isTerminal = isDone || isError || isCancelled;

  /* Two-phase label for the progress bar */
  const phaseLabel = item.status === 'encrypting'
    ? 'Encrypting…'
    : item.status === 'uploading'
    ? 'Uploading…'
    : null;

  return (
    <li className="flex flex-col gap-1.5 py-3 px-4 border-b border-[#1F1F23] last:border-b-0 animate-fade-in">
      <div className="flex items-center gap-3 min-w-0">
        {/* Status badge */}
        <div className={[
          'shrink-0 flex items-center justify-center w-7 h-7 rounded-full',
          isDone     ? 'bg-[#00FF88]/15 text-[#00FF88]'  : '',
          isError    ? 'bg-[#EF4444]/15 text-[#EF4444]'  : '',
          isCancelled? 'bg-[#71717A]/15 text-[#71717A]'  : '',
          isActive   ? 'bg-[#6366F1]/15 text-[#6366F1]'  : '',
          item.status === 'pending' ? 'bg-[#1F1F23] text-[#71717A]' : '',
        ].filter(Boolean).join(' ')} aria-hidden="true">
          {isDone     && <CheckIcon />}
          {isError    && <ErrorXIcon />}
          {isCancelled && <CancelIcon />}
          {(isActive || item.status === 'pending') && <LockIcon />}
        </div>

        {/* Name + size */}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-[#FAFAFA] truncate font-medium">{item.file.name}</p>
          <p className="text-xs text-[#71717A]">
            {formatBytes(item.file.size)}
            {isError && item.error && (
              <span className="text-[#EF4444] ml-2">— {item.error}</span>
            )}
          </p>
        </div>

        {/* Cancel button (only for active/pending) */}
        {!isTerminal && (
          <button
            type="button"
            onClick={() => onCancel(index)}
            className={[
              'shrink-0 flex items-center justify-center',
              'w-[44px] h-[44px] rounded-full',
              'text-[#71717A] hover:text-[#EF4444] hover:bg-[#EF4444]/10',
              'transition-colors duration-100',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
            ].join(' ')}
            aria-label={`Cancel upload of ${item.file.name}`}
          >
            <CancelIcon />
          </button>
        )}

        {/* Status text for terminal state */}
        {isTerminal && (
          <span className={[
            'shrink-0 text-xs font-medium',
            isDone     ? 'text-[#00FF88]' : '',
            isError    ? 'text-[#EF4444]' : '',
            isCancelled? 'text-[#71717A]' : '',
          ].filter(Boolean).join(' ')}>
            {isDone ? 'Done' : isError ? 'Failed' : 'Cancelled'}
          </span>
        )}
      </div>

      {/* Progress bar — only when active */}
      {isActive && (
        <div className="ml-10 mr-0">
          {phaseLabel && (
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-[#71717A]">{phaseLabel}</span>
              <span className="text-xs text-[#71717A]">{item.progress}%</span>
            </div>
          )}
          <div
            className="h-1 rounded-full bg-[#1F1F23] overflow-hidden"
            role="progressbar"
            aria-valuenow={item.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Upload progress for ${item.file.name}`}
          >
            <div
              className={`h-full rounded-full transition-all duration-300 ${getStatusColor(item.status)}`}
              style={{ width: `${item.progress}%` }}
            />
          </div>
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* UploadProgress panel                                                 */
/* ------------------------------------------------------------------ */

export function UploadProgress() {
  const { uploadQueue, cancelUpload, clearCompleted } = useUpload();
  const [minimized, setMinimized] = useState(false);

  const hasItems = uploadQueue.length > 0;
  const activeCount = uploadQueue.filter(
    (i) => i.status === 'pending' || i.status === 'encrypting' || i.status === 'uploading'
  ).length;
  const completedCount = uploadQueue.filter(
    (i) => i.status === 'done' || i.status === 'cancelled'
  ).length;
  const errorCount = uploadQueue.filter((i) => i.status === 'error').length;
  const hasCompleted = completedCount > 0 || errorCount > 0;

  const handleClearCompleted = useCallback(() => {
    clearCompleted();
  }, [clearCompleted]);

  if (!hasItems) return null;

  const panelLabel = activeCount > 0
    ? `Uploading ${activeCount} file${activeCount > 1 ? 's' : ''}…`
    : errorCount > 0
    ? `${errorCount} upload${errorCount > 1 ? 's' : ''} failed`
    : `${completedCount} upload${completedCount > 1 ? 's' : ''} complete`;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-[100] pointer-events-none flex justify-end px-4 pb-4"
      aria-label="Upload progress panel"
    >
      <div
        className={[
          'pointer-events-auto w-full max-w-sm',
          'bg-[#141416] border border-[#1F1F23] rounded-card shadow-[0_8px_40px_rgba(0,0,0,0.7)]',
          'transition-all duration-300 ease-out',
          'animate-[panelSlideUp_300ms_ease-out]',
        ].join(' ')}
        role="region"
        aria-label={panelLabel}
        aria-live="polite"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1F1F23]">
          <div className="flex items-center gap-2">
            {/* Spinner for active uploads */}
            {activeCount > 0 && (
              <div
                className="w-4 h-4 rounded-full border-2 border-[#1F1F23] border-t-[#00FF88] animate-spin"
                aria-hidden="true"
              />
            )}
            <span className="text-sm font-semibold text-[#FAFAFA]">{panelLabel}</span>
          </div>

          <div className="flex items-center gap-1">
            {/* Clear completed */}
            {!minimized && hasCompleted && (
              <button
                type="button"
                onClick={handleClearCompleted}
                className={[
                  'text-xs text-[#71717A] hover:text-[#FAFAFA]',
                  'px-2 py-1 rounded transition-colors duration-100',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
                  'min-h-[44px] flex items-center',
                ].join(' ')}
                aria-label="Clear completed uploads"
              >
                Clear
              </button>
            )}

            {/* Minimize/expand toggle */}
            <button
              type="button"
              onClick={() => setMinimized((v) => !v)}
              className={[
                'flex items-center justify-center w-[44px] h-[44px] rounded-full',
                'text-[#71717A] hover:text-[#FAFAFA] hover:bg-white/5',
                'transition-colors duration-100',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
              ].join(' ')}
              aria-expanded={!minimized}
              aria-label={minimized ? 'Expand upload panel' : 'Minimize upload panel'}
            >
              <ChevronIcon up={!minimized} />
            </button>
          </div>
        </div>

        {/* File list */}
        {!minimized && (
          <ul
            className="max-h-72 overflow-y-auto overscroll-contain"
            aria-label="Upload queue"
          >
            {uploadQueue.map((item, index) => (
              <FileRow
                key={item.id}
                item={item}
                index={index}
                onCancel={cancelUpload}
              />
            ))}
          </ul>
        )}
      </div>

      <style>{`
        @keyframes panelSlideUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

export default UploadProgress;
