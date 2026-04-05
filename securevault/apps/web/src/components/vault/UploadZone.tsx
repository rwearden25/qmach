import React, { useCallback, useRef, useState, useEffect } from 'react';
import { useUpload } from '../../hooks/useUpload';
import { useVaultStore } from '../../stores/vaultStore';

/* ------------------------------------------------------------------ */
/* Feature detection                                                    */
/* ------------------------------------------------------------------ */

const supportsDragAndDrop: boolean = (() => {
  if (typeof window === 'undefined') return false;
  const div = document.createElement('div');
  return (
    'draggable' in div ||
    ('ondragstart' in div && 'ondrop' in div)
  );
})();

/* ------------------------------------------------------------------ */
/* Upload icon                                                          */
/* ------------------------------------------------------------------ */

function UploadCloudIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <polyline points="16 16 12 12 8 16"/>
      <line x1="12" y1="12" x2="12" y2="21"/>
      <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Props                                                                */
/* ------------------------------------------------------------------ */

export interface UploadZoneProps {
  /** Accepted MIME types or file extensions (e.g. "image/*,.pdf"). Default: all. */
  accept?: string;
  /** Max file size in bytes. Default: 5 GB. */
  maxSize?: number;
  /** Whether to allow multiple files at once. Default: true. */
  multiple?: boolean;
  /** Compact inline variant (no full-page overlay). Default: false. */
  compact?: boolean;
  className?: string;
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB

function formatMaxSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(0)} GB`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function UploadZone({
  accept,
  maxSize = DEFAULT_MAX_SIZE,
  multiple = true,
  compact = false,
  className = '',
}: UploadZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const dragCounter = useRef(0);

  const [isDragOver, setIsDragOver] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const { addFiles, startUpload } = useUpload();
  const currentFolder = useVaultStore((s) => s.currentFolder);

  /* ---- Validation ---- */
  const validateAndQueue = useCallback((files: FileList | File[]) => {
    const fileArr = Array.from(files);
    const errors: string[] = [];
    const valid: File[] = [];

    for (const file of fileArr) {
      if (file.size > maxSize) {
        errors.push(`"${file.name}" exceeds the maximum size of ${formatMaxSize(maxSize)}.`);
      } else {
        valid.push(file);
      }
    }

    if (errors.length > 0) {
      setValidationErrors(errors);
      setTimeout(() => setValidationErrors([]), 5000);
    }

    if (valid.length > 0) {
      addFiles(valid, currentFolder);
      startUpload();
    }
  }, [addFiles, startUpload, currentFolder, maxSize]);

  /* ---- File input change ---- */
  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      validateAndQueue(files);
    }
    // Reset so the same file can be re-selected
    e.target.value = '';
  }, [validateAndQueue]);

  /* ---- Click to browse ---- */
  const handleBrowseClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /* ---- Drag events (progressive enhancement) ---- */
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (dragCounter.current === 1) setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      validateAndQueue(files);
    }
  }, [validateAndQueue]);

  /* ---- Keyboard support for the zone ---- */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  }, []);

  /* ---- Compact variant ---- */
  if (compact) {
    return (
      <div className={className}>
        <div
          ref={dropZoneRef}
          role="button"
          tabIndex={0}
          aria-label="Upload files. Press Enter to browse or drag files here."
          onClick={handleBrowseClick}
          onKeyDown={handleKeyDown}
          {...(supportsDragAndDrop
            ? {
                onDragEnter: handleDragEnter,
                onDragOver: handleDragOver,
                onDragLeave: handleDragLeave,
                onDrop: handleDrop,
              }
            : {})}
          className={[
            'flex flex-col items-center justify-center gap-3 p-6',
            'rounded-card border-2 border-dashed',
            'transition-all duration-150 cursor-pointer',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88] focus-visible:outline-offset-2',
            'min-h-[120px]',
            isDragOver
              ? 'border-[#00FF88] bg-[#00FF88]/5 scale-[1.01]'
              : 'border-[#1F1F23] hover:border-[#2A2A30] hover:bg-white/[0.01]',
          ].join(' ')}
        >
          <UploadCloudIcon
            className={isDragOver ? 'text-[#00FF88]' : 'text-[#71717A]'}
          />
          <div className="text-center">
            <p className="text-sm text-[#FAFAFA] font-medium">
              {isDragOver ? 'Drop files here' : 'Drop files here or click to browse'}
            </p>
            <p className="text-xs text-[#71717A] mt-1">
              {accept ? `Accepted: ${accept} · ` : ''}Max {formatMaxSize(maxSize)}
            </p>
          </div>
        </div>

        {/* Validation errors */}
        {validationErrors.length > 0 && (
          <ul className="mt-2 space-y-1" aria-live="assertive" aria-label="Upload errors">
            {validationErrors.map((err, i) => (
              <li key={i} className="text-xs text-[#EF4444] bg-[#EF4444]/10 rounded-input px-3 py-2">
                {err}
              </li>
            ))}
          </ul>
        )}

        {/* Hidden file input — primary upload method, works on all platforms */}
        <input
          ref={fileInputRef}
          type="file"
          multiple={multiple}
          accept={accept}
          onChange={handleFileInputChange}
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>
    );
  }

  /* ---- Full-page drag overlay variant ---- */
  return (
    <>
      {/* Hidden file input — always present for non-drag-and-drop environments */}
      <input
        ref={fileInputRef}
        type="file"
        multiple={multiple}
        accept={accept}
        onChange={handleFileInputChange}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        id="vault-file-input"
      />

      {/* Full-page drop overlay — only renders during drag */}
      {supportsDragAndDrop && isDragOver && (
        <div
          className="fixed inset-0 z-[150] flex flex-col items-center justify-center pointer-events-none"
          aria-hidden="true"
        >
          {/* Dark overlay */}
          <div className="absolute inset-0 bg-[#0A0A0B]/80 backdrop-blur-sm" />
          {/* Drop indicator */}
          <div className="relative flex flex-col items-center justify-center gap-4 p-12 rounded-card border-2 border-[#00FF88] bg-[#00FF88]/5 animate-[dropZoneIn_150ms_ease-out]">
            <UploadCloudIcon className="text-[#00FF88]" />
            <div className="text-center">
              <p className="text-xl font-semibold text-[#FAFAFA]">Drop files to upload</p>
              <p className="text-sm text-[#71717A] mt-1">
                Files will be encrypted automatically
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Invisible full-page drag target */}
      {supportsDragAndDrop && (
        <div
          className="fixed inset-0 z-[140] pointer-events-none"
          aria-hidden="true"
          ref={dropZoneRef}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{ pointerEvents: isDragOver ? 'all' : 'none' }}
        />
      )}

      {/* Validation error toast */}
      {validationErrors.length > 0 && (
        <div
          className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[160] max-w-sm w-full px-4"
          aria-live="assertive"
        >
          {validationErrors.map((err, i) => (
            <div
              key={i}
              className="text-sm text-[#EF4444] bg-[#141416] border border-[#EF4444]/30 rounded-card px-4 py-3 shadow-card mb-2 animate-slide-up"
            >
              {err}
            </div>
          ))}
        </div>
      )}

      <style>{`
        @keyframes dropZoneIn {
          from { opacity: 0; transform: scale(0.96); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </>
  );
}

export default UploadZone;
