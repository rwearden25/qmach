import React, { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { VaultFile, VaultFolder } from '../../stores/vaultStore';
import { FileTypeIcon } from './FileGrid';

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

/* ------------------------------------------------------------------ */
/* Sort types                                                           */
/* ------------------------------------------------------------------ */

export type SortKey = 'name' | 'size' | 'modified';
export type SortDir = 'asc' | 'desc';

/* ------------------------------------------------------------------ */
/* Icons                                                                */
/* ------------------------------------------------------------------ */

function FolderRowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color: '#F59E0B' }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
    </svg>
  );
}

function SortArrowIcon({ direction }: { direction: SortDir }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="shrink-0">
      {direction === 'asc' ? (
        <path d="M6 10V2M3 5l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      ) : (
        <path d="M6 2v8M3 7l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      )}
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="5" r="1.5" fill="currentColor"/>
      <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
      <circle cx="12" cy="19" r="1.5" fill="currentColor"/>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Checkbox                                                             */
/* ------------------------------------------------------------------ */

interface CheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

function Checkbox({ checked, indeterminate = false, onChange, label }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <label className="relative flex items-center justify-center cursor-pointer w-5 h-5">
      <input
        ref={ref}
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <div
        aria-hidden="true"
        className={[
          'w-4 h-4 rounded border-2 flex items-center justify-center transition-colors duration-100',
          checked || indeterminate
            ? 'bg-[#00FF88] border-[#00FF88]'
            : 'bg-transparent border-[#1F1F23] hover:border-[#71717A]',
        ].join(' ')}
      >
        {checked && !indeterminate && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M2 5l2.5 2.5L8 3" stroke="#0A0A0B" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
        {indeterminate && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <line x1="2" y1="5" x2="8" y2="5" stroke="#0A0A0B" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        )}
      </div>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Sort header cell                                                     */
/* ------------------------------------------------------------------ */

interface SortHeaderProps {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}

function SortHeader({ label, sortKey, currentKey, currentDir, onSort, className = '' }: SortHeaderProps) {
  const active = currentKey === sortKey;
  return (
    <th
      scope="col"
      className={['text-left', className].join(' ')}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={[
          'inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide',
          'transition-colors duration-100 rounded px-1 py-0.5',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
          active ? 'text-[#FAFAFA]' : 'text-[#71717A] hover:text-[#FAFAFA]',
        ].join(' ')}
        aria-sort={active ? (currentDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        {active && <SortArrowIcon direction={currentDir} />}
      </button>
    </th>
  );
}

/* ------------------------------------------------------------------ */
/* Skeleton row                                                         */
/* ------------------------------------------------------------------ */

function SkeletonRow() {
  return (
    <tr aria-hidden="true" className="border-b border-[#1F1F23]">
      <td className="px-4 py-3 w-10">
        <div className="w-4 h-4 rounded bg-[#1F1F23] animate-pulse" />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-input bg-[#1F1F23] shrink-0 animate-pulse" />
          <div className="h-3.5 w-3/5 rounded-full bg-[#1F1F23] animate-pulse" />
        </div>
      </td>
      <td className="hidden tablet:table-cell px-4 py-3">
        <div className="h-3 w-16 rounded-full bg-[#1F1F23] animate-pulse" />
      </td>
      <td className="hidden tablet:table-cell px-4 py-3">
        <div className="h-3 w-24 rounded-full bg-[#1F1F23] animate-pulse" />
      </td>
      <td className="px-4 py-3 w-12" />
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/* Props                                                                */
/* ------------------------------------------------------------------ */

export interface FileListProps {
  files: VaultFile[];
  folders: VaultFolder[];
  selectedIds: Set<string>;
  onSelect: (id: string, shiftKey: boolean) => void;
  onSelectAll: (select: boolean) => void;
  onContextMenu: (e: React.MouseEvent | React.TouchEvent, id: string) => void;
  onFolderOpen: (folderId: string) => void;
  isLoading?: boolean;
}

/* ------------------------------------------------------------------ */
/* FileList component                                                   */
/* ------------------------------------------------------------------ */

export function FileList({
  files,
  folders,
  selectedIds,
  onSelect,
  onSelectAll,
  onContextMenu,
  onFolderOpen,
  isLoading = false,
}: FileListProps) {
  const navigate = useNavigate();
  const [sortKey, setSortKey] = useState<SortKey>('modified');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return key;
      }
      setSortDir('asc');
      return key;
    });
  }, []);

  /* ---- Sort items ---- */
  const sortedFolders = [...folders].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
    else if (sortKey === 'modified') cmp = a.createdAt.localeCompare(b.createdAt);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const sortedFiles = [...files].sort((a, b) => {
    let cmp = 0;
    if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
    else if (sortKey === 'size') cmp = a.size - b.size;
    else if (sortKey === 'modified') cmp = a.updatedAt.localeCompare(b.updatedAt);
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const totalItems = files.length + folders.length;
  const allSelected = totalItems > 0 && selectedIds.size === totalItems;
  const someSelected = selectedIds.size > 0 && selectedIds.size < totalItems;

  if (isLoading) {
    return (
      <div className="w-full overflow-x-auto rounded-card border border-[#1F1F23]">
        <table className="w-full" role="status" aria-label="Loading files">
          <thead>
            <tr className="border-b border-[#1F1F23] bg-[#0F0F11]">
              <th scope="col" className="px-4 py-3 w-10" />
              <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-[#71717A] uppercase tracking-wide">Name</th>
              <th scope="col" className="hidden tablet:table-cell px-4 py-3 text-left text-xs font-medium text-[#71717A] uppercase tracking-wide">Size</th>
              <th scope="col" className="hidden tablet:table-cell px-4 py-3 text-left text-xs font-medium text-[#71717A] uppercase tracking-wide">Modified</th>
              <th scope="col" className="px-4 py-3 w-12" />
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)}
          </tbody>
        </table>
        <span className="sr-only">Loading files…</span>
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto rounded-card border border-[#1F1F23]">
      <table className="w-full" role="grid" aria-label="Vault files">
        <thead>
          <tr className="border-b border-[#1F1F23] bg-[#0F0F11]">
            {/* Select-all checkbox */}
            <th scope="col" className="px-4 py-3 w-10">
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                onChange={(checked) => onSelectAll(checked)}
                label={allSelected ? 'Deselect all files' : 'Select all files'}
              />
            </th>
            <SortHeader
              label="Name"
              sortKey="name"
              currentKey={sortKey}
              currentDir={sortDir}
              onSort={handleSort}
              className="px-4 py-3"
            />
            <SortHeader
              label="Size"
              sortKey="size"
              currentKey={sortKey}
              currentDir={sortDir}
              onSort={handleSort}
              className="hidden tablet:table-cell px-4 py-3"
            />
            <SortHeader
              label="Modified"
              sortKey="modified"
              currentKey={sortKey}
              currentDir={sortDir}
              onSort={handleSort}
              className="hidden tablet:table-cell px-4 py-3"
            />
            <th scope="col" className="px-4 py-3 w-12">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>

        <tbody>
          {/* Folder rows */}
          {sortedFolders.map((folder) => {
            const id = `folder-${folder.id}`;
            const selected = selectedIds.has(id);
            const longPressTimer = { current: null as ReturnType<typeof setTimeout> | null };

            return (
              <tr
                key={id}
                role="row"
                aria-selected={selected}
                className={[
                  'border-b border-[#1F1F23] transition-colors duration-100 cursor-pointer select-none',
                  selected ? 'bg-[#F59E0B]/8' : 'hover:bg-white/[0.02]',
                ].join(' ')}
                onContextMenu={(e) => onContextMenu(e, id)}
              >
                <td className="px-4 py-3 w-10">
                  <Checkbox
                    checked={selected}
                    onChange={() => onSelect(id, false)}
                    label={`Select folder ${folder.name}`}
                  />
                </td>
                <td
                  className="px-4 py-3"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('input')) return;
                    if (e.detail === 2) onFolderOpen(folder.id);
                    else onSelect(id, e.shiftKey);
                  }}
                  onDoubleClick={() => onFolderOpen(folder.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onFolderOpen(folder.id);
                  }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FolderRowIcon />
                    <span className="text-sm text-[#FAFAFA] truncate font-medium">{folder.name}</span>
                    <span className="ml-auto text-xs text-[#71717A] shrink-0 tablet:hidden">{formatDate(folder.createdAt)}</span>
                  </div>
                </td>
                <td className="hidden tablet:table-cell px-4 py-3 text-sm text-[#71717A]">
                  —
                </td>
                <td
                  className="hidden tablet:table-cell px-4 py-3 text-sm text-[#71717A]"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('input')) return;
                    onSelect(id, e.shiftKey);
                  }}
                >
                  {formatDate(folder.createdAt)}
                </td>
                <td className="px-4 py-3 w-12">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onContextMenu(e, id); }}
                    className={[
                      'flex items-center justify-center w-8 h-8 rounded-full',
                      'text-[#71717A] hover:text-[#FAFAFA] hover:bg-white/5',
                      'transition-colors duration-100',
                      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
                      'min-w-[44px] min-h-[44px]',
                    ].join(' ')}
                    aria-label={`Actions for ${folder.name}`}
                  >
                    <MoreIcon />
                  </button>
                </td>
              </tr>
            );
          })}

          {/* File rows */}
          {sortedFiles.map((file) => {
            const id = `file-${file.id}`;
            const selected = selectedIds.has(id);

            return (
              <tr
                key={id}
                role="row"
                aria-selected={selected}
                className={[
                  'border-b border-[#1F1F23] transition-colors duration-100 cursor-pointer select-none last:border-b-0',
                  selected ? 'bg-[#00FF88]/8' : 'hover:bg-white/[0.02]',
                ].join(' ')}
                onContextMenu={(e) => onContextMenu(e, id)}
              >
                <td className="px-4 py-3 w-10">
                  <Checkbox
                    checked={selected}
                    onChange={() => onSelect(id, false)}
                    label={`Select file ${file.name}`}
                  />
                </td>
                <td
                  className="px-4 py-3"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('input')) return;
                    if (e.detail === 2) navigate(`/vault/${file.id}`);
                    else onSelect(id, e.shiftKey);
                  }}
                  onDoubleClick={() => navigate(`/vault/${file.id}`)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FileTypeIcon mimeType={file.mimeType} size={20} />
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm text-[#FAFAFA] truncate font-medium">{file.name}</span>
                      <span className="text-xs text-[#71717A] tablet:hidden">{formatBytes(file.size)}</span>
                    </div>
                  </div>
                </td>
                <td className="hidden tablet:table-cell px-4 py-3 text-sm text-[#71717A]">
                  {formatBytes(file.size)}
                </td>
                <td
                  className="hidden tablet:table-cell px-4 py-3 text-sm text-[#71717A]"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('input')) return;
                    onSelect(id, e.shiftKey);
                  }}
                >
                  {formatDate(file.updatedAt)}
                </td>
                <td className="px-4 py-3 w-12">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onContextMenu(e, id); }}
                    className={[
                      'flex items-center justify-center rounded-full',
                      'text-[#71717A] hover:text-[#FAFAFA] hover:bg-white/5',
                      'transition-colors duration-100',
                      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
                      'min-w-[44px] min-h-[44px]',
                    ].join(' ')}
                    aria-label={`Actions for ${file.name}`}
                  >
                    <MoreIcon />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default FileList;
