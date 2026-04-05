import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/shared/Button';
import { ShareModal } from '../components/vault/ShareModal';
import { Modal } from '../components/shared/Modal';
import { SkeletonLine } from '../components/shared/SkeletonLoader';
import { useToast } from '../components/shared/Toast';
import { useEncryption } from '../hooks/useEncryption';
import { useVaultStore } from '../stores/vaultStore';
import { apiClient } from '../lib/api';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

interface FileVersion {
  versionNumber: number;
  size: number;
  createdAt: string;
  isCurrent: boolean;
}

interface FileDetailResponse {
  id: string;
  encryptedBlob: string; // URL to download
  wrappedFileKey: string;
  encryptedName: string;
  encryptedMimeType: string;
  ivs: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  versionNumber: number;
  versions?: FileVersion[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function getMimeCategory(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('text/') || mimeType.includes('javascript') ||
      mimeType.includes('json') || mimeType.includes('xml')) return 'text';
  return 'other';
}

/* ------------------------------------------------------------------ */
/* Icons                                                                */
/* ------------------------------------------------------------------ */

function ArrowLeftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="19" y1="12" x2="5" y2="12"/>
      <polyline points="12 19 5 12 12 5"/>
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
      <path d="M10 11v6"/><path d="M14 11v6"/>
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10"/>
      <path d="M3.51 15a9 9 0 1 0 .49-4.95"/>
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none"
      stroke="#71717A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
      <polyline points="13 2 13 9 20 9"/>
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Preview renderers                                                    */
/* ------------------------------------------------------------------ */

function ImagePreview({ blobUrl, filename }: { blobUrl: string; filename: string }) {
  return (
    <div className="flex items-center justify-center w-full h-full p-4">
      <img
        src={blobUrl}
        alt={filename}
        className="max-w-full max-h-full object-contain rounded-card shadow-[0_8px_40px_rgba(0,0,0,0.6)]"
        draggable={false}
      />
    </div>
  );
}

function VideoPreview({ blobUrl, filename }: { blobUrl: string; filename: string }) {
  return (
    <div className="flex items-center justify-center w-full h-full p-4">
      <video
        src={blobUrl}
        controls
        className="max-w-full max-h-full rounded-card shadow-[0_8px_40px_rgba(0,0,0,0.6)]"
        aria-label={`Video: ${filename}`}
      />
    </div>
  );
}

function AudioPreview({ blobUrl, filename }: { blobUrl: string; filename: string }) {
  return (
    <div className="flex flex-col items-center justify-center w-full h-full gap-6 p-4">
      <div className="w-32 h-32 rounded-full bg-[#141416] border border-[#1F1F23] flex items-center justify-center">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none"
          stroke="#F59E0B" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
        </svg>
      </div>
      <p className="text-sm text-[#FAFAFA] font-medium truncate max-w-xs text-center">{filename}</p>
      <audio src={blobUrl} controls className="w-full max-w-md" aria-label={`Audio: ${filename}`} />
    </div>
  );
}

function PdfPreview({ blobUrl }: { blobUrl: string }) {
  return (
    <iframe
      src={blobUrl}
      title="PDF preview"
      className="w-full h-full border-0"
      aria-label="PDF document preview"
    />
  );
}

function TextPreview({ blobUrl }: { blobUrl: string }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    fetch(blobUrl)
      .then((r) => r.text())
      .then(setText)
      .catch(() => setText('Could not load text content.'));
  }, [blobUrl]);

  return (
    <div className="w-full h-full overflow-auto p-4">
      <pre className="text-sm text-[#FAFAFA] font-mono whitespace-pre-wrap break-words leading-relaxed bg-[#141416] rounded-card p-4 border border-[#1F1F23] min-h-full">
        {text ?? 'Loading…'}
      </pre>
    </div>
  );
}

function UnsupportedPreview({ mimeType, onDownload }: { mimeType: string; onDownload: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center w-full h-full gap-6 p-4 text-center">
      <FileIcon />
      <div>
        <p className="text-lg font-heading font-semibold text-[#FAFAFA] mb-2">Preview not available</p>
        <p className="text-sm text-[#71717A]">{mimeType || 'Unknown file type'}</p>
      </div>
      <Button variant="primary" size="md" onClick={onDownload}>
        <DownloadIcon />
        Download to view
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Version history panel content                                        */
/* ------------------------------------------------------------------ */

function VersionList({
  versions,
  currentVersion,
}: {
  versions: FileVersion[];
  currentVersion: number;
}) {
  return (
    <ul className="space-y-2">
      {versions.map((v) => (
        <li
          key={v.versionNumber}
          className={[
            'flex items-center justify-between gap-3 p-3 rounded-input border transition-colors',
            v.isCurrent
              ? 'border-[#00FF88]/30 bg-[#00FF88]/5'
              : 'border-[#1F1F23] bg-[#141416]',
          ].join(' ')}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[#FAFAFA]">v{v.versionNumber}</span>
              {v.isCurrent && (
                <span className="text-[10px] font-semibold text-[#0A0A0B] bg-[#00FF88] px-1.5 py-0.5 rounded-full">
                  Current
                </span>
              )}
            </div>
            <p className="text-xs text-[#71717A] mt-0.5">{formatDate(v.createdAt)}</p>
          </div>
          <span className="text-xs text-[#71717A] shrink-0">{formatBytes(v.size)}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Page component                                                       */
/* ------------------------------------------------------------------ */

export default function FilePreview() {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();
  const { decryptDownload, isProcessing, error: encryptionError } = useEncryption();
  const { deleteFile } = useVaultStore();

  const [fileDetail, setFileDetail] = useState<FileDetailResponse | null>(null);
  const [decryptedBlobUrl, setDecryptedBlobUrl] = useState<string | null>(null);
  const [decryptedFilename, setDecryptedFilename] = useState('');
  const [decryptedMime, setDecryptedMime] = useState('');
  const [isLoadingDetail, setIsLoadingDetail] = useState(true);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  const blobUrlRef = useRef<string | null>(null);

  /* ---- Revoke blob URL on unmount ---- */
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  /* ---- Fetch file metadata + encrypted blob, then decrypt ---- */
  useEffect(() => {
    if (!fileId) return;

    let cancelled = false;

    async function loadAndDecrypt() {
      setIsLoadingDetail(true);
      setDecryptError(null);

      try {
        const detail = await apiClient.get<FileDetailResponse>(`/vault/files/${fileId}`);
        if (cancelled) return;
        setFileDetail(detail);

        // Download the encrypted blob
        setIsDecrypting(true);
        const blobRes = await fetch(detail.encryptedBlob, { credentials: 'include' });
        if (!blobRes.ok) throw new Error('Failed to download encrypted file');
        const encBlob = await blobRes.blob();
        if (cancelled) return;

        // Decrypt
        const { blob, filename, mimeType } = await decryptDownload(
          encBlob,
          detail.wrappedFileKey,
          detail.encryptedName,
          detail.encryptedMimeType,
          detail.ivs,
        );

        if (cancelled) return;

        // Revoke previous URL if any
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;

        setDecryptedBlobUrl(url);
        setDecryptedFilename(filename);
        setDecryptedMime(mimeType);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Failed to decrypt file';
          setDecryptError(msg);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingDetail(false);
          setIsDecrypting(false);
        }
      }
    }

    loadAndDecrypt();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId]);

  /* ---- Download ---- */
  const handleDownload = useCallback(() => {
    if (!decryptedBlobUrl || !decryptedFilename) return;
    const a = document.createElement('a');
    a.href = decryptedBlobUrl;
    a.download = decryptedFilename;
    a.click();
  }, [decryptedBlobUrl, decryptedFilename]);

  /* ---- Delete ---- */
  const handleDelete = useCallback(async () => {
    if (!fileId) return;
    try {
      await deleteFile(fileId);
      success('File deleted');
      navigate('/vault', { replace: true });
    } catch {
      toastError('Failed to delete file');
    }
  }, [fileId, deleteFile, navigate, success, toastError]);

  const isLoading = isLoadingDetail || isDecrypting || isProcessing;
  const mimeCategory = getMimeCategory(decryptedMime);

  return (
    <div className="min-h-dvh bg-[#0A0A0B] flex flex-col">

      {/* ---- Header ---- */}
      <header className="sticky top-0 z-30 bg-[#0A0A0B]/95 backdrop-blur-sm border-b border-[#1F1F23]">
        <div className="max-w-screen-xl mx-auto px-4 h-16 flex items-center gap-3">

          {/* Back */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/vault')}
            aria-label="Back to vault"
            className="gap-1.5 shrink-0"
          >
            <ArrowLeftIcon />
            <span className="hidden sm:inline">Back</span>
          </Button>

          <div className="flex-1 min-w-0 mx-2">
            {isLoading ? (
              <SkeletonLine width="w-48" height="h-5" />
            ) : (
              <h1 className="text-base font-heading font-semibold text-[#FAFAFA] truncate">
                {decryptedFilename || 'Untitled'}
              </h1>
            )}
            {fileDetail && !isLoading && (
              <div className="flex items-center gap-3 text-xs text-[#71717A] mt-0.5">
                <span>{formatBytes(fileDetail.size)}</span>
                <span aria-hidden="true">·</span>
                <span>{decryptedMime || 'Unknown type'}</span>
                <span aria-hidden="true">·</span>
                <span>Uploaded {formatDate(fileDetail.createdAt)}</span>
                <span aria-hidden="true">·</span>
                <span className="flex items-center gap-1">
                  <HistoryIcon />
                  v{fileDetail.versionNumber}
                </span>
              </div>
            )}
          </div>

          {/* Action bar */}
          <div className="flex items-center gap-2 shrink-0">
            {fileDetail && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                  disabled={!decryptedBlobUrl}
                  aria-label="Download file"
                >
                  <DownloadIcon />
                  <span className="hidden sm:inline">Download</span>
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShareOpen(true)}
                  aria-label="Share file"
                >
                  <ShareIcon />
                  <span className="hidden sm:inline">Share</span>
                </Button>
                {fileDetail.versions && fileDetail.versions.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setVersionsOpen(true)}
                    className="hidden md:flex"
                    aria-label="Version history"
                  >
                    <HistoryIcon />
                    <span className="hidden sm:inline">History</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteConfirmOpen(true)}
                  className="text-[#EF4444] hover:text-[#EF4444] hover:bg-[#EF4444]/10"
                  aria-label="Delete file"
                >
                  <TrashIcon />
                  <span className="sr-only">Delete</span>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ---- E2E note strip ---- */}
      <div className="bg-[#6366F1]/10 border-b border-[#6366F1]/20 px-4 py-2 flex items-center justify-center gap-2">
        <span className="text-[#6366F1]"><LockIcon /></span>
        <p className="text-xs text-[#71717A]">
          <span className="text-[#FAFAFA] font-medium">End-to-end encrypted.</span>{' '}
          Decrypted in your browser only. Never cached to disk.
        </p>
      </div>

      {/* ---- Main: preview + optional sidebar ---- */}
      <main className="flex-1 flex overflow-hidden">

        {/* Preview area */}
        <div className="flex-1 overflow-auto relative">
          {/* Loading skeleton */}
          {isLoading && (
            <div className="flex flex-col items-center justify-center w-full h-full gap-6 p-8"
              role="status" aria-label="Decrypting file">
              <div className="w-24 h-24 rounded-full bg-[#141416] border border-[#1F1F23] flex items-center justify-center animate-pulse">
                <span className="text-[#6366F1]">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                </span>
              </div>
              <div className="text-center space-y-2">
                <SkeletonLine width="w-48" height="h-5" className="mx-auto" />
                <p className="text-sm text-[#71717A]">
                  {isDecrypting ? 'Decrypting file…' : 'Loading…'}
                </p>
              </div>
              <span className="sr-only">Decrypting file, please wait</span>
            </div>
          )}

          {/* Error state */}
          {!isLoading && (decryptError || encryptionError) && (
            <div className="flex flex-col items-center justify-center w-full h-full gap-4 p-8 text-center">
              <div className="w-16 h-16 rounded-full bg-[#EF4444]/10 border border-[#EF4444]/20 flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                  stroke="#EF4444" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </div>
              <div>
                <p className="text-base font-semibold text-[#FAFAFA] mb-1">Decryption failed</p>
                <p className="text-sm text-[#71717A]">{decryptError || encryptionError}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => navigate('/vault')}>
                Back to vault
              </Button>
            </div>
          )}

          {/* Actual preview */}
          {!isLoading && decryptedBlobUrl && !decryptError && (
            <div className="w-full h-full min-h-[400px]">
              {mimeCategory === 'image' && (
                <ImagePreview blobUrl={decryptedBlobUrl} filename={decryptedFilename} />
              )}
              {mimeCategory === 'video' && (
                <VideoPreview blobUrl={decryptedBlobUrl} filename={decryptedFilename} />
              )}
              {mimeCategory === 'audio' && (
                <AudioPreview blobUrl={decryptedBlobUrl} filename={decryptedFilename} />
              )}
              {mimeCategory === 'pdf' && (
                <PdfPreview blobUrl={decryptedBlobUrl} />
              )}
              {mimeCategory === 'text' && (
                <TextPreview blobUrl={decryptedBlobUrl} />
              )}
              {mimeCategory === 'other' && (
                <UnsupportedPreview mimeType={decryptedMime} onDownload={handleDownload} />
              )}
            </div>
          )}
        </div>

        {/* Version history sidebar (desktop) */}
        {fileDetail?.versions && fileDetail.versions.length > 1 && (
          <aside className="hidden md:flex flex-col w-72 border-l border-[#1F1F23] bg-[#0A0A0B] overflow-y-auto shrink-0">
            <div className="px-4 py-4 border-b border-[#1F1F23]">
              <h2 className="text-sm font-semibold text-[#FAFAFA] flex items-center gap-2">
                <HistoryIcon />
                Version History
              </h2>
            </div>
            <div className="p-4">
              <VersionList
                versions={fileDetail.versions}
                currentVersion={fileDetail.versionNumber}
              />
            </div>
          </aside>
        )}
      </main>

      {/* ---- Share modal ---- */}
      {fileDetail && (
        <ShareModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          fileId={fileId!}
          fileName={decryptedFilename || 'File'}
        />
      )}

      {/* ---- Version history bottom sheet (mobile) ---- */}
      {versionsOpen && fileDetail?.versions && (
        <Modal
          open={versionsOpen}
          onClose={() => setVersionsOpen(false)}
          title="Version History"
          size="sm"
        >
          <VersionList
            versions={fileDetail.versions}
            currentVersion={fileDetail.versionNumber}
          />
        </Modal>
      )}

      {/* ---- Delete confirmation modal ---- */}
      <Modal
        open={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        title="Delete File"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-[#71717A]">
            Are you sure you want to permanently delete{' '}
            <span className="font-medium text-[#FAFAFA]">
              {decryptedFilename || 'this file'}
            </span>?
            This action cannot be undone.
          </p>
          <div className="flex gap-3">
            <Button
              variant="outline"
              fullWidth
              onClick={() => setDeleteConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              fullWidth
              onClick={() => { setDeleteConfirmOpen(false); handleDelete(); }}
            >
              <TrashIcon />
              Delete
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
