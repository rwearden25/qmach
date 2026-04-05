import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileGrid } from '../components/vault/FileGrid';
import { FileList } from '../components/vault/FileList';
import { UploadZone } from '../components/vault/UploadZone';
import { UploadProgress } from '../components/vault/UploadProgress';
import { ContextMenu, DEFAULT_FILE_ACTIONS } from '../components/vault/ContextMenu';
import { ShareModal } from '../components/vault/ShareModal';
import { StorageBar } from '../components/vault/StorageBar';
import { Button } from '../components/shared/Button';
import { Input } from '../components/shared/Input';
import { Modal } from '../components/shared/Modal';
import { useToast } from '../components/shared/Toast';
import {
  useVaultStore,
  selectFilteredFiles,
  selectCurrentFolders,
} from '../stores/vaultStore';
import { useAuthStore } from '../stores/authStore';

/* ------------------------------------------------------------------ */
/* Inline SVG icons                                                     */
/* ------------------------------------------------------------------ */

function GridIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke={active ? '#00FF88' : 'currentColor'} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
    </svg>
  );
}

function ListIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke={active ? '#00FF88' : 'currentColor'} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
      <line x1="8" y1="18" x2="21" y2="18"/>
      <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/>
      <line x1="3" y1="18" x2="3.01" y2="18"/>
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  );
}

function FolderPlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="16 16 12 12 8 16"/>
      <line x1="12" y1="12" x2="12" y2="21"/>
      <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  );
}

function LogOutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="#00FF88" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

export default function VaultDashboard() {
  const navigate = useNavigate();
  const { success, error: toastError } = useToast();

  /* ---- Store ---- */
  const files = useVaultStore(selectFilteredFiles);
  const folders = useVaultStore(selectCurrentFolders);
  const {
    viewMode, currentFolder, folders: allFolders,
    storageUsed, storageLimit, isLoading, searchQuery,
    fetchFiles, fetchFolders, fetchStorage,
    setViewMode, setSearchQuery, setCurrentFolder,
    deleteFile, createFolder,
  } = useVaultStore();

  const { user, logout } = useAuthStore();

  /* ---- Local UI state ---- */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [shareTarget, setShareTarget] = useState<{ id: string; name: string } | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderLoading, setNewFolderLoading] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ---- Fetch on mount / folder change ---- */
  useEffect(() => {
    fetchFiles(currentFolder);
    fetchFolders();
    fetchStorage();
  }, [currentFolder, fetchFiles, fetchFolders, fetchStorage]);

  /* ---- Close user menu on outside click ---- */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  /* ---- Breadcrumb path ---- */
  const breadcrumbs = (() => {
    const crumbs: { id: string | null; name: string }[] = [{ id: null, name: 'My Vault' }];
    let folderId: string | null = currentFolder;
    while (folderId) {
      const f = allFolders.find((x) => x.id === folderId);
      if (!f) break;
      crumbs.splice(1, 0, { id: f.id, name: f.name });
      folderId = f.parentId;
    }
    return crumbs;
  })();

  /* ---- Selection ---- */
  const handleSelect = useCallback((id: string, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (shiftKey) {
        next.has(id) ? next.delete(id) : next.add(id);
      } else {
        if (next.size === 1 && next.has(id)) {
          next.clear();
        } else {
          next.clear();
          next.add(id);
        }
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback((select: boolean) => {
    if (select) {
      const ids = new Set<string>([
        ...files.map((f) => `file-${f.id}`),
        ...folders.map((f) => `folder-${f.id}`),
      ]);
      setSelectedIds(ids);
    } else {
      setSelectedIds(new Set());
    }
  }, [files, folders]);

  /* ---- Context menu ---- */
  const handleContextMenu = useCallback((e: React.MouseEvent | React.TouchEvent, id: string) => {
    e.preventDefault();
    const { clientX, clientY } = 'clientX' in e ? e : e.touches[0];
    setContextMenu({ x: clientX, y: clientY, id });
    if (!selectedIds.has(id)) {
      setSelectedIds(new Set([id]));
    }
  }, [selectedIds]);

  const handleContextAction = useCallback(async (actionId: string) => {
    if (!contextMenu) return;
    const { id } = contextMenu;
    const isFile = id.startsWith('file-');
    const rawId = id.replace(/^(file|folder)-/, '');

    if (actionId === 'share' && isFile) {
      const file = files.find((f) => f.id === rawId);
      if (file) setShareTarget({ id: rawId, name: file.name });
    } else if (actionId === 'download' && isFile) {
      // Navigate to preview page where full download is available
      navigate(`/vault/${rawId}`);
    } else if (actionId === 'delete' && isFile) {
      try {
        await deleteFile(rawId);
        success('File deleted');
        setSelectedIds((prev) => { const n = new Set(prev); n.delete(id); return n; });
      } catch {
        toastError('Failed to delete file');
      }
    } else if (actionId === 'versions' && isFile) {
      navigate(`/vault/${rawId}`);
    }
  }, [contextMenu, files, deleteFile, navigate, success, toastError]);

  /* ---- Create folder ---- */
  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setNewFolderLoading(true);
    try {
      await createFolder(name, currentFolder);
      success('Folder created');
      setNewFolderOpen(false);
      setNewFolderName('');
    } catch {
      toastError('Failed to create folder');
    } finally {
      setNewFolderLoading(false);
    }
  }, [newFolderName, currentFolder, createFolder, success, toastError]);

  /* ---- Logout ---- */
  const handleLogout = useCallback(async () => {
    await logout();
    navigate('/login');
  }, [logout, navigate]);

  const isEmpty = files.length === 0 && folders.length === 0 && !isLoading;

  return (
    <div className="min-h-dvh bg-[#0A0A0B] flex flex-col">

      {/* ---- Header ---- */}
      <header className="sticky top-0 z-30 bg-[#0A0A0B]/95 backdrop-blur-sm border-b border-[#1F1F23]">
        <div className="max-w-screen-2xl mx-auto px-4 tv:px-12 h-16 tv:h-20 flex items-center gap-3">

          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0 mr-2">
            <ShieldIcon />
            <span className="text-[#FAFAFA] font-heading font-bold text-lg tv:text-2xl hidden sm:block">
              SecureVault
            </span>
          </div>

          {/* Search */}
          <div className="flex-1 max-w-md">
            <Input
              type="search"
              placeholder="Search files…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              icon={<SearchIcon />}
            />
          </div>

          {/* View toggle */}
          <div className="hidden sm:flex items-center gap-1 p-1 bg-[#141416] rounded-input border border-[#1F1F23]">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={[
                'flex items-center justify-center w-9 h-9 rounded-[6px] transition-all duration-150',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
                viewMode === 'grid' ? 'bg-[#1F1F23] text-[#00FF88]' : 'text-[#71717A] hover:text-[#FAFAFA]',
              ].join(' ')}
              aria-label="Grid view"
              aria-pressed={viewMode === 'grid'}
            >
              <GridIcon active={viewMode === 'grid'} />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={[
                'flex items-center justify-center w-9 h-9 rounded-[6px] transition-all duration-150',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
                viewMode === 'list' ? 'bg-[#1F1F23] text-[#00FF88]' : 'text-[#71717A] hover:text-[#FAFAFA]',
              ].join(' ')}
              aria-label="List view"
              aria-pressed={viewMode === 'list'}
            >
              <ListIcon active={viewMode === 'list'} />
            </button>
          </div>

          {/* Storage bar */}
          <div className="hidden lg:block w-48 tv:w-64">
            <StorageBar used={storageUsed} limit={storageLimit} variant="compact" />
          </div>

          {/* User dropdown */}
          <div className="relative ml-auto" ref={userMenuRef}>
            <button
              type="button"
              onClick={() => setUserMenuOpen((v) => !v)}
              className={[
                'flex items-center gap-2 h-10 px-3 rounded-input',
                'text-sm text-[#FAFAFA] hover:bg-white/5',
                'transition-colors duration-150',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
              ].join(' ')}
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
              aria-label="User menu"
            >
              {/* Avatar initial */}
              <span className="w-7 h-7 rounded-full bg-[#00FF88]/20 border border-[#00FF88]/30 flex items-center justify-center text-xs font-bold text-[#00FF88] shrink-0">
                {user?.email?.[0]?.toUpperCase() ?? 'U'}
              </span>
              <span className="hidden md:block max-w-[140px] truncate text-sm text-[#FAFAFA]">
                {user?.email ?? 'Account'}
              </span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={`shrink-0 transition-transform duration-150 ${userMenuOpen ? 'rotate-180' : ''}`}
                aria-hidden="true">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            {/* Dropdown */}
            {userMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-2 w-52 bg-[#141416] border border-[#1F1F23] rounded-card shadow-[0_8px_32px_rgba(0,0,0,0.6)] py-1.5 z-40 animate-[contextMenuIn_120ms_ease-out]"
              >
                <div className="px-4 py-2.5 border-b border-[#1F1F23]">
                  <p className="text-xs text-[#71717A] truncate">{user?.email}</p>
                </div>
                <button
                  role="menuitem"
                  onClick={() => { setUserMenuOpen(false); navigate('/settings'); }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#FAFAFA] hover:bg-white/5 transition-colors min-h-[44px]"
                >
                  <span className="text-[#71717A]"><SettingsIcon /></span>
                  Settings
                </button>
                <button
                  role="menuitem"
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors min-h-[44px]"
                >
                  <span className="text-[#EF4444]"><LogOutIcon /></span>
                  Log out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ---- Sub-toolbar: breadcrumb + actions ---- */}
      <div className="border-b border-[#1F1F23] bg-[#0A0A0B]">
        <div className="max-w-screen-2xl mx-auto px-4 tv:px-12 py-3 flex items-center gap-3 flex-wrap">

          {/* Breadcrumb */}
          <nav aria-label="Folder navigation" className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
            {breadcrumbs.map((crumb, i) => (
              <React.Fragment key={crumb.id ?? 'root'}>
                {i > 0 && <ChevronIcon />}
                <button
                  type="button"
                  onClick={() => { setCurrentFolder(crumb.id); setSelectedIds(new Set()); }}
                  className={[
                    'text-sm px-1.5 py-1 rounded transition-colors duration-100 whitespace-nowrap',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88]',
                    i === breadcrumbs.length - 1
                      ? 'text-[#FAFAFA] font-medium cursor-default'
                      : 'text-[#71717A] hover:text-[#FAFAFA]',
                  ].join(' ')}
                  aria-current={i === breadcrumbs.length - 1 ? 'page' : undefined}
                  disabled={i === breadcrumbs.length - 1}
                >
                  {crumb.name}
                </button>
              </React.Fragment>
            ))}
          </nav>

          {/* Action buttons */}
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => setNewFolderOpen(true)}>
              <FolderPlusIcon />
              <span className="hidden sm:inline">New Folder</span>
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon />
              <span className="hidden sm:inline">Upload</span>
            </Button>
          </div>
        </div>

        {/* Selection toolbar */}
        {selectedIds.size > 0 && (
          <div className="max-w-screen-2xl mx-auto px-4 tv:px-12 py-2 flex items-center gap-3 bg-[#00FF88]/5 border-t border-[#00FF88]/20">
            <span className="text-sm text-[#00FF88] font-medium">
              {selectedIds.size} selected
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const fileIds = [...selectedIds]
                  .filter((id) => id.startsWith('file-'))
                  .map((id) => id.replace('file-', ''));
                await Promise.all(fileIds.map((id) => deleteFile(id)));
                setSelectedIds(new Set());
                success(`Deleted ${fileIds.length} file${fileIds.length > 1 ? 's' : ''}`);
              }}
              className="text-[#EF4444] hover:text-[#EF4444] hover:bg-[#EF4444]/10"
            >
              Delete selected
            </Button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-[#71717A] hover:text-[#FAFAFA] ml-auto transition-colors"
            >
              Clear
            </button>
          </div>
        )}
      </div>

      {/* ---- Main content ---- */}
      <main className="flex-1 max-w-screen-2xl mx-auto w-full px-4 tv:px-12 py-6 tv:py-10">

        {/* Empty state */}
        {isEmpty && (
          <div className="flex flex-col items-center justify-center py-24 gap-6 text-center">
            <div className="w-20 h-20 rounded-full bg-[#141416] border border-[#1F1F23] flex items-center justify-center">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none"
                stroke="#71717A" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-heading font-semibold text-[#FAFAFA] mb-2">
                {currentFolder ? 'This folder is empty' : 'Your vault is empty'}
              </h2>
              <p className="text-sm text-[#71717A] max-w-xs">
                Drag and drop files here, or click Upload to add your first file.
              </p>
            </div>
            <Button variant="primary" size="md" onClick={() => fileInputRef.current?.click()}>
              <UploadIcon />
              Upload Files
            </Button>
          </div>
        )}

        {/* File grid / list */}
        {!isEmpty && viewMode === 'grid' && (
          <FileGrid
            files={files}
            folders={folders}
            selectedIds={selectedIds}
            onSelect={handleSelect}
            onContextMenu={handleContextMenu}
            onFolderOpen={(id) => { setCurrentFolder(id); setSelectedIds(new Set()); }}
            isLoading={isLoading}
          />
        )}
        {!isEmpty && viewMode === 'list' && (
          <FileList
            files={files}
            folders={folders}
            selectedIds={selectedIds}
            onSelect={handleSelect}
            onSelectAll={handleSelectAll}
            onContextMenu={handleContextMenu}
            onFolderOpen={(id) => { setCurrentFolder(id); setSelectedIds(new Set()); }}
            isLoading={isLoading}
          />
        )}
      </main>

      {/* ---- Upload zone (full-page drag overlay + hidden input) ---- */}
      {/* The hidden file input is exposed via vault-file-input id for FAB */}
      <UploadZone />
      {/* Secondary hidden input wired to our ref for the header button */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            // Trigger the same vault upload via the label-linked input
            document.getElementById('vault-file-input')?.dispatchEvent(
              new MouseEvent('click')
            );
          }
          e.target.value = '';
        }}
      />

      {/* ---- Upload progress panel ---- */}
      <UploadProgress />

      {/* ---- Mobile FAB ---- */}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className={[
          'fixed bottom-6 right-6 z-20 sm:hidden',
          'w-14 h-14 rounded-full bg-[#00FF88] text-[#0A0A0B]',
          'flex items-center justify-center shadow-[0_4px_24px_rgba(0,255,136,0.4)]',
          'hover:opacity-90 active:scale-95 transition-all duration-150',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#00FF88] focus-visible:outline-offset-4',
        ].join(' ')}
        aria-label="Upload files"
      >
        <UploadIcon />
      </button>

      {/* ---- Context menu ---- */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onAction={handleContextAction}
          actions={
            contextMenu.id.startsWith('folder-')
              ? DEFAULT_FILE_ACTIONS.filter((a) => ['rename', 'move', 'delete'].includes(a.id))
              : DEFAULT_FILE_ACTIONS
          }
        />
      )}

      {/* ---- Share modal ---- */}
      {shareTarget && (
        <ShareModal
          open={Boolean(shareTarget)}
          onClose={() => setShareTarget(null)}
          fileId={shareTarget.id}
          fileName={shareTarget.name}
        />
      )}

      {/* ---- New folder modal ---- */}
      <Modal
        open={newFolderOpen}
        onClose={() => { setNewFolderOpen(false); setNewFolderName(''); }}
        title="New Folder"
        size="sm"
      >
        <div className="space-y-4">
          <Input
            label="Folder name"
            placeholder="e.g. Documents"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); }}
            autoFocus
          />
          <div className="flex gap-3">
            <Button
              variant="outline"
              fullWidth
              onClick={() => { setNewFolderOpen(false); setNewFolderName(''); }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              fullWidth
              loading={newFolderLoading}
              disabled={!newFolderName.trim()}
              onClick={handleCreateFolder}
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>

      <style>{`
        @keyframes contextMenuIn {
          from { opacity: 0; transform: scale(0.95) translateY(-4px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
}
