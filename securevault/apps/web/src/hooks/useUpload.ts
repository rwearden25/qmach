/**
 * useUpload – React hook for queued, encrypted file uploads.
 *
 * Each queued item passes through two phases:
 *  1. Encryption  (0 → 50 % progress)
 *  2. XHR upload  (50 → 100 % progress, driven by upload progress events)
 *
 * The hook depends on useEncryption for the encrypt pipeline and calls the
 * files/upload endpoint directly via fetch + XMLHttpRequest so that per-file
 * upload progress can be tracked.
 */

import { useState, useRef, useCallback } from 'react';
import { useEncryption, type PreparedUpload } from './useEncryption';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type UploadStatus = 'pending' | 'encrypting' | 'uploading' | 'done' | 'error' | 'cancelled';

export interface UploadQueueItem {
  /** Stable client-side identifier for this item. */
  id: string;
  /** Original File object selected by the user. */
  file: File;
  /** Upload progress 0–100. */
  progress: number;
  /** Current lifecycle phase. */
  status: UploadStatus;
  /** Set when status === 'error'. */
  error: string | null;
  /** Optional target folder. */
  folderId: string | null;
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                     */
/* ------------------------------------------------------------------ */

const BASE_URL: string =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL) ||
  '/api';

/** Generate a lightweight stable ID for queue items. */
function makeId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Return the Bearer token stored by the auth store, if present. */
function getAccessToken(): string | null {
  try {
    const raw = sessionStorage.getItem('sv-auth');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: { accessToken?: string | null };
    };
    return parsed.state?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Upload a PreparedUpload payload to POST /files/upload using XHR so we
 * can report per-file progress.  Calls onProgress with values 0–100.
 * Rejects with an Error on HTTP or network failure.
 * Can be cancelled by calling abort() on the returned AbortController.
 */
function uploadWithProgress(
  prepared: PreparedUpload,
  folderId: string | null,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('encryptedBlob', prepared.encryptedBlob, 'encrypted');
    formData.append('encryptedName', prepared.encryptedName);
    formData.append('encryptedMimeType', prepared.encryptedMimeType);
    formData.append('encryptedSize', prepared.encryptedSize);
    formData.append('wrappedFileKey', prepared.wrappedFileKey);
    formData.append('plaintextHash', prepared.plaintextHash);
    formData.append('ciphertextHash', prepared.ciphertextHash);
    // ivs is stored inside encryptedBlob meta, but the API also needs it
    // as a field so it can be persisted alongside the file record.
    formData.append('ivs', prepared.ivs);
    if (folderId) {
      formData.append('folderId', folderId);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}/files/upload`);

    const token = getAccessToken();
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }
    xhr.setRequestHeader('Accept', 'application/json');

    xhr.upload.addEventListener('progress', (evt) => {
      if (evt.lengthComputable) {
        // Map XHR upload progress to the 50–100 range
        const pct = Math.round(50 + (evt.loaded / evt.total) * 50);
        onProgress(pct);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        let message = `Upload failed (HTTP ${xhr.status})`;
        try {
          const json = JSON.parse(xhr.responseText) as { error?: string };
          if (json.error) message = json.error;
        } catch {
          // ignore parse failure
        }
        reject(new Error(message));
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload cancelled'));
    });

    // Wire the AbortSignal to XHR
    signal.addEventListener('abort', () => {
      xhr.abort();
    });

    xhr.send(formData);
  });
}

/* ------------------------------------------------------------------ */
/* Hook                                                                 */
/* ------------------------------------------------------------------ */

export function useUpload() {
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const { encryptAndPrepareUpload } = useEncryption();

  // Map from item id → AbortController, so individual uploads can be cancelled
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  /* ---- Internal state helpers ---- */

  const patchItem = useCallback(
    (id: string, patch: Partial<UploadQueueItem>) => {
      setQueue((prev: UploadQueueItem[]) =>
        prev.map((item: UploadQueueItem) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      );
    },
    [],
  );

  /* ---- addFiles ---- */

  /**
   * Append one or more files to the upload queue with status 'pending'.
   * Accepts a FileList (from an input element) or a plain array of Files.
   */
  const addFiles = useCallback(
    (files: FileList | File[], folderId: string | null = null): void => {
      const items: UploadQueueItem[] = Array.from(files).map((file) => ({
        id: makeId(),
        file,
        progress: 0,
        status: 'pending' as const,
        error: null,
        folderId,
      }));

      setQueue((prev: UploadQueueItem[]) => [...prev, ...items]);
    },
    [],
  );

  /* ---- processItem ---- */

  /** Process a single queue item: encrypt then upload. */
  const processItem = useCallback(
    async (item: UploadQueueItem): Promise<void> => {
      const { id, file, folderId } = item;
      const controller = new AbortController();
      abortControllers.current.set(id, controller);

      try {
        // ── Phase 1: Encryption (0 → 50 %) ──────────────────────────────────
        patchItem(id, { status: 'encrypting', progress: 5 });

        let prepared: PreparedUpload;
        try {
          prepared = await encryptAndPrepareUpload(file);
        } catch (err) {
          patchItem(id, {
            status: 'error',
            error: err instanceof Error ? err.message : 'Encryption failed',
            progress: 0,
          });
          return;
        }

        if (controller.signal.aborted) return;

        patchItem(id, { progress: 50 });

        // ── Phase 2: Upload (50 → 100 %) ────────────────────────────────────
        patchItem(id, { status: 'uploading' });

        await uploadWithProgress(
          prepared,
          folderId,
          (pct) => patchItem(id, { progress: pct }),
          controller.signal,
        );

        patchItem(id, { status: 'done', progress: 100 });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        const isCancelled = message === 'Upload cancelled';
        patchItem(id, {
          status: isCancelled ? 'cancelled' : 'error',
          error: isCancelled ? null : message,
          progress: 0,
        });
      } finally {
        abortControllers.current.delete(id);
      }
    },
    [encryptAndPrepareUpload, patchItem],
  );

  /* ---- startUpload ---- */

  /**
   * Process all pending items in the queue, one by one.
   * Already-started or finished items are skipped.
   */
  const startUpload = useCallback(async (): Promise<void> => {
    setIsUploading(true);

    try {
      // Snapshot the queue to get the pending items we need to process
      const pending = queue.filter((item: UploadQueueItem) => item.status === 'pending');

      for (const item of pending) {
        // Re-check status in case it changed since we snapshotted
        await processItem(item);
      }
    } finally {
      setIsUploading(false);
    }
  }, [queue, processItem]);

  /* ---- cancelUpload ---- */

  /**
   * Cancel a specific upload by its queue index.
   * If the item is already uploading, the XHR is aborted.
   * If pending, it is simply marked cancelled.
   */
  const cancelUpload = useCallback(
    (index: number): void => {
      const item = queue[index];
      if (!item) return;

      const { id, status } = item;

      if (status === 'uploading' || status === 'encrypting') {
        const controller = abortControllers.current.get(id);
        if (controller) {
          controller.abort();
        }
      }

      patchItem(id, { status: 'cancelled', progress: 0, error: null });
    },
    [queue, patchItem],
  );

  /* ---- clearCompleted ---- */

  /** Remove all items with a terminal status from the queue. */
  const clearCompleted = useCallback((): void => {
    setQueue((prev: UploadQueueItem[]) =>
      prev.filter(
        (item: UploadQueueItem) =>
          item.status !== 'done' &&
          item.status !== 'error' &&
          item.status !== 'cancelled',
      ),
    );
  }, []);

  /* ---- retryFailed ---- */

  /** Reset a failed item back to 'pending' so it can be re-queued. */
  const retryFailed = useCallback(
    (index: number): void => {
      const item = queue[index];
      if (!item || item.status !== 'error') return;
      patchItem(item.id, { status: 'pending', progress: 0, error: null });
    },
    [queue, patchItem],
  );

  return {
    /** Current upload queue. */
    uploadQueue: queue,
    /** True while startUpload() is processing items. */
    isUploading,
    /** Add files to the queue (does not start uploading automatically). */
    addFiles,
    /** Begin processing all pending items in the queue. */
    startUpload,
    /** Cancel a specific item by its index in the queue. */
    cancelUpload,
    /** Remove all done / error / cancelled items from the queue. */
    clearCompleted,
    /** Reset a failed item to pending so it will be retried on next startUpload(). */
    retryFailed,
  };
}
