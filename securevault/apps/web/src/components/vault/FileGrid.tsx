import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { VaultFile, VaultFolder } from '../../stores/vaultStore';

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
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getMimeCategory(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (
    mimeType.startsWith('text/') ||
    mimeType.includes('javascript') ||
    mimeType.includes('json') ||
    mimeType.includes('xml')
  ) return 'text';
  if (
    mimeType.includes('zip') ||
    mimeType.includes('tar') ||
    mimeType.includes('gzip') ||
    mimeType.includes('rar')
  ) return 'archive';
  if (
    mimeType.includes('spreadsheet') ||
    mimeType.includes('excel') ||
    mimeType.includes('csv')
  ) return 'spreadsheet';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'presentation';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'document';
  return 'other';
}

/* ------------------------------------------------------------------ */
/* File type icons                                                      */
/* ------------------------------------------------------------------ */

interface FileIconProps {
  mimeType: string;
  size?: number;
}

function FileTypeIcon({ mimeType, size = 36 }: FileIconProps) {
  const category = getMimeCategory(mimeType);

  const configs: Record<string, { color: string; path: React.ReactNode }> = {
    image: {
      color: '#6366F1',
      path: (
        <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </g>
      ),
    },
    video: {
      color: '#EC4899',
      path: (
        <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="23 7 16 12 23 17 23 7"/>
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
        </g>
      ),
    },
    audio: {
      color: '#F59E0B',
      path: (
        <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </g>
      ),
    },
    pdf: {
      color: '#EF4444',
      path: (
        <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </g>
      ),
    },
    text: {
      color: '#00FF88',
      path: (
        <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <line x1="10" y1="9" x2="8" y2="9"/>
        </g>
      ),
    },
    archive: {
      color: '#F59E0B',
      path: (
        <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="21 8 21 21 3 21 3 8"/>
          <rect x="1" y="3" width="22" height="5"/>
          <line x1="10" y1="12" x2="14" y2="12"/>
        </g>
      ),
    },
    spreadsheet: {
      color: '#10B981',
      path: (
        <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="8" y1="13" x2="16" y2="13"/>
          <line x1="8" y1="17" x2="16" y2="17"/>
          <line x1="12" y1="11" x2="12" y2="19"/>
        </g>
      ),
    },
    presentation: {
      color: '#F97316',
      path: (
        <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </g>
      ),
    },
    document: {
      color: '#3B82F6',
      path: (
        <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <line x1="10" y1="9" x2="8" y2="9"/>
        </g>
      ),
    },
    other: {
      color: '#71717A',
      path: (
        <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
          <polyline points="13 2 13 9 20 9"/>
        </g>
      ),
    },
  };

  const { color, path } = configs[category] ?? configs.other;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ color }}
      className="shrink-0"
    >
      {path}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Folder icon                                                          */
/* ------------------------------------------------------------------ */

function FolderIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ color: '#F59E0B' }}>
      <g stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Selection indicator                                                  */
/* ------------------------------------------------------------------ */

function SelectionCheck({ selected }: { selected: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={[
        'absolute top-2 left-2 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all duration-150 z-10',
        selected
          ? 'bg-[#00FF88] border-[#00FF88]'
          : 'bg-[#0A0A0B]/60 border-[#1F1F23] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
      ].join(' ')}
    >
      {selected && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 5l2.5 2.5L8 3" stroke="#0A0A0B" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Props                                                                */
/* ------------------------------------------------------------------ */

export interface FileGridProps {
  files: VaultFile[];
  folders: VaultFolder[];
  selectedIds: Set<string>;
  onSelect: (id: string, shiftKey: boolean) => void;
  onContextMenu: (e: React.MouseEvent | React.TouchEvent, id: string) => void;
  onFolderOpen: (folderId: string) => void;
  isLoading?: boolean;
}

/* ------------------------------------------------------------------ */
/* Skeleton card for loading state                                      */
/* ------------------------------------------------------------------ */

function SkeletonFileCard() {
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-3 p-4 rounded-card border border-[#1F1F23] bg-[#141416] animate-pulse"
    >
      <div className="w-9 h-9 rounded-input bg-[#1F1F23]" />
      <div className="h-3.5 w-3/4 rounded-full bg-[#1F1F23]" />
      <div className="flex gap-2">
        <div className="h-3 w-16 rounded-full bg-[#1F1F23]" />
        <div className="h-3 w-12 rounded-full bg-[#1F1F23]" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Folder card                                                          */
/* ------------------------------------------------------------------ */

interface FolderCardProps {
  folder: VaultFolder;
  selected: boolean;
  onSelect: (shiftKey: boolean) => void;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent | React.TouchEvent) => void;
}

function FolderCard({ folder, selected, onSelect, onOpen, onContextMenu }: FolderCardProps) {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchMoved = useRef(false);

  const handleTouchStart = () => {
    touchMoved.current = false;
    longPressTimer.current = setTimeout(() => {
      if (!touchMoved.current) {
        // Simulate context menu via synthetic event not possible, use state-based
        onSelect(false);
      }
    }, 600);
  };

  const handleTouchMove = () => {
    touchMoved.current = true;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  return (
    <article
      className={[
        'group relative flex flex-col gap-2 p-4 rounded-card border cursor-pointer',
        'transition-all duration-150 select-none',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88] focus-visible:outline-offset-2',
        selected
          ? 'bg-[#F59E0B]/10 border-[#F59E0B]/50'
          : 'bg-[#141416] border-[#1F1F23] hover:border-[#2A2A30] hover:bg-[#1A1A1E]',
      ].join(' ')}
      tabIndex={0}
      role="button"
      aria-label={`Folder: ${folder.name}`}
      aria-pressed={selected}
      onClick={(e) => {
        if (e.detail === 2) {
          onOpen();
        } else {
          onSelect(e.shiftKey);
        }
      }}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
        if (e.key === ' ') { e.preventDefault(); onSelect(e.shiftKey); }
      }}
    >
      <SelectionCheck selected={selected} />
      <FolderIcon size={36} />
      <p className="text-sm font-medium text-[#FAFAFA] truncate leading-snug">{folder.name}</p>
      <p className="text-xs text-[#71717A]">{formatDate(folder.createdAt)}</p>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* File card                                                            */
/* ------------------------------------------------------------------ */

interface FileCardProps {
  file: VaultFile;
  selected: boolean;
  onSelect: (shiftKey: boolean) => void;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent | React.TouchEvent) => void;
}

function FileCard({ file, selected, onSelect, onOpen, onContextMenu }: FileCardProps) {
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchMoved = useRef(false);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchMoved.current = false;
    longPressTimer.current = setTimeout(() => {
      if (!touchMoved.current) {
        onContextMenu(e);
      }
    }, 600);
  };

  const handleTouchMove = () => {
    touchMoved.current = true;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  const handleTouchEnd = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  };

  return (
    <article
      className={[
        'group relative flex flex-col gap-2 p-4 rounded-card border cursor-pointer',
        'transition-all duration-150 select-none',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88] focus-visible:outline-offset-2',
        selected
          ? 'bg-[#00FF88]/10 border-[#00FF88]/50'
          : 'bg-[#141416] border-[#1F1F23] hover:border-[#2A2A30] hover:bg-[#1A1A1E]',
      ].join(' ')}
      tabIndex={0}
      role="button"
      aria-label={`File: ${file.name}, ${formatBytes(file.size)}`}
      aria-pressed={selected}
      onClick={(e) => {
        if (e.detail === 1) onSelect(e.shiftKey);
      }}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
        if (e.key === ' ') { e.preventDefault(); onSelect(e.shiftKey); }
      }}
    >
      <SelectionCheck selected={selected} />

      {/* Thumbnail or icon */}
      <div className="flex items-start">
        {file.thumbnailUrl ? (
          <img
            src={file.thumbnailUrl}
            alt=""
            aria-hidden="true"
            className="w-full h-28 object-cover rounded-input bg-[#1F1F23]"
            loading="lazy"
          />
        ) : (
          <FileTypeIcon mimeType={file.mimeType} size={36} />
        )}
      </div>

      {/* Name */}
      <p className="text-sm font-medium text-[#FAFAFA] truncate leading-snug" title={file.name}>
        {file.name}
      </p>

      {/* Meta */}
      <div className="flex items-center gap-1.5 text-xs text-[#71717A]">
        <span>{formatBytes(file.size)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatDate(file.updatedAt)}</span>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* FileGrid component                                                   */
/* ------------------------------------------------------------------ */

export function FileGrid({
  files,
  folders,
  selectedIds,
  onSelect,
  onContextMenu,
  onFolderOpen,
  isLoading = false,
}: FileGridProps) {
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div
        role="status"
        aria-label="Loading files"
        className="grid grid-cols-1 tablet:grid-cols-2 desktop:grid-cols-3 tv:grid-cols-4 gap-4"
      >
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonFileCard key={i} />
        ))}
        <span className="sr-only">Loading files…</span>
      </div>
    );
  }

  const isEmpty = files.length === 0 && folders.length === 0;
  if (isEmpty) return null;

  return (
    <div
      className="grid grid-cols-1 tablet:grid-cols-2 desktop:grid-cols-3 tv:grid-cols-4 gap-4"
      role="list"
      aria-label="Vault files"
    >
      {folders.map((folder) => (
        <div key={`folder-${folder.id}`} role="listitem">
          <FolderCard
            folder={folder}
            selected={selectedIds.has(`folder-${folder.id}`)}
            onSelect={(shiftKey) => onSelect(`folder-${folder.id}`, shiftKey)}
            onOpen={() => onFolderOpen(folder.id)}
            onContextMenu={(e) => onContextMenu(e, `folder-${folder.id}`)}
          />
        </div>
      ))}
      {files.map((file) => (
        <div key={`file-${file.id}`} role="listitem">
          <FileCard
            file={file}
            selected={selectedIds.has(`file-${file.id}`)}
            onSelect={(shiftKey) => onSelect(`file-${file.id}`, shiftKey)}
            onOpen={() => navigate(`/vault/${file.id}`)}
            onContextMenu={(e) => onContextMenu(e, `file-${file.id}`)}
          />
        </div>
      ))}
    </div>
  );
}

export { FileTypeIcon };
export default FileGrid;
