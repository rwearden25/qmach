import { create } from 'zustand';
import { apiClient } from '../lib/api';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type ViewMode = 'grid' | 'list';

export interface VaultFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;               // bytes
  folderId: string | null;
  encryptedKey: string;       // client-side encrypted symmetric key
  iv: string;                 // base64 initialisation vector
  thumbnailUrl?: string;
  createdAt: string;          // ISO-8601
  updatedAt: string;
}

export interface VaultFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

export interface UploadQueueItem {
  /** Temporary client-side identifier */
  clientId: string;
  file: File;
  folderId: string | null;
  /** Upload progress 0–100 */
  progress: number;
  status: 'pending' | 'uploading' | 'done' | 'error';
  errorMessage?: string;
}

/* ------------------------------------------------------------------ */
/* API response shapes                                                  */
/* ------------------------------------------------------------------ */

interface FilesResponse {
  files: VaultFile[];
}

interface FoldersResponse {
  folders: VaultFolder[];
}

interface UploadResponse {
  file: VaultFile;
}

interface CreateFolderResponse {
  folder: VaultFolder;
}

interface StorageResponse {
  used: number;
  limit: number;
}

/* ------------------------------------------------------------------ */
/* Store shape                                                          */
/* ------------------------------------------------------------------ */

export interface VaultState {
  /* ---- state ---- */
  files: VaultFile[];
  folders: VaultFolder[];
  /** ID of the folder currently being browsed (null = root) */
  currentFolder: string | null;
  viewMode: ViewMode;
  uploadQueue: UploadQueueItem[];
  storageUsed: number;
  storageLimit: number;
  searchQuery: string;
  /** Whether a data-fetch is in progress */
  isLoading: boolean;
  /** Last fetch/mutation error message */
  error: string | null;

  /* ---- actions ---- */
  fetchFiles(folderId?: string | null): Promise<void>;
  fetchFolders(): Promise<void>;
  fetchStorage(): Promise<void>;
  uploadFile(file: File, folderId?: string | null): Promise<void>;
  deleteFile(fileId: string): Promise<void>;
  createFolder(name: string, parentId?: string | null): Promise<void>;
  setViewMode(mode: ViewMode): void;
  setSearchQuery(query: string): void;
  setCurrentFolder(folderId: string | null): void;
  clearError(): void;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** Generates a simple unique ID for queue tracking (not cryptographically secure) */
function generateClientId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/* ------------------------------------------------------------------ */
/* Store implementation                                                 */
/* ------------------------------------------------------------------ */

export const useVaultStore = create<VaultState>()((set, get) => ({
  /* ----- initial state ----- */
  files: [],
  folders: [],
  currentFolder: null,
  viewMode: 'grid',
  uploadQueue: [],
  storageUsed: 0,
  storageLimit: 0,
  searchQuery: '',
  isLoading: false,
  error: null,

  /* ----- actions ----- */

  async fetchFiles(folderId?: string | null): Promise<void> {
    const resolvedFolder =
      folderId !== undefined ? folderId : get().currentFolder;

    set({ isLoading: true, error: null });

    try {
      const params = new URLSearchParams();
      if (resolvedFolder) {
        params.set('folderId', resolvedFolder);
      }

      const qs = params.toString();
      const data = await apiClient.get<FilesResponse>(
        `/vault/files${qs ? `?${qs}` : ''}`,
      );

      set({ files: data.files, isLoading: false });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch files',
      });
    }
  },

  async fetchFolders(): Promise<void> {
    set({ isLoading: true, error: null });

    try {
      const data = await apiClient.get<FoldersResponse>('/vault/folders');
      set({ folders: data.folders, isLoading: false });
    } catch (err) {
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch folders',
      });
    }
  },

  async fetchStorage(): Promise<void> {
    try {
      const data = await apiClient.get<StorageResponse>('/vault/storage');
      set({ storageUsed: data.used, storageLimit: data.limit });
    } catch {
      // Non-critical — silently ignore
    }
  },

  async uploadFile(file: File, folderId?: string | null): Promise<void> {
    const resolvedFolder =
      folderId !== undefined ? folderId : get().currentFolder;

    const clientId = generateClientId();

    const queueItem: UploadQueueItem = {
      clientId,
      file,
      folderId: resolvedFolder,
      progress: 0,
      status: 'pending',
    };

    // Add to queue immediately so the UI can show progress
    set((state) => ({ uploadQueue: [...state.uploadQueue, queueItem] }));

    // Update status to 'uploading'
    const updateItem = (patch: Partial<UploadQueueItem>) =>
      set((state) => ({
        uploadQueue: state.uploadQueue.map((item) =>
          item.clientId === clientId ? { ...item, ...patch } : item,
        ),
      }));

    updateItem({ status: 'uploading', progress: 10 });

    try {
      const formData = new FormData();
      formData.append('file', file);
      if (resolvedFolder) {
        formData.append('folderId', resolvedFolder);
      }

      updateItem({ progress: 40 });

      const data = await apiClient.upload<UploadResponse>(
        '/vault/files',
        formData,
      );

      updateItem({ status: 'done', progress: 100 });

      // Append the new file into local state (optimistic-style)
      set((state) => ({
        files: [...state.files, data.file],
        storageUsed: state.storageUsed + file.size,
      }));

      // Remove the completed item from the queue after a short delay
      setTimeout(() => {
        set((state) => ({
          uploadQueue: state.uploadQueue.filter(
            (item) => item.clientId !== clientId,
          ),
        }));
      }, 3000);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Upload failed';

      updateItem({ status: 'error', errorMessage, progress: 0 });

      set({ error: errorMessage });
    }
  },

  async deleteFile(fileId: string): Promise<void> {
    // Optimistic removal
    const previousFiles = get().files;
    const target = previousFiles.find((f) => f.id === fileId);

    set((state) => ({
      files: state.files.filter((f) => f.id !== fileId),
    }));

    try {
      await apiClient.del(`/vault/files/${fileId}`);

      // Update storage counter
      if (target) {
        set((state) => ({
          storageUsed: Math.max(0, state.storageUsed - target.size),
        }));
      }
    } catch (err) {
      // Roll back on failure
      set({
        files: previousFiles,
        error: err instanceof Error ? err.message : 'Failed to delete file',
      });
    }
  },

  async createFolder(
    name: string,
    parentId?: string | null,
  ): Promise<void> {
    const resolvedParent =
      parentId !== undefined ? parentId : get().currentFolder;

    try {
      const data = await apiClient.post<CreateFolderResponse>(
        '/vault/folders',
        { name, parentId: resolvedParent },
      );

      set((state) => ({
        folders: [...state.folders, data.folder],
      }));
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : 'Failed to create folder',
      });
    }
  },

  setViewMode(mode: ViewMode): void {
    set({ viewMode: mode });
  },

  setSearchQuery(query: string): void {
    set({ searchQuery: query });
  },

  setCurrentFolder(folderId: string | null): void {
    set({ currentFolder: folderId });
  },

  clearError(): void {
    set({ error: null });
  },
}));

/* ------------------------------------------------------------------ */
/* Derived / selector helpers (use in components)                       */
/* ------------------------------------------------------------------ */

/** Returns files filtered by the current search query */
export function selectFilteredFiles(state: VaultState): VaultFile[] {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return state.files;
  return state.files.filter((f) => f.name.toLowerCase().includes(q));
}

/** Returns child folders of the current folder */
export function selectCurrentFolders(state: VaultState): VaultFolder[] {
  return state.folders.filter((f) => f.parentId === state.currentFolder);
}

/** Percentage of storage used (0–100) */
export function selectStoragePercent(state: VaultState): number {
  if (state.storageLimit === 0) return 0;
  return Math.min(100, Math.round((state.storageUsed / state.storageLimit) * 100));
}
